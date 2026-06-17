# WebSocket "Connected" indicator: heartbeat + auto-reconnect

**Date:** 2026-06-17
**Ticket:** RG-27867
**Branch:** RG-27867-websocket-disconnected

## Problem

The web UI's "Connected"/"Disconnected" indicator (upper-left) shows
**"Disconnected"** on first page load and only flips to **"Connected"** when the
first email arrives.

### Root cause (confirmed empirically)

The frontend (`static/js/controllers.js`) sets its `hasEventSource` flag (the
indicator) to `true` **only** on the WebSocket `open` event. The browser fires
`open` only after it receives the HTTP 101 handshake.

The websocket handler in `web.py` did `await queue.get()` *before* its first
`send()`. Quart defers the 101 handshake until the handler's first
`send()`/`accept()`, so on an idle (empty) broadcast queue **the 101 was never
sent**. The browser stayed in `CONNECTING`, `open` never fired → "Disconnected".
The first email's `send()` triggered the deferred handshake → `open` fired →
"Connected", simultaneously with the email appearing.

Reproduced with a raw-socket probe against a live server:

| Condition | Result |
|---|---|
| Buggy handler, idle | no 101 within 3s → browser "Disconnected" |
| Buggy handler, email at 500ms | 101 at 511ms → flips to "Connected" with the email |
| Fixed handler, idle | 101 in 2ms → "Connected" immediately |

The fix (commit `4893c15`, already on this branch) adds `await
websocket.accept()` at the top of the handler. It is verified: the regression
test fails without it / passes with it, full suite 69/69 green. **It is not yet
on `master`**, so any deployment built from master still has the bug.

### Secondary gap (the "heartbeat" intuition)

Even with the handshake fixed, there is no keepalive and no auto-reconnect:

- A dev mail sink sits idle for long stretches. Reverse proxies / load balancers
  reap idle WebSockets (commonly ~60s with no traffic).
- When the connection drops, the frontend fires `error`/`close`, sets
  `hasEventSource=false` → "Disconnected", and **never reconnects** (the vendored
  mailhog JS has no reconnect logic) until the page is reloaded. Live email
  delivery is also lost until reload.

## Scope

1. Land the existing handshake fix on `master`.
2. Add a server-side WebSocket **heartbeat** (protocol PING/PONG) to keep idle
   connections alive and detect dead peers.
3. Add frontend **auto-reconnect with capped backoff** so the indicator
   self-heals after any genuine drop (server restart, network blip, proxy
   bounce).

Out of scope: changing the indicator semantics, message format, or any other UI
behavior.

## Design decisions & constraints

- The application **cannot** send protocol PING frames: Quart's `Websocket`
  object exposes only `accept`/`send`/`receive`/`close` (ASGI does not surface
  ping to the app).
- Hypercorn **can**, via `Config.websocket_ping_interval`, but only when we run
  hypercorn directly. `Quart.run()` ignores extra kwargs (warns
  "not supported"), so the interval cannot be passed through it.
- The Dockerfile currently runs the Quart **dev** server in production
  (`app.run()`), which Quart itself warns against. Moving to hypercorn-direct is
  therefore also a production-readiness upgrade, not just a vehicle for the ping.
- Hypercorn's `serve()` (via `worker_serve`) installs SIGINT/SIGTERM/SIGBREAK
  handlers by default when `shutdown_trigger is None`, and a clean shutdown runs
  the ASGI lifespan shutdown → Quart `after_serving` → existing SMTP server
  cleanup. So `docker stop` (SIGTERM) keeps working with no extra code.
- Protocol PING/PONG is invisible to frontend JS (the browser auto-PONGs), so
  the heartbeat needs **no** frontend change and carries **zero** risk of a
  heartbeat frame being misread as a phantom email.

## Components

### 1. Handshake fix — `src/mailhedgehog/web.py` (already done)

`await websocket.accept()` at the top of the `ws()` handler. No further change;
it lands on `master` when this branch merges.

### 2. Backend heartbeat — `src/mailhedgehog/app.py`

Replace `app.run()` with hypercorn-direct serving, mirroring Quart's own
`run_task` config-building plus the ping interval.

```python
from hypercorn.config import Config as HyperConfig
from hypercorn.asyncio import serve

def build_hypercorn_config(config: Config) -> HyperConfig:
    hcfg = HyperConfig()
    hcfg.bind = [f"{config.http_host or '127.0.0.1'}:{config.http_port}"]
    hcfg.accesslog = "-"      # preserve request logs (incl. the 101 line)
    hcfg.errorlog = "-"
    hcfg.certfile = config.tls_cert
    hcfg.keyfile = config.tls_key
    # <= 0 disables the heartbeat (None == hypercorn "no ping")
    hcfg.websocket_ping_interval = (
        config.ws_ping_interval if config.ws_ping_interval > 0 else None
    )
    return hcfg

def main() -> None:
    config, app = build()
    app.debug = config.debug
    asyncio.run(serve(app, build_hypercorn_config(config)))
```

Notes:
- `bind` uses `127.0.0.1` when `http_host` is empty, matching Quart's default
  (the Dockerfile sets `MH_HTTP_HOST=0.0.0.0`, so containers bind externally).
- No explicit `shutdown_trigger` → signals + graceful lifespan handled by
  hypercorn.
- `before_serving`'s `asyncio.get_running_loop()` works unchanged under
  hypercorn's loop.

### 3. Config — `src/mailhedgehog/config.py`

Add a float knob (new `_float` helper mirroring `_int`):

```python
def _float(name: str, default: float) -> float:
    value = os.environ.get(name)
    if value is None or value == "":
        return default
    return float(value)
```

- New field: `ws_ping_interval: float = 20.0`.
- `from_env`: `ws_ping_interval=_float("MH_WS_PING_INTERVAL", 20.0)`.
- **Not** added to the strict `>= 1` memory-safety block: `<= 0` is a valid
  "disabled" value, handled in `build_hypercorn_config`. 20s sits safely under
  typical ~60s proxy idle timeouts.

### 4. Frontend auto-reconnect — `src/mailhedgehog/static/js/controllers.js`

Modify `openStream` / `closeStream`; add a small `scheduleReconnect` helper.
State on `$scope`: `wsReconnectDelay` (current backoff ms, base 1000),
`wsReconnectMax` (30000), `wsManuallyClosed` (bool), `wsReconnectTimer`.

Behaviour:
- `openStream`: clears `wsManuallyClosed`, cancels any pending reconnect timer,
  opens a new `WebSocket`, stores it as `ws` (local) and `$scope.source`.
  - `open`: `$apply` → `hasEventSource = true`, `wsReconnectDelay = 1000` (reset
    backoff only on a real connection).
  - `error` and `close` share one `onDrop` handler:
    - guard `if ($scope.source !== ws) return;` — a stale socket must not touch a
      newer connection;
    - `$apply` → `hasEventSource = false`;
    - if not `wsManuallyClosed`, call `scheduleReconnect()`.
- `scheduleReconnect`: no-op if a timer is already pending (handles the
  `error`-then-`close` double fire); else `$timeout(openStream, delay)` and
  `wsReconnectDelay = min(delay * 2, wsReconnectMax)`.
- `closeStream`: set `wsManuallyClosed = true`, cancel pending timer, close
  socket, `source = null`, `hasEventSource = false`.
- `toggleStream` unchanged.

The `message` handler (email handling) is unchanged.

## Error handling

- Dead/slow peer: hypercorn closes a peer that stops PONGing; the handler's
  `send()`/loop unwinds and the existing `finally: broadcaster.unregister(queue)`
  cleans up.
- Flapping server: backoff resets only on a successful `open`, so repeated
  failures back off to the 30s cap rather than hammering.
- Bounded queues (existing `WebSocketBroadcaster`) are unchanged; a slow UI still
  drops frames and reconciles on the next `/api/v2/messages` refresh.

## Testing

- **Config** (`tests/test_config.py`): `MH_WS_PING_INTERVAL` parsed; default
  `20.0`; empty/unset → default; `<= 0` preserved as a value (disable semantics
  asserted at the launcher layer).
- **Launcher unit** (fast, `tests/test_app_wiring.py` or new):
  `build_hypercorn_config` sets `websocket_ping_interval` (positive → value;
  `<= 0` → `None`), `bind` (incl. empty-host → `127.0.0.1`), `certfile`/`keyfile`
  mapping, and `accesslog`.
- **Heartbeat integration** (`tests/test_websocket.py`): start the real server
  with a short `ws_ping_interval` (e.g. 0.3s) on a fixed test port, perform a
  raw-socket WebSocket handshake, then read frames and assert a PING control
  frame (opcode `0x9`) arrives within a short window. Server run as a background
  task with an `asyncio.Event` `shutdown_trigger` for clean teardown.
- **Frontend**: ⚠️ the repo has **no JS test harness** (pytest only). The
  reconnect logic is verified **manually** and by keeping the change small and
  reviewable:
  1. Load the page → indicator shows "Connected" immediately (handshake fix).
  2. Restart the server → indicator flips to "Disconnected" then back to
     "Connected" within the backoff window (auto-reconnect).
  3. Leave the page idle past the proxy/ping window → stays "Connected" (no
     reconnect churn, heartbeat keeps it alive).
  This limitation is stated explicitly; no automated frontend coverage is
  claimed.

## Verification before completion

- `pytest -q` green (existing 69 + new tests).
- `ruff format` + `mypy` clean on changed Python.
- Raw-socket probe: 101 immediate when idle; PING frame observed within the
  interval.
- Manual frontend check per the three steps above.

## Deployment note (why the bug is still visible)

The handshake fix lives only on `RG-27867-websocket-disconnected`; `master` does
not contain `websocket.accept()`. Resolving the user-visible symptom requires
merging this branch to `master` and rebuilding/redeploying the image **without a
stale build cache** (a previously flagged risk). The heartbeat/reconnect work
ships in the same branch.
