# WebSocket Heartbeat + Auto-Reconnect Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the web UI's "Connected" indicator correct on first load and self-healing thereafter — by keeping the existing handshake fix, adding a server-side WebSocket heartbeat, and adding frontend auto-reconnect.

**Architecture:** The handshake fix (`await websocket.accept()`, already on this branch) makes the browser's `open` event fire immediately. A hypercorn protocol-level `websocket_ping_interval` keeps idle connections alive through proxies (invisible to JS — the browser auto-PONGs). Frontend JS reconnects with capped exponential backoff after any genuine drop, resetting backoff only on a real `open`.

**Tech Stack:** Python 3.10, Quart, Hypercorn (run directly), aiosmtpd; vendored AngularJS frontend; pytest (asyncio auto-mode); uv; ruff; mypy.

## Global Constraints

- Target runtime: **Python 3.10** (`python:3.10-alpine` in Dockerfile). No 3.11+ only syntax.
- All functions get **type annotations**; run `ruff format` and `mypy` clean on changed Python.
- Dependency management is **uv** only (no pip/poetry/requirements.txt). `hypercorn` is already a transitive dep of Quart and present in the venv; no new dependency is added.
- Add `AIDEV-NOTE:` anchor comments on non-obvious/important code; **never remove** existing `AIDEV-` comments.
- Run tests with `.venv/bin/python -m pytest` (asyncio auto-mode is already configured — existing `async def test_*` run without decorators).
- The existing handshake regression test (`tests/test_websocket.py::test_websocket_accepts_before_any_broadcast`) and all 69 current tests must stay green.

---

### Task 1: Config knob `MH_WS_PING_INTERVAL`

**Files:**
- Modify: `src/mailhedgehog/config.py`
- Test: `tests/test_config.py`
- Docs: `README.md` (env-var table)

**Interfaces:**
- Consumes: nothing.
- Produces: `Config.ws_ping_interval: float` (default `20.0`); env var `MH_WS_PING_INTERVAL`; module-level helper `_float(name: str, default: float) -> float`. `<= 0` is a **valid** value meaning "heartbeat disabled" (interpreted in Task 2), so it is intentionally NOT added to the strict `>= 1` validation block.

- [ ] **Step 1: Write the failing tests**

Add to `tests/test_config.py`:

```python
def test_ws_ping_interval_default():
    from mailhedgehog.config import Config

    assert Config().ws_ping_interval == 20.0


def test_ws_ping_interval_from_env(monkeypatch):
    from mailhedgehog.config import Config

    monkeypatch.setenv("MH_WS_PING_INTERVAL", "5.5")
    assert Config.from_env().ws_ping_interval == 5.5


def test_ws_ping_interval_empty_uses_default(monkeypatch):
    from mailhedgehog.config import Config

    monkeypatch.setenv("MH_WS_PING_INTERVAL", "")
    assert Config.from_env().ws_ping_interval == 20.0


def test_ws_ping_interval_allows_non_positive_to_disable(monkeypatch):
    # AIDEV-NOTE: <= 0 is intentionally allowed; it disables the heartbeat at
    # the launcher (maps to hypercorn websocket_ping_interval=None).
    from mailhedgehog.config import Config

    monkeypatch.setenv("MH_WS_PING_INTERVAL", "0")
    assert Config.from_env().ws_ping_interval == 0.0
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `.venv/bin/python -m pytest tests/test_config.py -k ws_ping_interval -v`
Expected: FAIL — `AttributeError: 'Config' object has no attribute 'ws_ping_interval'`.

- [ ] **Step 3: Implement the config field + `_float` helper**

In `src/mailhedgehog/config.py`, add the helper after `_int` (after line 16):

```python
def _float(name: str, default: float) -> float:
    value = os.environ.get(name)
    if value is None or value == "":
        return default
    return float(value)
```

Add the field after `ws_queue_size: int = 256` (line 39):

```python
    ws_ping_interval: float = 20.0
```

Add to `from_env(...)` after the `ws_queue_size=...` line (line 72):

```python
            ws_ping_interval=_float("MH_WS_PING_INTERVAL", 20.0),
```

Do NOT add `ws_ping_interval` to the `caps` dict in `__post_init__` — non-positive is valid here.

- [ ] **Step 4: Run tests to verify they pass**

Run: `.venv/bin/python -m pytest tests/test_config.py -v`
Expected: PASS (all config tests, including the four new ones).

- [ ] **Step 5: Document the env var**

In `README.md`, add a row to the configuration table immediately after the `MH_WS_QUEUE_SIZE` row (line 58):

```markdown
| `MH_WS_PING_INTERVAL` | `20`         | WebSocket keepalive ping interval in seconds (`<= 0` disables) |
```

- [ ] **Step 6: Format, type-check, commit**

```bash
.venv/bin/ruff format src/mailhedgehog/config.py
.venv/bin/mypy src/mailhedgehog/config.py
git add src/mailhedgehog/config.py tests/test_config.py README.md
git commit -m "feat(config): add MH_WS_PING_INTERVAL websocket heartbeat knob"
```

---

### Task 2: Serve via hypercorn directly with the heartbeat

**Files:**
- Modify: `src/mailhedgehog/app.py`
- Test: `tests/test_app_wiring.py`
- Docs: `README.md` (one-line serving note)

**Interfaces:**
- Consumes: `Config.ws_ping_interval` (Task 1); existing `build() -> tuple[Config, Quart]`.
- Produces: `build_hypercorn_config(config: Config) -> hypercorn.config.Config`. Maps `bind` (`http_host` or `"127.0.0.1"` + `http_port`), `certfile`/`keyfile` from `tls_cert`/`tls_key`, `accesslog`/`errorlog` to `"-"`, and `websocket_ping_interval` = `ws_ping_interval` if `> 0` else `None`. `main()` runs `asyncio.run(serve(app, build_hypercorn_config(config)))`.

- [ ] **Step 1: Write the failing tests**

Add to `tests/test_app_wiring.py`:

```python
def test_build_hypercorn_config_sets_ping_interval():
    from mailhedgehog.app import build_hypercorn_config

    hcfg = build_hypercorn_config(Config(http_host="", http_port=8025, ws_ping_interval=20.0))
    assert hcfg.websocket_ping_interval == 20.0
    assert hcfg.bind == ["127.0.0.1:8025"]


def test_build_hypercorn_config_disables_ping_when_non_positive():
    from mailhedgehog.app import build_hypercorn_config

    hcfg = build_hypercorn_config(Config(ws_ping_interval=0.0))
    assert hcfg.websocket_ping_interval is None


def test_build_hypercorn_config_binds_explicit_host():
    from mailhedgehog.app import build_hypercorn_config

    hcfg = build_hypercorn_config(Config(http_host="0.0.0.0", http_port=9000))
    assert hcfg.bind == ["0.0.0.0:9000"]


def test_build_hypercorn_config_maps_tls_and_logs():
    from mailhedgehog.app import build_hypercorn_config

    hcfg = build_hypercorn_config(Config(tls_cert="/c.pem", tls_key="/k.pem"))
    assert hcfg.certfile == "/c.pem"
    assert hcfg.keyfile == "/k.pem"
    assert hcfg.accesslog == "-"
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `.venv/bin/python -m pytest tests/test_app_wiring.py -k hypercorn -v`
Expected: FAIL — `ImportError: cannot import name 'build_hypercorn_config'`.

- [ ] **Step 3: Rewrite the launcher**

Replace the entire contents of `src/mailhedgehog/app.py` with:

```python
"""Application wiring and entrypoint."""

from __future__ import annotations

import asyncio

from hypercorn.asyncio import serve
from hypercorn.config import Config as HyperConfig
from quart import Quart

from mailhedgehog.config import Config
from mailhedgehog.storage import MessageStore
from mailhedgehog.web import create_app


def build() -> tuple[Config, Quart]:
    config = Config.from_env()
    store = MessageStore(config.max_messages, config.max_bytes)
    return config, create_app(config, store)


def build_hypercorn_config(config: Config) -> HyperConfig:
    # AIDEV-NOTE: serve via hypercorn directly (not Quart's dev server). This is
    # the only way to set websocket_ping_interval (Quart.run ignores kwargs) and
    # is the production-correct ASGI server. websocket_ping_interval emits
    # protocol PING frames so idle connections survive proxy/LB idle timeouts and
    # dead peers are detected; the browser auto-PONGs (invisible to the frontend).
    # <= 0 disables the heartbeat. Mirrors Quart.run_task's bind/tls/log wiring.
    hcfg = HyperConfig()
    hcfg.bind = [f"{config.http_host or '127.0.0.1'}:{config.http_port}"]
    hcfg.accesslog = "-"
    hcfg.errorlog = "-"
    hcfg.certfile = config.tls_cert
    hcfg.keyfile = config.tls_key
    hcfg.websocket_ping_interval = (
        config.ws_ping_interval if config.ws_ping_interval > 0 else None
    )
    return hcfg


def main() -> None:
    config, app = build()
    app.debug = config.debug
    # AIDEV-NOTE: no shutdown_trigger -> hypercorn installs SIGINT/SIGTERM
    # handlers itself, so `docker stop` triggers a graceful ASGI lifespan
    # shutdown (Quart after_serving -> SMTP server cleanup in web.py).
    asyncio.run(serve(app, build_hypercorn_config(config)))


if __name__ == "__main__":
    main()
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `.venv/bin/python -m pytest tests/test_app_wiring.py -v`
Expected: PASS (existing `test_build_returns_config_and_app` plus the four new ones).

- [ ] **Step 5: Smoke-test the real server boots and shuts down**

Run:
```bash
MH_HTTP_PORT=18030 MH_SMTP_PORT=11030 MH_HTTP_HOST=127.0.0.1 \
  timeout 2 .venv/bin/mailhedgehog 2>&1 | head -5 || true
```
Expected: hypercorn startup lines (e.g. `Running on http://127.0.0.1:18030`), and the process exits on the timeout's signal without a traceback.

- [ ] **Step 6: Document the serving change**

In `README.md`, append to the sentence/line describing the app (line 36, the "built on Quart" bullet) or add a new bullet right after it:

```markdown
* Served in production by [Hypercorn](https://hypercorn.readthedocs.io/) with WebSocket keepalive pings.
```

- [ ] **Step 7: Format, type-check, commit**

```bash
.venv/bin/ruff format src/mailhedgehog/app.py
.venv/bin/mypy src/mailhedgehog/app.py
git add src/mailhedgehog/app.py tests/test_app_wiring.py README.md
git commit -m "feat(server): serve via hypercorn with websocket keepalive pings"
```

---

### Task 3: End-to-end heartbeat test (real PING frame on the wire)

**Files:**
- Test: `tests/test_websocket.py`

**Interfaces:**
- Consumes: `build_hypercorn_config` (Task 2), `create_app`, `MessageStore`, `Config`, `hypercorn.asyncio.serve`.
- Produces: nothing (acceptance test only). Verifies hypercorn actually emits a WebSocket PING (control opcode `0x9`) within the configured interval.

- [ ] **Step 1: Write the failing/acceptance test**

Add to `tests/test_websocket.py` (the `import asyncio`/`import json` lines already exist at the top; add `import base64`, `import os`, `import socket` to the imports):

```python
def _ws_first_frame_is_ping(port: int) -> bool:
    # AIDEV-NOTE: raw-socket WS client (no client lib in the venv). Completes the
    # handshake, then reads the first frame; an idle server sends nothing but the
    # heartbeat, so the first frame's opcode (low nibble of byte 0) must be 0x9
    # (PING). Runs in a thread so it does not block the server's event loop.
    key = base64.b64encode(os.urandom(16)).decode()
    req = (
        f"GET /api/v2/websocket HTTP/1.1\r\n"
        f"Host: 127.0.0.1:{port}\r\n"
        f"Upgrade: websocket\r\n"
        f"Connection: Upgrade\r\n"
        f"Sec-WebSocket-Key: {key}\r\n"
        f"Sec-WebSocket-Version: 13\r\n"
        f"\r\n"
    ).encode()
    s = socket.create_connection(("127.0.0.1", port), timeout=5)
    s.settimeout(3.0)
    try:
        s.sendall(req)
        buf = b""
        while b"\r\n\r\n" not in buf:
            chunk = s.recv(4096)
            if not chunk:
                return False
            buf += chunk
        data = buf.split(b"\r\n\r\n", 1)[1]
        while not data:
            data = s.recv(4096)
        return bool(data) and (data[0] & 0x0F) == 0x9
    except socket.timeout:
        return False
    finally:
        s.close()


def _free_port() -> int:
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


async def test_server_emits_websocket_ping_when_idle():
    from hypercorn.asyncio import serve

    from mailhedgehog.app import build_hypercorn_config

    port = _free_port()
    config = Config(
        smtp_port=0, http_host="127.0.0.1", http_port=port, ws_ping_interval=0.3
    )
    store = MessageStore(config.max_messages, config.max_bytes)
    app = create_app(config, store)
    shutdown = asyncio.Event()
    server = asyncio.create_task(
        serve(app, build_hypercorn_config(config), shutdown_trigger=shutdown.wait)
    )
    try:
        # wait for the port to accept connections
        for _ in range(100):
            try:
                reader, writer = await asyncio.open_connection("127.0.0.1", port)
                writer.close()
                break
            except OSError:
                await asyncio.sleep(0.05)
        ping_seen = await asyncio.get_running_loop().run_in_executor(
            None, _ws_first_frame_is_ping, port
        )
        assert ping_seen, "server must emit a WS PING (opcode 0x9) within the interval"
    finally:
        shutdown.set()
        await asyncio.wait_for(server, timeout=5)
```

- [ ] **Step 2: Run the test**

Run: `.venv/bin/python -m pytest tests/test_websocket.py::test_server_emits_websocket_ping_when_idle -v`
Expected: PASS. (If it fails with no PING, confirm `build_hypercorn_config` from Task 2 sets `websocket_ping_interval`.)

- [ ] **Step 3: Run the whole websocket suite**

Run: `.venv/bin/python -m pytest tests/test_websocket.py -v`
Expected: PASS (the 3 broadcaster tests, the 2 prior ws tests incl. the handshake regression, plus this one).

- [ ] **Step 4: Commit**

```bash
git add tests/test_websocket.py
git commit -m "test(ws): assert hypercorn emits a websocket PING when idle"
```

---

### Task 4: Frontend auto-reconnect with capped backoff

**Files:**
- Modify: `src/mailhedgehog/static/js/controllers.js` (current `openStream` lines 127-164, `closeStream` lines 165-169, `toggleStream` lines 124-126)

**Interfaces:**
- Consumes: existing `$scope.source`, `$scope.hasEventSource`, `$scope.host`, `$timeout`, and the existing `message` body (unchanged).
- Produces: `$scope.scheduleReconnect()`; new `$scope` state `wsReconnectBase`/`wsReconnectMax`/`wsReconnectDelay`/`wsManuallyClosed`/`wsReconnectTimer`; rewritten `openStream`/`closeStream`. Heartbeat needs no JS change (browser auto-PONGs).

> **No automated test:** the repo has no JS test harness (pytest only). This task is verified manually in Step 3 and at final verification (Task 5). Do not claim automated coverage.

- [ ] **Step 1: Replace `toggleStream`, `openStream`, and `closeStream`**

In `src/mailhedgehog/static/js/controllers.js`, replace the block from `$scope.toggleStream = function() {` (line 124) through the end of `closeStream` (line 169) with:

```javascript
  // AIDEV-NOTE: websocket auto-reconnect. hasEventSource (the Connected/
  // Disconnected indicator) drops to false on any close/error; without this the
  // UI never recovered until a full page reload. Backoff resets only on a real
  // `open`. wsManuallyClosed suppresses reconnect when the user toggles the
  // stream off. The `source !== ws` guard stops a stale socket's late
  // close/error from disturbing a newer connection. The pending-timer guard
  // makes the error-then-close double fire schedule exactly one reconnect.
  $scope.wsReconnectBase = 1000;
  $scope.wsReconnectMax = 30000;
  $scope.wsReconnectDelay = $scope.wsReconnectBase;
  $scope.wsManuallyClosed = false;
  $scope.wsReconnectTimer = null;

  $scope.scheduleReconnect = function() {
    if ($scope.wsReconnectTimer) { return; }
    var delay = $scope.wsReconnectDelay;
    $scope.wsReconnectTimer = $timeout(function() {
      $scope.wsReconnectTimer = null;
      $scope.openStream();
    }, delay);
    $scope.wsReconnectDelay = Math.min($scope.wsReconnectDelay * 2, $scope.wsReconnectMax);
  }

  $scope.toggleStream = function() {
    $scope.source == null ? $scope.openStream() : $scope.closeStream();
  }
  $scope.openStream = function() {
    $scope.wsManuallyClosed = false;
    if ($scope.wsReconnectTimer) {
      $timeout.cancel($scope.wsReconnectTimer);
      $scope.wsReconnectTimer = null;
    }
    var host = $scope.host.replace(/^http/, 'ws') ||
               (location.protocol.replace(/^http/, 'ws') + '//' + location.hostname + (location.port ? ':' + location.port : '') + location.pathname);
    var ws = new WebSocket(host + 'api/v2/websocket');
    $scope.source = ws;
    ws.addEventListener('message', function(e) {
      $scope.$apply(function() {
        $scope.totalMessages++;
        if ($scope.startIndex > 0) {
          $scope.startIndex++;
          $scope.startMessages++;
          return
        }
        if ($scope.countMessages < $scope.itemsPerPage) {
          $scope.countMessages++;
        }
        var message = JSON.parse(e.data);
        $scope.messages.unshift(message);
        while($scope.messages.length > $scope.itemsPerPage) {
          $scope.messages.pop();
        }
        if(typeof(Notification) !== "undefined") {
          $scope.createNotification(message);
        }
      });
    }, false);
    ws.addEventListener('open', function(e) {
      $scope.$apply(function() {
        $scope.hasEventSource = true;
        $scope.wsReconnectDelay = $scope.wsReconnectBase;
      });
    }, false);
    var onDrop = function(e) {
      if ($scope.source !== ws) { return; }
      $scope.$apply(function() {
        $scope.hasEventSource = false;
      });
      if (!$scope.wsManuallyClosed) {
        $scope.scheduleReconnect();
      }
    };
    ws.addEventListener('error', onDrop, false);
    ws.addEventListener('close', onDrop, false);
  }
  $scope.closeStream = function() {
    $scope.wsManuallyClosed = true;
    if ($scope.wsReconnectTimer) {
      $timeout.cancel($scope.wsReconnectTimer);
      $scope.wsReconnectTimer = null;
    }
    if ($scope.source) {
      $scope.source.close();
      $scope.source = null;
    }
    $scope.hasEventSource = false;
  }
```

- [ ] **Step 2: Sanity-check the JS parses**

Run: `node --check src/mailhedgehog/static/js/controllers.js`
Expected: no output (exit 0). If `node` is unavailable, skip and rely on Step 3.

- [ ] **Step 3: Manual reconnect verification**

```bash
MH_HTTP_PORT=18040 MH_SMTP_PORT=11040 MH_HTTP_HOST=127.0.0.1 .venv/bin/mailhedgehog
```
In a browser at `http://127.0.0.1:18040/`:
1. On load the indicator shows **Connected** within ~1s (handshake fix).
2. Stop the server (Ctrl-C) → indicator flips to **Disconnected**.
3. Restart the server → indicator returns to **Connected** within the backoff window (≤ a few seconds) with no page reload.
4. Click the indicator (toggle off) → stays **Disconnected** and does NOT auto-reconnect; click again → **Connected**.

- [ ] **Step 4: Commit**

```bash
git add src/mailhedgehog/static/js/controllers.js
git commit -m "feat(ui): auto-reconnect websocket with capped backoff"
```

---

### Task 5: Full verification

**Files:** none (verification + any final doc touch-ups).

- [ ] **Step 1: Full test suite**

Run: `.venv/bin/python -m pytest -q`
Expected: all green (69 prior + new config/launcher/heartbeat tests).

- [ ] **Step 2: Lint + types on all changed Python**

```bash
.venv/bin/ruff format --check src/mailhedgehog/config.py src/mailhedgehog/app.py
.venv/bin/mypy src/mailhedgehog/config.py src/mailhedgehog/app.py
```
Expected: format clean; mypy `Success: no issues found`.

- [ ] **Step 3: End-to-end handshake + heartbeat probe against the real server**

```bash
MH_HTTP_PORT=18050 MH_SMTP_PORT=11050 MH_HTTP_HOST=127.0.0.1 MH_WS_PING_INTERVAL=1 \
  .venv/bin/mailhedgehog >/tmp/mh_verify.log 2>&1 &
SRV=$!; sleep 1
.venv/bin/python - <<'PY'
import socket, base64, os
key=base64.b64encode(os.urandom(16)).decode()
req=(f"GET /api/v2/websocket HTTP/1.1\r\nHost:127.0.0.1:18050\r\nUpgrade:websocket\r\n"
     f"Connection:Upgrade\r\nSec-WebSocket-Key:{key}\r\nSec-WebSocket-Version:13\r\n\r\n").encode()
s=socket.create_connection(("127.0.0.1",18050),5); s.settimeout(3); s.sendall(req)
buf=b""
while b"\r\n\r\n" not in buf: buf+=s.recv(4096)
print("handshake:", buf.split(b"\r\n",1)[0].decode())
data=buf.split(b"\r\n\r\n",1)[1]
while not data: data=s.recv(4096)
print("first frame opcode:", data[0] & 0x0F, "(9 == PING)")
s.close()
PY
kill $SRV 2>/dev/null; wait $SRV 2>/dev/null
```
Expected: `handshake: HTTP/1.1 101` and `first frame opcode: 9 (9 == PING)`.

- [ ] **Step 4: Confirm the branch is ready to integrate**

The handshake fix + heartbeat + reconnect now live on `RG-27867-websocket-disconnected`. Use the `superpowers:finishing-a-development-branch` skill to choose merge/PR. Reminder for deployment: rebuild the image with **no stale build cache** (previously-flagged risk) so the running container actually picks up `websocket.accept()` + the hypercorn launcher.

---

## Self-Review

**Spec coverage:**
- Handshake fix lands on master → Task 5 Step 4 (integration handoff). ✓
- Backend heartbeat (hypercorn `websocket_ping_interval`) → Task 2. ✓
- Config knob `MH_WS_PING_INTERVAL` + `<=0` disable → Task 1 (+ Task 2 mapping). ✓
- Frontend auto-reconnect w/ backoff, manual-close suppression, stale-socket + double-fire guards → Task 4. ✓
- Graceful shutdown preserved (no `shutdown_trigger`) → Task 2 Step 3 (note + smoke test). ✓
- Tests: config / launcher unit / heartbeat integration → Tasks 1–3; frontend manual (no JS harness) → Task 4 Step 3 + Task 5. ✓
- Docs: env-var row → Task 1; serving note → Task 2. ✓
- Verification before completion (pytest, ruff, mypy, raw probe, manual) → Task 5. ✓

**Placeholder scan:** No TBD/TODO/"handle edge cases"/"similar to". All code shown in full. ✓

**Type consistency:** `build_hypercorn_config(config: Config) -> HyperConfig` used identically in Tasks 2 and 3; `ws_ping_interval` (float) consistent across Tasks 1–3; JS names (`scheduleReconnect`, `wsReconnectDelay`, `wsReconnectBase`, `wsReconnectMax`, `wsManuallyClosed`, `wsReconnectTimer`) consistent within Task 4. ✓
