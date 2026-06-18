# Remote-Image Proxy — Design

**Date:** 2026-06-18
**Status:** Approved (design); ready for implementation plan
**Branch:** `remote-image-proxy`

## Problem

mailhedgehog renders HTML email inside a sandboxed iframe and (by product
decision) loads remote content directly: the **browser** fetches each remote
`<img>` URL itself. mailhedgehog does **not** proxy those fetches.

In real deployments the viewer's browser often cannot reach the image hosts the
email references, even though the mailhedgehog **server** can. Observed on the
`adm1.stg.realgo.com:8025` staging sink: every captured IRES listing email
references images on `https://east.stg.iresis.photo/...` (which 307-redirects to
an AWS API-Gateway URL). Those images:

- render correctly when the iframe + CSP + `referrerpolicy="no-referrer"` setup
  is reproduced in a browser **on the server's network** (verified via headless
  Chrome — agent photo, logo, and property photo all load);
- are fully reachable from the server (`curl` follows the redirect to a 200
  `image/jpeg`);
- show as **broken image icons** in the operator's browser, because that
  browser cannot reach `east.stg.iresis.photo` / the AWS gateway.

This is not a rendering regression — the old MailHog UI fetched remote images
the same way. It is a network-path mismatch between server and client.

## Goal

Add an **opt-in server-side image proxy**. When enabled, remote `<img>` URLs in
email HTML are rewritten to a same-origin mailhedgehog endpoint; the server
fetches the remote image (with SSRF protections) and streams it back. Because
the images then originate from mailhedgehog itself — which the browser is
already talking to — they load regardless of the client's network reach, DNS,
or content blockers.

**Off by default.** When disabled, behavior is byte-for-byte today's: remote
images load directly in the browser, `cid:` images are rewritten as they are
now.

## Non-goals

- Proxying non-image resources (CSS, fonts, media, scripts). Images only.
- Caching/persisting fetched images to disk. Stream-through only (a short HTTP
  cache header is allowed; no server-side store).
- A per-message UI toggle. Activation is a single server flag (all-or-nothing).
- Hardened defense against an attacker who actively controls DNS to rebind a
  hostname between validation and connection (documented residual risk).

## Decisions (resolved with the user)

- **Activation:** a server env flag, automatic. When on, *all* remote images in
  every email are proxied transparently — no per-message clicking. Default off.
- **SSRF policy:** the proxy refuses to fetch URLs that resolve to private /
  internal addresses by default (no env allowlist in this version).
- **No new runtime Python dependencies** (stays `quart` + `aiosmtpd`); the
  fetcher uses the standard library only.
- **MailHog compatibility preserved:** everything is additive (new endpoints,
  new config, default off). No existing endpoint, response shape, or default
  behavior changes.

## Architecture

```
email HTML
  │  buildSrcdoc() (frontend, mime.ts)
  │    1. strip <script>/<base>
  │    2. rewrite cid: → /api/v1/.../mime/cid/.../download   (existing)
  │    3. IF proxy enabled: rewrite remaining http(s) <img> refs
  │         → /api/v2/proxy?url=<encoded>                     (new)
  │    4. inject CSP meta
  ▼
sandboxed iframe srcdoc
  │  browser requests same-origin /api/v2/proxy?url=…   (always reachable)
  ▼
GET /api/v2/proxy (web.py)
  │  await asyncio.to_thread(fetch_remote_image, …)
  ▼
fetch_remote_image() (fetcher.py)  — SSRF-guarded, stdlib only
  │  scheme check → resolve host → reject private/internal IPs
  │  manual redirect following (each hop re-validated)
  │  size cap + timeout; require image/*; svg→octet-stream
  ▼
streams image bytes back same-origin → renders in iframe
```

The SPA learns whether the flag is on via a new `GET /api/v2/config` endpoint
read once at startup, so it only rewrites remote images when the server will
actually serve them.

## Components

### 1. `config.py` — new knobs

Added to the frozen `Config` dataclass and `from_env`, all with safe defaults:

| Field | Env | Default | Meaning |
|---|---|---|---|
| `proxy_remote_images` | `MH_PROXY_REMOTE_IMAGES` | `False` | master switch |
| `proxy_timeout` | `MH_PROXY_TIMEOUT` | `10.0` | per-request seconds |
| `proxy_max_bytes` | `MH_PROXY_MAX_BYTES` | `10_485_760` (10 MB) | per-image size cap |
| `proxy_max_redirects` | `MH_PROXY_MAX_REDIRECTS` | `5` | redirect hop cap |

`proxy_remote_images` uses the existing `_bool` parser. The three numeric knobs
reuse `_int`/`_float`. The numeric knobs join the existing positive-value
validation in `__post_init__` (must be `>= 1`; `proxy_timeout` `> 0`).

### 2. `fetcher.py` — SSRF-safe remote image fetch (new module)

```python
class FetchError(Exception):
    """Raised when a remote image cannot be safely fetched. Never leaks internals."""

def is_public_ip(ip: str) -> bool:
    """False for loopback/private/link-local/unique-local/multicast/reserved/unspecified."""

def fetch_remote_image(
    url: str,
    *,
    max_bytes: int,
    timeout: float,
    max_redirects: int,
    is_ip_allowed: Callable[[str], bool] = is_public_ip,
) -> tuple[bytes, str]:
    """Fetch a remote image. Returns (content_bytes, safe_content_type).

    Raises FetchError on: non-http(s) scheme, host that resolves to a
    disallowed IP, too many redirects, timeout, network error, non-image
    content-type, or a body exceeding max_bytes.
    """
```

Behavior:
- **Scheme allowlist:** only `http`/`https`. Anything else → `FetchError`.
- **Host resolution + IP check:** `socket.getaddrinfo(host, port)` → for every
  resolved address, `is_ip_allowed(ip)` must be true; otherwise `FetchError`.
  Conservative: if *any* resolved IP is disallowed, reject (don't cherry-pick).
- **Manual redirect following:** redirects are NOT auto-followed by the HTTP
  client; the fetcher reads the `Location`, re-runs the full scheme + IP check
  on each hop, and stops after `max_redirects`. (This is why `east.stg.iresis.photo`
  → AWS works: both hops resolve to public IPs.)
- **Size cap:** read the body in bounded chunks; if it exceeds `max_bytes`,
  abort and raise `FetchError`. Never buffer an unbounded response.
- **Timeout:** applied to connect + read.
- **Content-Type:** the final response `Content-Type` must start with `image/`.
  `image/svg+xml` is downgraded to `application/octet-stream` (mirrors the cid
  endpoint — SVG can carry script; served as octet-stream it can't be abused).
  Any non-image type → `FetchError`.
- **Injectable IP policy:** `is_ip_allowed` defaults to `is_public_ip` but is a
  parameter so tests can run the real fetch path against a loopback test server
  (permissive policy) while the default still blocks loopback.

Runs entirely synchronously; the route offloads it with `asyncio.to_thread`.

### 3. `web.py` — new routes

- `GET /api/v2/config` → `{"proxyRemoteImages": config.proxy_remote_images}`.
  Additive; no auth (consistent with the rest of the API). Lets the SPA decide
  whether to rewrite.
- `GET /api/v2/proxy?url=<encoded>`:
  - If `not config.proxy_remote_images` → `abort(404)` (capability disabled).
  - Read `url` query param; if missing → `abort(400)`.
  - `content, content_type = await asyncio.to_thread(fetch_remote_image, url,
    max_bytes=config.proxy_max_bytes, timeout=config.proxy_timeout,
    max_redirects=config.proxy_max_redirects)`.
  - On `FetchError` (or any exception) → `abort(502)` (the browser shows the
    same broken-image icon as today — never worse than the status quo).
  - On success → `Response(content, mimetype=content_type, headers={
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "private, max-age=300"})`.
  - The existing `after_request` still stamps `nosniff` + the app CSP.

### 4. Frontend

- `api.ts`:
  - `getConfig(): Promise<{ proxyRemoteImages: boolean }>` → `GET /api/v2/config`.
  - `proxyUrl(rawUrl: string): string` →
    `/api/v2/proxy?url=${encodeURIComponent(rawUrl)}`.
- Startup (App/store): fetch `/api/v2/config` once; store `proxyRemoteImages`
  (reactive `$state`, default `false`). If the request fails, assume `false`
  (graceful: direct load).
- `mime.ts buildSrcdoc`: change the third argument from `cidUrlFn` to a single
  options object:
  `buildSrcdoc(html: string, msgId: string, opts: { cidUrl: (id: string, cid: string) => string; proxyImages?: boolean; proxyUrl?: (url: string) => string }): string`.
  After the existing cid rewrite, when `opts.proxyImages` is true (and
  `opts.proxyUrl` is provided), rewrite the **remaining** `http(s)` image
  references — `src`, `srcset` entries, `poster`, and inline `style="… url(…)"`
  — through `opts.proxyUrl`. Leave untouched: already-rewritten cid refs (now
  `/api/...`), `data:`, `blob:`, and any non-http(s) value. Existing call sites
  and tests are updated to the new signature.
- `MessageDetail.svelte`: pass `proxyImages` (from store) and `proxyUrl` into
  `buildSrcdoc`.

## Data flow (enabled)

1. SPA loads, fetches `/api/v2/config` → `proxyRemoteImages: true`.
2. User opens a message; `buildSrcdoc` rewrites `cid:` → cid endpoint and remote
   `http(s)` images → `/api/v2/proxy?url=…`.
3. The sandboxed iframe requests the proxy endpoint (same origin — reachable).
4. The route validates the flag and calls the fetcher on a worker thread.
5. The fetcher SSRF-checks and fetches the remote image, streaming it back.
6. The image renders in the iframe.

## Error handling

| Condition | Result |
|---|---|
| Flag off, `/api/v2/proxy` hit | 404 (capability disabled) |
| Missing `url` param | 400 |
| Disallowed scheme / private IP / redirect to private IP | 502 → broken-image icon |
| Non-image content-type | 502 |
| Body exceeds `max_bytes` | 502 |
| Timeout / network error | 502 |
| `/api/v2/config` fetch fails (frontend) | assume `proxyRemoteImages=false`, load direct |

No error path is worse than today's behavior (a broken-image icon). No internal
detail (resolved IP, stack) is leaked in a response.

## Testing

**Backend (`tests/`):**
- `test_fetcher.py`: spin up a local `http.server` (pattern from
  `test_websocket.py`) serving: a small PNG, a redirect chain, an oversized
  body, a non-image body, an `image/svg+xml`. Assert, via the **permissive**
  `is_ip_allowed`:
  - happy path returns `(bytes, "image/png")`;
  - redirect is followed and validated;
  - oversized body → `FetchError`;
  - non-image → `FetchError`;
  - svg → content-type `application/octet-stream`.
  - With the **default** policy: a loopback/127.0.0.1 target → `FetchError`;
    `is_public_ip` returns False for `127.0.0.1`, `10.x`, `192.168.x`,
    `169.254.169.254`, `::1`, `fc00::/7`; True for a public address.
  - non-http scheme (`file:`) → `FetchError`.
  - redirect whose target resolves to a blocked IP → `FetchError`.
- `test_api_proxy.py` (or extend existing): the route tests **mock**
  `fetcher.fetch_remote_image` (monkeypatch) so they verify the route's wiring
  — flag/param handling, status codes, headers — without depending on the SSRF
  policy or real network. The real fetch + SSRF behavior is covered by
  `test_fetcher.py`. Cases: `/api/v2/config` shape in both flag states;
  `/api/v2/proxy` → 404 when off; with the flag on and the fetcher mocked to
  return `(b"...", "image/png")` → 200 with those bytes, that content-type, and
  `X-Content-Type-Options: nosniff`; with the fetcher mocked to raise
  `FetchError` → 502; missing `url` param → 400. This avoids the circular
  dependency where the production default policy (`is_public_ip`) would block a
  loopback test server.

**Frontend (`frontend/src`):**
- `mime` tests: with `proxyImages: true`, `buildSrcdoc` rewrites `http(s)` img
  `src`/`srcset`/`poster`/inline-style-`url()` to `/api/v2/proxy?url=…`; with
  `proxyImages: false` (default) leaves them direct; cid/`data:`/`blob:` left
  untouched in both modes.
- `api` tests: `proxyUrl` encodes the URL; `getConfig` parses the shape.

## Constraints honored

- No new runtime Python deps (stdlib `urllib`/`http.client`, `ipaddress`,
  `socket`).
- MailHog-compatible: all additive, default off; no existing behavior changes.
- The committed Svelte build is rebuilt; the path-filtered CI drift guard covers
  it.
- All existing iframe security invariants intact: still `sandbox=""` (no
  `allow-scripts`/`allow-same-origin`), scripts blocked, CSP injected; the only
  untrusted-HTML sink remains the iframe `srcdoc` binding.

## Documentation

- README: document `MH_PROXY_REMOTE_IMAGES` (+ the three tuning knobs), what the
  proxy does, the default-off stance, and the SSRF residual-risk note.

## Residual risk (documented, accepted)

Per-hop IP validation blocks emails that reference internal/private addresses.
It does **not** fully defend against an attacker who controls authoritative DNS
for a hostname and rebinds it from a public IP (passing validation) to a private
IP (used at connect time). For an operator who explicitly opts in on an internal
sink, this residual TOCTOU risk is accepted. The size cap, timeout, image-only
content-type check, and redirect cap remain in force regardless.
