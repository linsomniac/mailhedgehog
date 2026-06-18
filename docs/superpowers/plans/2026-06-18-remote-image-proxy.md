# Remote-Image Proxy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an opt-in server-side proxy that fetches remote `<img>` URLs in email HTML and streams them back same-origin, so images render even when the viewer's browser cannot reach the image hosts.

**Architecture:** A new env flag enables the feature. When on, the SPA (which learns the flag from a new `/api/v2/config` endpoint) rewrites remote `http(s)` image refs in the iframe srcdoc to `/api/v2/proxy?url=…`; the server fetches them on a worker thread through an SSRF-guarded, stdlib-only fetcher and streams the bytes back. Off by default — today's direct-load behavior is byte-for-byte unchanged.

**Tech Stack:** Python 3.10 / Quart / Hypercorn (backend, stdlib `urllib`/`socket`/`ipaddress` only); Svelte 5 + TypeScript + Vite + Vitest (frontend). Spec: `docs/superpowers/specs/2026-06-18-remote-image-proxy-design.md`.

## Global Constraints

- **No new runtime Python dependencies.** The fetcher uses the standard library only (`urllib`, `socket`, `ipaddress`). Dev deps unchanged.
- **MailHog-compatible & additive.** No existing endpoint, response shape, default behavior, or WS frame changes. Everything new is gated behind the flag / new endpoints.
- **Default off.** `MH_PROXY_REMOTE_IMAGES` defaults to `False`; with it off, behavior is identical to today (remote images load directly; `cid:` rewritten as now).
- **Knob defaults (verbatim):** `proxy_timeout=10.0`, `proxy_max_bytes=10_485_760`, `proxy_max_redirects=5`.
- **SSRF policy:** reject any URL whose host resolves to a loopback / private (RFC1918, ULA) / link-local / multicast / reserved / unspecified address (covers cloud-metadata `169.254.169.254`). Re-check on **every** redirect hop. http/https schemes only.
- **Image-only:** the proxy serves only `image/*`; `image/svg+xml` is downgraded to `application/octet-stream`; any non-image content-type is rejected.
- **Failure stance (verbatim):** flag off → `404`; missing `url` param → `400`; any fetch/SSRF/size/type/timeout failure → `502`. Never leak resolved IPs or stack traces in responses.
- **Response headers on success:** `X-Content-Type-Options: nosniff` and `Cache-Control: private, max-age=300`.
- **Frontend rewrite scope:** only `http(s)` `<img>` `src`, `srcset` entries, `poster`, and inline `style="… url(…)"`. Leave untouched cid refs (already `/api/...`), `data:`, `blob:`, and any non-http(s) value.
- **Frontend graceful default:** fetch `/api/v2/config` once at startup; if it fails, assume `proxyRemoteImages=false` (direct load).
- **Committed build:** after frontend source changes, rebuild `src/mailhedgehog/static/app/` and commit it; the path-filtered CI drift guard must pass.
- **Code style:** `ruff format`; `mypy --strict` clean (the repo runs `mypy` over `src`); full type annotations on functions; add `AIDEV-NOTE:` anchor comments on security-critical / subtle code per the repo convention.

---

### Task 1: Config knobs

**Files:**
- Modify: `src/mailhedgehog/config.py`
- Test: `tests/test_config.py`

**Interfaces:**
- Consumes: nothing.
- Produces: `Config` fields `proxy_remote_images: bool` (default `False`), `proxy_timeout: float` (default `10.0`), `proxy_max_bytes: int` (default `10_485_760`), `proxy_max_redirects: int` (default `5`); env vars `MH_PROXY_REMOTE_IMAGES`, `MH_PROXY_TIMEOUT`, `MH_PROXY_MAX_BYTES`, `MH_PROXY_MAX_REDIRECTS`.

- [ ] **Step 1: Write the failing tests**

Add to `tests/test_config.py`:

```python
def test_proxy_defaults(monkeypatch):
    for name in (
        "MH_PROXY_REMOTE_IMAGES",
        "MH_PROXY_TIMEOUT",
        "MH_PROXY_MAX_BYTES",
        "MH_PROXY_MAX_REDIRECTS",
    ):
        monkeypatch.delenv(name, raising=False)
    cfg = Config.from_env()
    assert cfg.proxy_remote_images is False
    assert cfg.proxy_timeout == 10.0
    assert cfg.proxy_max_bytes == 10_485_760
    assert cfg.proxy_max_redirects == 5


def test_proxy_reads_from_environment(monkeypatch):
    monkeypatch.setenv("MH_PROXY_REMOTE_IMAGES", "1")
    monkeypatch.setenv("MH_PROXY_TIMEOUT", "3.5")
    monkeypatch.setenv("MH_PROXY_MAX_BYTES", "2048")
    monkeypatch.setenv("MH_PROXY_MAX_REDIRECTS", "0")
    cfg = Config.from_env()
    assert cfg.proxy_remote_images is True
    assert cfg.proxy_timeout == 3.5
    assert cfg.proxy_max_bytes == 2048
    assert cfg.proxy_max_redirects == 0


def test_proxy_max_bytes_must_be_positive():
    with pytest.raises(ValueError, match="proxy_max_bytes"):
        Config(proxy_max_bytes=0)


def test_proxy_timeout_must_be_positive():
    with pytest.raises(ValueError, match="proxy_timeout"):
        Config(proxy_timeout=0)


def test_proxy_max_redirects_rejects_negative():
    with pytest.raises(ValueError, match="proxy_max_redirects"):
        Config(proxy_max_redirects=-1)
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `uv run pytest tests/test_config.py -k proxy -v`
Expected: FAIL (e.g. `TypeError: __init__() got an unexpected keyword argument 'proxy_remote_images'` / AttributeError).

- [ ] **Step 3: Add the fields, env parsing, and validation**

In `src/mailhedgehog/config.py`, add fields to the dataclass (after `ws_ping_interval`):

```python
    proxy_remote_images: bool = False
    proxy_timeout: float = 10.0
    proxy_max_bytes: int = 10_485_760
    proxy_max_redirects: int = 5
```

Extend `__post_init__` validation. Add `proxy_max_bytes` to the existing `caps` dict (so it joins the `>= 1` check), and add the two new checks after the existing loop:

```python
        caps = {
            "max_messages": self.max_messages,
            "max_bytes": self.max_bytes,
            "max_message_size": self.max_message_size,
            "ws_queue_size": self.ws_queue_size,
            "proxy_max_bytes": self.proxy_max_bytes,
        }
        for name, value in caps.items():
            if value < 1:
                raise ValueError(
                    f"{name} must be a positive integer (>= 1), got {value}"
                )
        # AIDEV-NOTE: proxy knobs. timeout must be > 0 (a 0/negative urllib timeout
        # is meaningless here); max_redirects may be 0 (= refuse all redirects).
        if self.proxy_timeout <= 0:
            raise ValueError(
                f"proxy_timeout must be > 0, got {self.proxy_timeout}"
            )
        if self.proxy_max_redirects < 0:
            raise ValueError(
                f"proxy_max_redirects must be >= 0, got {self.proxy_max_redirects}"
            )
```

Add to `from_env()` (after `ws_ping_interval=...`):

```python
            proxy_remote_images=_bool("MH_PROXY_REMOTE_IMAGES", False),
            proxy_timeout=_float("MH_PROXY_TIMEOUT", 10.0),
            proxy_max_bytes=_int("MH_PROXY_MAX_BYTES", 10_485_760),
            proxy_max_redirects=_int("MH_PROXY_MAX_REDIRECTS", 5),
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `uv run pytest tests/test_config.py -v`
Expected: PASS (new + all existing config tests).

- [ ] **Step 5: Format, type-check, commit**

```bash
uv run ruff format src/mailhedgehog/config.py tests/test_config.py
uv run ruff check src/mailhedgehog/config.py tests/test_config.py
uv run mypy
git add src/mailhedgehog/config.py tests/test_config.py
git commit -m "feat(config): add remote-image proxy knobs (default off)"
```

---

### Task 2: SSRF-safe remote-image fetcher

**Files:**
- Create: `src/mailhedgehog/fetcher.py`
- Test: `tests/test_fetcher.py`

**Interfaces:**
- Consumes: nothing (knob values are passed in as arguments).
- Produces:
  - `class FetchError(Exception)`
  - `def is_public_ip(ip: str) -> bool`
  - `def fetch_remote_image(url: str, *, max_bytes: int, timeout: float, max_redirects: int, is_ip_allowed: Callable[[str], bool] = is_public_ip) -> tuple[bytes, str]`
    Returns `(content_bytes, safe_content_type)`; raises `FetchError` on any unsafe/failed fetch.

- [ ] **Step 1: Write the failing tests**

Create `tests/test_fetcher.py`:

```python
import socket
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

from mailhedgehog.fetcher import FetchError, fetch_remote_image, is_public_ip

# A 1x1 PNG.
PNG = bytes.fromhex(
    "89504e470d0a1a0a0000000d49484452000000010000000108020000009077"
    "53de0000000c4944415408d76360000000020001e221bc330000000049454e44ae426082"
)

# AIDEV-NOTE: permissive policy used by happy-path tests so the real fetch path
# can run against the loopback test server. The DEFAULT policy (is_public_ip)
# blocks loopback, which is exercised separately.
ALLOW_LOOPBACK = lambda ip: ip in {"127.0.0.1", "::1"}  # noqa: E731


class _Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):  # silence test server logging
        pass

    def do_GET(self):
        if self.path == "/img.png":
            self._send(200, "image/png", PNG)
        elif self.path == "/redirect":
            self.send_response(302)
            self.send_header("Location", "/img.png")
            self.end_headers()
        elif self.path == "/redirect-evil":
            self.send_response(302)
            # cloud-metadata address: must be rejected on the next hop
            self.send_header("Location", "http://169.254.169.254/latest/")
            self.end_headers()
        elif self.path == "/big":
            self._send(200, "image/png", b"\x00" * 5000)
        elif self.path == "/notimage":
            self._send(200, "text/html", b"<h1>nope</h1>")
        elif self.path == "/svg":
            self._send(200, "image/svg+xml", b"<svg></svg>")
        else:
            self._send(404, "text/plain", b"nope")

    def _send(self, code, ctype, body):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


@pytest.fixture
def server():
    srv = ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
    t = threading.Thread(target=srv.serve_forever, daemon=True)
    t.start()
    yield f"http://127.0.0.1:{srv.server_address[1]}"
    srv.shutdown()


@pytest.mark.parametrize(
    "ip,expected",
    [
        ("8.8.8.8", True),
        ("1.1.1.1", True),
        ("127.0.0.1", False),
        ("10.0.0.1", False),
        ("192.168.1.5", False),
        ("172.16.0.1", False),
        ("169.254.169.254", False),
        ("::1", False),
        ("fc00::1", False),
        ("not-an-ip", False),
    ],
)
def test_is_public_ip(ip, expected):
    assert is_public_ip(ip) is expected


def test_fetch_happy_path(server):
    data, ctype = fetch_remote_image(
        f"{server}/img.png",
        max_bytes=1_000_000,
        timeout=5,
        max_redirects=5,
        is_ip_allowed=ALLOW_LOOPBACK,
    )
    assert data == PNG
    assert ctype == "image/png"


def test_fetch_follows_redirect(server):
    data, ctype = fetch_remote_image(
        f"{server}/redirect",
        max_bytes=1_000_000,
        timeout=5,
        max_redirects=5,
        is_ip_allowed=ALLOW_LOOPBACK,
    )
    assert data == PNG


def test_fetch_redirect_to_blocked_ip_rejected(server):
    # First hop (loopback) allowed; redirect target 169.254.169.254 is not in the
    # permissive set, so the second hop is rejected.
    with pytest.raises(FetchError):
        fetch_remote_image(
            f"{server}/redirect-evil",
            max_bytes=1_000_000,
            timeout=5,
            max_redirects=5,
            is_ip_allowed=ALLOW_LOOPBACK,
        )


def test_fetch_too_large(server):
    with pytest.raises(FetchError):
        fetch_remote_image(
            f"{server}/big",
            max_bytes=1000,
            timeout=5,
            max_redirects=5,
            is_ip_allowed=ALLOW_LOOPBACK,
        )


def test_fetch_non_image_rejected(server):
    with pytest.raises(FetchError):
        fetch_remote_image(
            f"{server}/notimage",
            max_bytes=1_000_000,
            timeout=5,
            max_redirects=5,
            is_ip_allowed=ALLOW_LOOPBACK,
        )


def test_fetch_svg_downgraded(server):
    data, ctype = fetch_remote_image(
        f"{server}/svg",
        max_bytes=1_000_000,
        timeout=5,
        max_redirects=5,
        is_ip_allowed=ALLOW_LOOPBACK,
    )
    assert ctype == "application/octet-stream"


def test_fetch_default_policy_blocks_loopback(server):
    # Default is_ip_allowed=is_public_ip blocks 127.0.0.1.
    with pytest.raises(FetchError):
        fetch_remote_image(
            f"{server}/img.png", max_bytes=1_000_000, timeout=5, max_redirects=5
        )


def test_fetch_rejects_non_http_scheme():
    with pytest.raises(FetchError):
        fetch_remote_image(
            "file:///etc/passwd", max_bytes=1000, timeout=5, max_redirects=5
        )


def test_fetch_redirect_cap(server):
    # max_redirects=0 means the single 302 cannot be followed.
    with pytest.raises(FetchError):
        fetch_remote_image(
            f"{server}/redirect",
            max_bytes=1_000_000,
            timeout=5,
            max_redirects=0,
            is_ip_allowed=ALLOW_LOOPBACK,
        )
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `uv run pytest tests/test_fetcher.py -v`
Expected: FAIL (`ModuleNotFoundError: No module named 'mailhedgehog.fetcher'`).

- [ ] **Step 3: Implement the fetcher**

Create `src/mailhedgehog/fetcher.py`:

```python
"""SSRF-guarded fetch of remote images for the optional image proxy.

Standard library only — no new runtime dependencies. The public entry point is
fetch_remote_image(); it validates the URL scheme, refuses hosts that resolve to
internal/private addresses, follows redirects manually (re-validating each hop),
caps the response size, and requires an image/* content-type.
"""

from __future__ import annotations

import ipaddress
import socket
import urllib.error
import urllib.request
from collections.abc import Callable
from urllib.parse import urljoin, urlsplit

# AIDEV-NOTE: SECURITY-CRITICAL module. fetch_remote_image() is reachable from
# untrusted email content (the proxy rewrites email <img> URLs to it). Every
# hop's host is resolved and checked against is_ip_allowed BEFORE connecting.
# Residual risk: a small TOCTOU window exists because urllib re-resolves the host
# at connect time (DNS rebinding). Accepted for an operator-opted-in internal sink.

_ALLOWED_SCHEMES = {"http", "https"}
_CHUNK = 65536


class FetchError(Exception):
    """A remote image could not be safely fetched. Carries no sensitive detail."""


def is_public_ip(ip: str) -> bool:
    """Return True only for globally-routable unicast addresses.

    False for loopback, private (RFC1918 / ULA), link-local, multicast,
    reserved, and unspecified addresses — anything the proxy must not be tricked
    into fetching from an internal network (incl. cloud metadata 169.254.169.254).
    """
    try:
        addr = ipaddress.ip_address(ip)
    except ValueError:
        return False
    return not (
        addr.is_loopback
        or addr.is_private
        or addr.is_link_local
        or addr.is_multicast
        or addr.is_reserved
        or addr.is_unspecified
    )


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """Disable urllib's automatic redirect following.

    Returning None from redirect_request makes urllib raise HTTPError for a 3xx,
    which we catch and follow manually so each hop can be re-validated.
    """

    def redirect_request(self, req, fp, code, msg, headers, newurl):  # type: ignore[no-untyped-def]
        return None


def _check_host(host: str, port: int, is_ip_allowed: Callable[[str], bool]) -> None:
    """Raise FetchError unless every address the host resolves to is allowed."""
    try:
        infos = socket.getaddrinfo(host, port, proto=socket.IPPROTO_TCP)
    except socket.gaierror as exc:
        raise FetchError("dns resolution failed") from exc
    if not infos:
        raise FetchError("host did not resolve")
    for info in infos:
        ip = info[4][0]
        if not is_ip_allowed(ip):
            raise FetchError("host resolves to a disallowed address")


def fetch_remote_image(
    url: str,
    *,
    max_bytes: int,
    timeout: float,
    max_redirects: int,
    is_ip_allowed: Callable[[str], bool] = is_public_ip,
) -> tuple[bytes, str]:
    """Fetch a remote image safely.

    Returns (content_bytes, safe_content_type). Raises FetchError on a disallowed
    scheme/host, redirect to a disallowed host, too many redirects, network
    error, non-image content-type, or a body exceeding max_bytes.
    """
    opener = urllib.request.build_opener(_NoRedirect)
    current = url
    for _ in range(max_redirects + 1):
        parts = urlsplit(current)
        if parts.scheme not in _ALLOWED_SCHEMES:
            raise FetchError("scheme not allowed")
        host = parts.hostname
        if not host:
            raise FetchError("missing host")
        port = parts.port or (443 if parts.scheme == "https" else 80)
        _check_host(host, port, is_ip_allowed)

        req = urllib.request.Request(
            current, headers={"User-Agent": "mailhedgehog-image-proxy"}
        )
        try:
            resp = opener.open(req, timeout=timeout)
            status = resp.status
        except urllib.error.HTTPError as exc:
            # 3xx surfaces here because _NoRedirect declined to follow it.
            if 300 <= exc.code < 400:
                location = exc.headers.get("Location")
                exc.close()
                if not location:
                    raise FetchError("redirect without location") from exc
                current = urljoin(current, location)
                continue
            exc.close()
            raise FetchError("unexpected status") from exc
        except OSError as exc:
            raise FetchError("fetch failed") from exc

        try:
            if status != 200:
                raise FetchError("unexpected status")
            ctype = (resp.headers.get("Content-Type") or "").split(";")[0].strip().lower()
            if not ctype.startswith("image/"):
                raise FetchError("not an image")
            data = bytearray()
            while True:
                chunk = resp.read(_CHUNK)
                if not chunk:
                    break
                data.extend(chunk)
                if len(data) > max_bytes:
                    raise FetchError("image too large")
        finally:
            resp.close()

        # AIDEV-NOTE: SVG can carry script; mirror the cid endpoint and serve it
        # as octet-stream so it can never render as active content.
        safe_type = "application/octet-stream" if ctype == "image/svg+xml" else ctype
        return bytes(data), safe_type

    raise FetchError("too many redirects")
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `uv run pytest tests/test_fetcher.py -v`
Expected: PASS (all parametrized + scenario tests).

- [ ] **Step 5: Format, type-check, commit**

```bash
uv run ruff format src/mailhedgehog/fetcher.py tests/test_fetcher.py
uv run ruff check src/mailhedgehog/fetcher.py tests/test_fetcher.py
uv run mypy
git add src/mailhedgehog/fetcher.py tests/test_fetcher.py
git commit -m "feat(fetcher): SSRF-guarded remote-image fetch (stdlib only)"
```

---

### Task 3: Backend routes — `/api/v2/config` and `/api/v2/proxy`

**Files:**
- Modify: `src/mailhedgehog/web.py`
- Test: `tests/test_api_proxy.py`

**Interfaces:**
- Consumes: `Config.proxy_remote_images`, `Config.proxy_max_bytes`, `Config.proxy_timeout`, `Config.proxy_max_redirects` (Task 1); `fetch_remote_image`, `FetchError` (Task 2).
- Produces: `GET /api/v2/config` → `{"proxyRemoteImages": bool}`; `GET /api/v2/proxy?url=…` → image bytes (200) / 404 / 400 / 502.

- [ ] **Step 1: Write the failing tests**

Create `tests/test_api_proxy.py`:

```python
import pytest

from mailhedgehog.config import Config
from mailhedgehog.fetcher import FetchError
from mailhedgehog.storage import MessageStore
from mailhedgehog.web import create_app


def _app(**cfg):
    config = Config(smtp_port=0, http_port=0, **cfg)
    store = MessageStore(config.max_messages, config.max_bytes)
    return create_app(config, store)


async def test_config_endpoint_reports_flag_off():
    client = _app(proxy_remote_images=False).test_client()
    data = await (await client.get("/api/v2/config")).get_json()
    assert data == {"proxyRemoteImages": False}


async def test_config_endpoint_reports_flag_on():
    client = _app(proxy_remote_images=True).test_client()
    data = await (await client.get("/api/v2/config")).get_json()
    assert data == {"proxyRemoteImages": True}


async def test_proxy_404_when_disabled():
    client = _app(proxy_remote_images=False).test_client()
    resp = await client.get("/api/v2/proxy?url=http://example.com/a.png")
    assert resp.status_code == 404


async def test_proxy_400_when_url_missing():
    client = _app(proxy_remote_images=True).test_client()
    resp = await client.get("/api/v2/proxy")
    assert resp.status_code == 400


async def test_proxy_streams_image_when_enabled(monkeypatch):
    # AIDEV-NOTE: route test mocks the fetcher; SSRF behavior is covered by
    # tests/test_fetcher.py. This verifies wiring, status, and headers only.
    monkeypatch.setattr(
        "mailhedgehog.web.fetch_remote_image",
        lambda url, **kw: (b"\x89PNG-bytes", "image/png"),
    )
    client = _app(proxy_remote_images=True).test_client()
    resp = await client.get("/api/v2/proxy?url=http://example.com/a.png")
    assert resp.status_code == 200
    assert (await resp.get_data()) == b"\x89PNG-bytes"
    assert resp.headers["Content-Type"].startswith("image/png")
    assert resp.headers["X-Content-Type-Options"] == "nosniff"


async def test_proxy_502_on_fetch_error(monkeypatch):
    def boom(url, **kw):
        raise FetchError("blocked")

    monkeypatch.setattr("mailhedgehog.web.fetch_remote_image", boom)
    client = _app(proxy_remote_images=True).test_client()
    resp = await client.get("/api/v2/proxy?url=http://10.0.0.1/a.png")
    assert resp.status_code == 502
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `uv run pytest tests/test_api_proxy.py -v`
Expected: FAIL (404 from Quart for the unknown `/api/v2/config` and `/api/v2/proxy` routes / ImportError on `fetch_remote_image`).

- [ ] **Step 3: Implement the routes**

In `src/mailhedgehog/web.py`, extend the fetcher import:

```python
from mailhedgehog.fetcher import FetchError, fetch_remote_image
```

(Place it with the other `from mailhedgehog.parser import (...)` style imports near the top.)

Add these two routes inside `create_app`, e.g. right after the `search()` route:

```python
    @app.route("/api/v2/config")
    async def client_config() -> dict[str, object]:
        # AIDEV-NOTE: minimal bootstrap config the SPA reads once at startup.
        # Only exposes whether the image proxy is active so the UI knows to
        # rewrite remote <img> URLs. Additive; no auth (consistent with the API).
        return {"proxyRemoteImages": config.proxy_remote_images}

    @app.route("/api/v2/proxy")
    async def proxy_image() -> Response:
        # AIDEV-NOTE: opt-in remote-image proxy. Disabled -> 404 (capability off).
        # The actual fetch is SSRF-guarded in fetcher.py and offloaded to a
        # thread so a slow remote host can't stall the event loop. Any failure
        # collapses to 502 -> the browser shows the same broken-image icon as
        # when proxying is off (never worse). nosniff + short cache on success.
        if not config.proxy_remote_images:
            abort(404)
        url = request.args.get("url")
        if not url:
            abort(400)
        try:
            content, content_type = await asyncio.to_thread(
                fetch_remote_image,
                url,
                max_bytes=config.proxy_max_bytes,
                timeout=config.proxy_timeout,
                max_redirects=config.proxy_max_redirects,
            )
        except FetchError:
            abort(502)
        except Exception:
            # Defensive: never surface an unexpected fetch failure as a 500.
            abort(502)
        return Response(
            content,
            mimetype=content_type,
            headers={
                "X-Content-Type-Options": "nosniff",
                "Cache-Control": "private, max-age=300",
            },
        )
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `uv run pytest tests/test_api_proxy.py -v`
Expected: PASS.

- [ ] **Step 5: Run the full backend suite, format, type-check, commit**

```bash
uv run pytest
uv run ruff format src/mailhedgehog/web.py tests/test_api_proxy.py
uv run ruff check src/mailhedgehog/web.py tests/test_api_proxy.py
uv run mypy
git add src/mailhedgehog/web.py tests/test_api_proxy.py
git commit -m "feat(web): /api/v2/config and opt-in /api/v2/proxy image endpoint"
```

---

### Task 4: Frontend API client + store config flag + startup fetch

**Files:**
- Modify: `frontend/src/lib/api.ts`
- Modify: `frontend/src/lib/store.svelte.ts`
- Modify: `frontend/src/App.svelte`
- Test: `frontend/src/lib/api.test.ts`

**Interfaces:**
- Consumes: `GET /api/v2/config` (Task 3).
- Produces: `api.getConfig(): Promise<{ proxyRemoteImages: boolean }>`; `api.proxyUrl(rawUrl: string): string`; `store.proxyImages` (getter, boolean); `store.loadConfig(): Promise<void>`.

- [ ] **Step 1: Write the failing tests**

Add to `frontend/src/lib/api.test.ts` (and add `getConfig, proxyUrl` to its import on line 2):

```typescript
describe('getConfig', () => {
  it('fetches /api/v2/config and returns the shape', async () => {
    const mockFetch = makeFetchMock(200, { proxyRemoteImages: true });
    vi.stubGlobal('fetch', mockFetch);

    const cfg = await getConfig();

    const url: string = mockFetch.mock.calls[0][0] as string;
    expect(url).toBe('/api/v2/config');
    expect(cfg.proxyRemoteImages).toBe(true);
  });
});

describe('proxyUrl', () => {
  it('encodes the remote url into the proxy query param', () => {
    expect(proxyUrl('https://h.example/a b.png?x=1&y=2')).toBe(
      '/api/v2/proxy?url=https%3A%2F%2Fh.example%2Fa%20b.png%3Fx%3D1%26y%3D2',
    );
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd frontend && npx vitest run src/lib/api.test.ts`
Expected: FAIL (`getConfig`/`proxyUrl` are not exported).

- [ ] **Step 3: Implement `api.ts` additions**

Add to `frontend/src/lib/api.ts`:

```typescript
/** Fetch the SPA bootstrap config (currently just the image-proxy flag). */
export function getConfig(): Promise<{ proxyRemoteImages: boolean }> {
  return request<{ proxyRemoteImages: boolean }>('/api/v2/config');
}

/** URL to fetch a remote image through the server-side proxy. */
export function proxyUrl(rawUrl: string): string {
  return `/api/v2/proxy?url=${encodeURIComponent(rawUrl)}`;
}
```

- [ ] **Step 4: Run the api tests to verify they pass**

Run: `cd frontend && npx vitest run src/lib/api.test.ts`
Expected: PASS.

- [ ] **Step 5: Add the store flag + loadConfig**

In `frontend/src/lib/store.svelte.ts`:

Add a reactive field near the other `$state` declarations (e.g. after `let loading = $state(false);`):

```typescript
  // AIDEV-NOTE: proxyImages mirrors the server's MH_PROXY_REMOTE_IMAGES flag,
  // fetched once at startup via loadConfig(). When true, MessageDetail rewrites
  // remote <img> URLs through the proxy. Defaults false (direct load).
  let proxyImages = $state(false);
```

Add a method (near `loadFirst`):

```typescript
  // AIDEV-NOTE: loadConfig fetches the server bootstrap config once at startup.
  // On any failure it leaves proxyImages=false so images still attempt to load
  // directly — graceful degradation, never a hard error.
  async function loadConfig(): Promise<void> {
    try {
      const cfg = await api.getConfig();
      proxyImages = cfg.proxyRemoteImages;
    } catch {
      proxyImages = false;
    }
  }
```

Reset it in `resetForTest()` (add `proxyImages = false;` alongside the other resets).

Expose it in the returned object (add alongside the other getters/methods):

```typescript
    get proxyImages() { return proxyImages; },
    loadConfig,
```

- [ ] **Step 6: Wire startup in `App.svelte`**

In `frontend/src/App.svelte`, in the `onMount` callback, fetch config before loading the list. Change:

```svelte
  onMount(async () => {
    await store.loadFirst();
```

to:

```svelte
  onMount(async () => {
    await store.loadConfig();
    await store.loadFirst();
```

- [ ] **Step 7: Run the frontend checks**

Run: `cd frontend && npm run check && npx vitest run`
Expected: PASS (svelte-check clean; all vitest suites green).

- [ ] **Step 8: Commit**

```bash
git add frontend/src/lib/api.ts frontend/src/lib/api.test.ts frontend/src/lib/store.svelte.ts frontend/src/App.svelte
git commit -m "feat(ui): fetch proxy flag at startup; api getConfig/proxyUrl"
```

---

### Task 5: `buildSrcdoc` remote-image rewrite

**Files:**
- Modify: `frontend/src/lib/mime.ts`
- Modify: `frontend/src/components/MessageDetail.svelte`
- Test: `frontend/src/lib/mime.test.ts`

**Interfaces:**
- Consumes: `store.proxyImages`, `api.proxyUrl` (Task 4).
- Produces: new `buildSrcdoc` signature
  `buildSrcdoc(html: string, msgId: string, opts: { cidUrl: (id: string, cid: string) => string; proxyImages?: boolean; proxyUrl?: (url: string) => string }): string`.

- [ ] **Step 1: Update existing buildSrcdoc tests to the new signature, then add new tests**

In `frontend/src/lib/mime.test.ts`, the `buildSrcdoc` describe block currently calls `buildSrcdoc(html, 'msg1', mockCidUrl)`. Change the helper and every call in that block to pass an options object. Replace the `mockCidUrl` definition and update calls:

```typescript
  const mockCidUrl = (id: string, cid: string) =>
    `/api/v1/messages/${id}/mime/cid/${encodeURIComponent(cid)}/download`;
  const mockProxyUrl = (url: string) => `/api/v2/proxy?url=${encodeURIComponent(url)}`;
  const cidOpts = { cidUrl: mockCidUrl };
```

Then change each existing `buildSrcdoc(html, 'msgX', mockCidUrl)` call in that describe block to `buildSrcdoc(html, 'msgX', cidOpts)`. The existing assertions stay as-is — in particular this one still holds because proxying is OFF by default in `cidOpts`:

```typescript
  it('does NOT rewrite non-cid URLs', () => {
    const html = '<html><body><img src="https://example.com/img.png"></body></html>';
    const result = buildSrcdoc(html, 'msg1', cidOpts);
    expect(result).toContain('https://example.com/img.png');
  });
```

Add new tests in the same describe block:

```typescript
  it('rewrites remote http(s) img src to the proxy when proxyImages is on', () => {
    const html = '<html><body><img src="https://h.example/a.png"></body></html>';
    const result = buildSrcdoc(html, 'm', {
      cidUrl: mockCidUrl,
      proxyImages: true,
      proxyUrl: mockProxyUrl,
    });
    expect(result).toContain('/api/v2/proxy?url=https%3A%2F%2Fh.example%2Fa.png');
    expect(result).not.toContain('src="https://h.example/a.png"');
  });

  it('rewrites http img src too (not only https) when proxying', () => {
    const html = '<html><body><img src="http://h.example/a.png"></body></html>';
    const result = buildSrcdoc(html, 'm', {
      cidUrl: mockCidUrl,
      proxyImages: true,
      proxyUrl: mockProxyUrl,
    });
    expect(result).toContain('/api/v2/proxy?url=http%3A%2F%2Fh.example%2Fa.png');
  });

  it('does NOT proxy data: or blob: URLs', () => {
    const html =
      '<html><body><img src="data:image/png;base64,AAAA"><img src="blob:abc"></body></html>';
    const result = buildSrcdoc(html, 'm', {
      cidUrl: mockCidUrl,
      proxyImages: true,
      proxyUrl: mockProxyUrl,
    });
    expect(result).toContain('data:image/png;base64,AAAA');
    expect(result).toContain('blob:abc');
    expect(result).not.toContain('/api/v2/proxy');
  });

  it('proxies cid AND remote together: cid still goes to the cid endpoint', () => {
    const html =
      '<html><body><img src="cid:logo@x"><img src="https://h.example/a.png"></body></html>';
    const result = buildSrcdoc(html, 'm', {
      cidUrl: mockCidUrl,
      proxyImages: true,
      proxyUrl: mockProxyUrl,
    });
    expect(result).toContain('/api/v1/messages/m/mime/cid/');
    expect(result).toContain('/api/v2/proxy?url=https%3A%2F%2Fh.example%2Fa.png');
    expect(result).not.toContain('cid:logo');
  });

  it('proxies srcset entries and inline style url() when proxying', () => {
    const html =
      '<html><body>' +
      '<img srcset="https://h.example/a.png 1x, https://h.example/b.png 2x">' +
      '<div style="background:url(https://h.example/c.png)"></div>' +
      '</body></html>';
    const result = buildSrcdoc(html, 'm', {
      cidUrl: mockCidUrl,
      proxyImages: true,
      proxyUrl: mockProxyUrl,
    });
    expect(result).toContain('/api/v2/proxy?url=https%3A%2F%2Fh.example%2Fa.png');
    expect(result).toContain('/api/v2/proxy?url=https%3A%2F%2Fh.example%2Fb.png');
    expect(result).toContain('/api/v2/proxy?url=https%3A%2F%2Fh.example%2Fc.png');
  });

  it('leaves remote img direct when proxyImages is off', () => {
    const html = '<html><body><img src="https://h.example/a.png"></body></html>';
    const result = buildSrcdoc(html, 'm', { cidUrl: mockCidUrl, proxyImages: false });
    expect(result).toContain('https://h.example/a.png');
    expect(result).not.toContain('/api/v2/proxy');
  });
```

- [ ] **Step 2: Run the mime tests to verify they fail**

Run: `cd frontend && npx vitest run src/lib/mime.test.ts`
Expected: FAIL — both compile/type errors on the new options-object calls and the new proxy assertions (signature still takes a function).

- [ ] **Step 3: Update `buildSrcdoc` to the options object + remote-image rewriting**

In `frontend/src/lib/mime.ts`, change the `buildSrcdoc` signature and body. Replace the current signature/JSDoc and the cid-rewrite call:

```typescript
export interface SrcdocOptions {
  cidUrl: (id: string, cid: string) => string;
  proxyImages?: boolean;
  proxyUrl?: (url: string) => string;
}

/**
 * Sanitize an HTML email body for use in a sandboxed iframe srcdoc.
 *
 * Security operations:
 * 1. Remove all <script> elements
 * 2. Remove all <base> elements
 * 3. Rewrite cid: references to same-origin API URLs
 * 4. If opts.proxyImages, rewrite remaining http(s) image refs to the proxy
 * 5. Inject the CSP meta tag as first child of <head>
 */
export function buildSrcdoc(
  html: string,
  msgId: string,
  opts: SrcdocOptions,
): string {
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');

  // --- Step 1: Remove all <script> elements ---
  doc.querySelectorAll('script').forEach((el) => el.remove());

  // --- Step 2: Remove all <base> elements ---
  doc.querySelectorAll('base').forEach((el) => el.remove());

  // --- Step 3: Rewrite cid: references ---
  rewriteCidRefs(doc, msgId, opts.cidUrl);

  // --- Step 4: Proxy remaining remote images (opt-in) ---
  // AIDEV-NOTE: runs AFTER cid rewriting, so cid refs (now /api/...) are not
  // re-touched. Only http(s) values are proxied; data:/blob: are left alone.
  if (opts.proxyImages && opts.proxyUrl) {
    rewriteRemoteImages(doc, opts.proxyUrl);
  }

  // --- Step 5: Inject CSP meta tag as first child of <head> ---
  const cspMeta = doc.createElement('meta');
  cspMeta.setAttribute('http-equiv', 'Content-Security-Policy');
  cspMeta.setAttribute('content', EMAIL_CSP);
  const head = doc.head;
  head.insertBefore(cspMeta, head.firstChild);

  return `<!doctype html>${doc.documentElement.outerHTML}`;
}
```

Add a new helper after `rewriteCidRefs` (reusing the same attribute/srcset/style surfaces):

```typescript
/**
 * Rewrite remote http(s) image references to the same-origin proxy.
 * Mirrors rewriteCidRefs' surfaces: src/poster, srcset, inline style url().
 * Leaves cid-rewritten (/api/...), data:, blob:, and relative URLs untouched.
 */
function rewriteRemoteImages(doc: Document, proxyUrl: (url: string) => string): void {
  const isRemote = (v: string): boolean => /^https?:\/\//i.test(v.trim());

  for (const attr of ['src', 'poster']) {
    doc.querySelectorAll(`[${attr}]`).forEach((el) => {
      const val = el.getAttribute(attr) ?? '';
      if (isRemote(val)) el.setAttribute(attr, proxyUrl(val.trim()));
    });
  }

  doc.querySelectorAll('[srcset]').forEach((el) => {
    const srcset = el.getAttribute('srcset') ?? '';
    const rewritten = srcset
      .split(',')
      .map((entry) => {
        const parts = entry.trim().split(/\s+/);
        if (parts.length > 0 && isRemote(parts[0])) {
          parts[0] = proxyUrl(parts[0]);
        }
        return parts.join(' ');
      })
      .join(', ');
    if (rewritten !== srcset) el.setAttribute('srcset', rewritten);
  });

  doc.querySelectorAll('[style]').forEach((el) => {
    const style = el.getAttribute('style') ?? '';
    const rewritten = style.replace(
      /url\(\s*(['"]?)(https?:\/\/[^'")\s]+)\1\s*\)/gi,
      (_, _q: string, u: string) => `url(${proxyUrl(u)})`,
    );
    if (rewritten !== style) el.setAttribute('style', rewritten);
  });
}
```

- [ ] **Step 4: Update the `MessageDetail.svelte` call site**

In `frontend/src/components/MessageDetail.svelte`:

Add `store` is already imported and `proxyUrl` needs importing. Change the api import line:

```svelte
  import { emlUrl, partUrl, cidUrl, proxyUrl } from '../lib/api.js';
```

Change the `buildSrcdoc` call in `buildHtmlTab()` from:

```typescript
        srcdocCache = buildSrcdoc(html, msgId, cidUrl);
```

to:

```typescript
        srcdocCache = buildSrcdoc(html, msgId, {
          cidUrl,
          proxyImages: store.proxyImages,
          proxyUrl,
        });
```

- [ ] **Step 5: Run frontend checks to verify all pass**

Run: `cd frontend && npm run check && npx vitest run`
Expected: PASS (svelte-check clean; mime + all suites green).

- [ ] **Step 6: Commit**

```bash
git add frontend/src/lib/mime.ts frontend/src/lib/mime.test.ts frontend/src/components/MessageDetail.svelte
git commit -m "feat(ui): proxy remote email images via buildSrcdoc when enabled"
```

---

### Task 6: Rebuild committed bundle, document, and verify all gates

**Files:**
- Modify: `src/mailhedgehog/static/app/app.js`, `src/mailhedgehog/static/app/app.css` (regenerated build output)
- Modify: `README.md`

**Interfaces:**
- Consumes: all prior tasks.
- Produces: in-sync committed build; documented env vars.

- [ ] **Step 1: Rebuild the committed Svelte bundle**

Run: `cd frontend && npm run build`
Expected: writes `../src/mailhedgehog/static/app/` (app.js / app.css / index.html / images). The CSP and cid logic plus the new proxy rewrite are now in the bundle.

- [ ] **Step 2: Confirm the build is reflected and the bundle contains the proxy path**

Run: `grep -c "api/v2/proxy" src/mailhedgehog/static/app/app.js`
Expected: `>= 1` (the proxy URL builder is present in the bundle).

- [ ] **Step 3: Document the env vars in README**

In `README.md`, add to the environment/configuration section (next to `MH_MAX_MESSAGES` etc.) a remote-image-proxy subsection. Use this content:

```markdown
### Remote image proxy (optional)

Email HTML often references images on remote hosts. By default mailhedgehog
lets your **browser** fetch them directly. If the machine viewing the UI cannot
reach those hosts (but the mailhedgehog server can), enable the server-side
image proxy: mailhedgehog fetches each remote `<img>` and streams it back
same-origin, so images render regardless of the browser's network.

| Env var | Default | Meaning |
| --- | --- | --- |
| `MH_PROXY_REMOTE_IMAGES` | `false` | Master switch for the image proxy. |
| `MH_PROXY_TIMEOUT` | `10.0` | Per-image fetch timeout (seconds). |
| `MH_PROXY_MAX_BYTES` | `10485760` | Per-image size cap (bytes; 10 MB). |
| `MH_PROXY_MAX_REDIRECTS` | `5` | Max redirect hops followed per image. |

Security: the proxy fetches `http(s)` URLs only and **refuses hosts that
resolve to loopback / private / link-local / reserved addresses** (including
cloud metadata `169.254.169.254`), re-checking on every redirect hop. SVG is
served as `application/octet-stream`. It does not fully defend against an
attacker who actively rebinds DNS between validation and connect; enable it on
trusted/internal sinks where that residual risk is acceptable.
```

- [ ] **Step 4: Run the full gate suite**

```bash
uv run pytest
uv run ruff check . && uv run ruff format --check . && uv run mypy
cd frontend && npm run check && npx vitest run && npm run build && cd ..
git diff --exit-code -- src/mailhedgehog/static/app
```

Expected: backend suite green; ruff/format/mypy clean; frontend check + vitest green; `npm run build` clean; the final `git diff --exit-code` prints nothing (committed build matches a fresh rebuild — the CI drift guard will pass).

- [ ] **Step 5: Commit**

```bash
git add src/mailhedgehog/static/app README.md
git commit -m "build(ui): rebuild bundle with image proxy; document MH_PROXY_* env"
```

---

## Self-Review

**Spec coverage:**
- Config knobs (4 env vars + defaults + validation) → Task 1. ✓
- SSRF-safe fetcher (scheme allowlist, per-hop IP block, size cap, timeout, image-only, svg downgrade, injectable policy) → Task 2. ✓
- `/api/v2/config` + `/api/v2/proxy` (404/400/502/200 + nosniff + cache; route tests mock the fetcher) → Task 3. ✓
- Frontend `getConfig`/`proxyUrl`, store flag, startup fetch with graceful default → Task 4. ✓
- `buildSrcdoc` options object + remote-image rewrite (src/srcset/poster/style; leave cid/data/blob) + MessageDetail wiring → Task 5. ✓
- Rebuild committed bundle + README docs + drift verification → Task 6. ✓
- "No new runtime deps", "default off", "additive/MailHog-compatible" → Global Constraints, honored across tasks. ✓

**Placeholder scan:** No TBD/TODO; every code step shows complete code; every command has an expected result.

**Type consistency:** `buildSrcdoc(html, msgId, opts)` options shape (`{ cidUrl, proxyImages?, proxyUrl? }`) is identical in Task 5's interface, implementation, MessageDetail call, and tests. `fetch_remote_image(url, *, max_bytes, timeout, max_redirects, is_ip_allowed=is_public_ip)` is identical across Task 2's interface, implementation, Task 3's call (keyword args, default policy), and tests. `getConfig()`/`proxyUrl()` and `store.proxyImages`/`store.loadConfig()` match between Task 4's interface, implementation, and Task 5's consumption. Config field names match between Task 1 and Task 3's usage.

**Execution order:** 1 → 2 → 3 → 4 → 5 → 6 (each consumes only earlier tasks).
