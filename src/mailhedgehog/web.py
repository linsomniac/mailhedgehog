"""Quart application factory: HTTP API, websocket, and SMTP lifecycle."""

from __future__ import annotations

import asyncio
import json
from pathlib import Path

from quart import Quart, Response, abort, request, websocket

from mailhedgehog.config import Config
from mailhedgehog.fetcher import FetchError, fetch_remote_image
from mailhedgehog.parser import (
    Message,
    decode_header_value,
    get_mime_part,
    get_mime_part_by_cid,
)
from mailhedgehog.smtp import SmtpHandler, create_smtp_server
from mailhedgehog.storage import KNOWN_SEARCH_KINDS, MessageStore

# AIDEV-NOTE: hard cap on page size to keep list and search responses bounded.
# Requests with limit > MAX_PAGE_LIMIT are silently clamped, not rejected.
MAX_PAGE_LIMIT = 200


# AIDEV-NOTE: to_summary produces the slim 7-key projection used by ?summary=1.
# Full address dicts are kept unchanged (the UI needs Mailbox+Domain for display).
# To is truncated to 3 entries; ToCount carries the real total so the UI can
# show "and N more" without fetching the full message.
def to_summary(message: Message) -> dict[str, object]:
    """Return a slim 7-key projection of a full message dict.

    Keys: ID, From, To (max 3), ToCount, Subject (RFC-2047 decoded), Created, Size.
    """
    headers: dict[str, list[str]] = message.get("Content", {}).get("Headers", {})
    raw_subject: str = (headers.get("Subject") or [""])[0]
    subject: str = decode_header_value(raw_subject)
    to_list: list[object] = message.get("To") or []
    return {
        "ID": message["ID"],
        "From": message["From"],
        "To": to_list[:3],
        "ToCount": len(to_list),
        "Subject": subject,
        "Created": message["Created"],
        "Size": message["Content"]["Size"],
    }


_PKG = Path(__file__).parent


# AIDEV-NOTE: bounded per-client queues. A slow/dead UI client drops live frames
# (it reconciles on the next /api/v2/messages refresh) and can never grow memory.
# Each client is stored in _clients dict as queue -> wants_summary bool.
# to_summary() is only called lazily when at least one summary client is registered.
class WebSocketBroadcaster:
    def __init__(self, queue_size: int) -> None:
        self._queue_size = queue_size
        self._clients: dict[asyncio.Queue[str], bool] = {}

    def register(self, summary: bool = False) -> asyncio.Queue[str]:
        queue: asyncio.Queue[str] = asyncio.Queue(maxsize=self._queue_size)
        self._clients[queue] = summary
        return queue

    def unregister(self, queue: asyncio.Queue[str]) -> None:
        self._clients.pop(queue, None)

    async def broadcast(self, message: Message) -> None:
        full = json.dumps(message)
        # AIDEV-NOTE: compute slim JSON lazily — only if at least one summary client
        # is registered. Avoids calling to_summary() on every broadcast when nobody
        # has subscribed with ?summary=1 (the common/default case).
        slim: str | None = None
        if any(self._clients.values()):
            slim = json.dumps(to_summary(message))
        for queue, wants_summary in list(self._clients.items()):
            data = slim if wants_summary and slim is not None else full
            try:
                queue.put_nowait(data)
            except asyncio.QueueFull:
                pass


def _is_summary(value: str | None) -> bool:
    """Return True when the ?summary query-param is truthy.

    Accepted truthy values: "1" or "true" (case-insensitive).
    """
    return (value or "").lower() in {"1", "true"}


def create_app(config: Config, store: MessageStore) -> Quart:
    app = Quart(
        __name__,
        static_folder=str(_PKG / "static"),
        static_url_path="/static",
    )

    @app.route("/")
    async def index() -> Response:
        # AIDEV-NOTE: serve the built Svelte SPA bundle; no-cache so browsers always
        # re-validate the HTML after an upgrade (filenames are stable, not hashed).
        html = (_PKG / "static" / "app" / "index.html").read_text()
        return Response(
            html, mimetype="text/html", headers={"Cache-Control": "no-cache"}
        )

    @app.route("/api/v2/messages")
    async def list_messages() -> dict[str, object]:
        start = max(request.args.get("start", 0, type=int), 0)
        limit = min(max(request.args.get("limit", 50, type=int), 0), MAX_PAGE_LIMIT)
        items, total = store.list(start, limit)
        if _is_summary(request.args.get("summary")):
            items = [to_summary(m) for m in items]
        return {
            "total": total,
            "count": len(items),
            "start": start,
            "items": items,
        }

    @app.route("/api/v1/messages/<msgid>")
    async def get_message(msgid: str) -> dict[str, object]:
        message = store.get(msgid)
        if message is None:
            abort(404)
        return message

    @app.route("/api/v1/messages", methods=["DELETE"])
    async def delete_all() -> str:
        store.clear()
        return "OK"

    @app.route("/api/v1/messages/<msgid>", methods=["DELETE"])
    async def delete_one(msgid: str) -> str:
        if not store.delete(msgid):
            abort(404)
        return "OK"

    @app.route("/api/v2/search")
    async def search() -> dict[str, object]:
        kind = request.args.get("kind", "containing")
        query = request.args.get("query", "")
        start = max(request.args.get("start", 0, type=int), 0)
        limit = min(max(request.args.get("limit", 50, type=int), 0), MAX_PAGE_LIMIT)
        # AIDEV-NOTE: validate kind BEFORE spawning a thread so bad requests fail fast.
        if kind not in KNOWN_SEARCH_KINDS:
            abort(400)
        # AIDEV-NOTE: body search ("containing") can be CPU-heavy on large stores.
        # Run the entire scan off the event loop so the ASGI worker stays unblocked.
        items, total = await asyncio.to_thread(store.search, kind, query, start, limit)
        if _is_summary(request.args.get("summary")):
            items = [to_summary(m) for m in items]
        return {
            "total": total,
            "count": len(items),
            "start": start,
            "items": items,
        }

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
            return Response(
                content,
                mimetype=content_type,
                headers={
                    "X-Content-Type-Options": "nosniff",
                    "Cache-Control": "private, max-age=300",
                },
            )
        except FetchError:
            abort(502)
        except Exception:
            # Defensive: never surface an unexpected fetch failure as a 500.
            # This also catches ValueError from Response(mimetype=...) if a
            # malformed content-type somehow passes through Layer 1 validation.
            abort(502)

    @app.route("/api/v1/messages/<msgid>/download")
    async def download(msgid: str) -> Response:
        raw = store.get_raw(msgid)
        if raw is None:
            abort(404)
        return Response(
            raw,
            mimetype="message/rfc822",
            headers={
                "Content-Disposition": f'attachment; filename="{msgid}.eml"',
                "X-Content-Type-Options": "nosniff",
            },
        )

    @app.route("/api/v1/messages/<msgid>/mime/part/<int:part>/download")
    async def download_part(msgid: str, part: int) -> Response:
        raw = store.get_raw(msgid)
        if raw is None:
            abort(404)
        result = get_mime_part(raw, part)
        if result is None:
            abort(404)
        content, content_type, filename = result
        disposition = "attachment"
        if filename:
            # AIDEV-NOTE: filename is attacker-controlled (RFC 2231 filename* can decode
            # to CR/LF or quote chars). Strip control chars and quoting chars so the
            # Content-Disposition header can't be broken or rejected by the ASGI layer.
            safe_name = "".join(
                c for c in filename if c.isprintable() and c not in '"\\'
            )
            if safe_name:
                disposition += f'; filename="{safe_name}"'
        return Response(
            content,
            mimetype=content_type,
            headers={
                "Content-Disposition": disposition,
                "X-Content-Type-Options": "nosniff",
            },
        )

    # AIDEV-NOTE: cid-based part lookup walks the full MIME tree (unlike the
    # index-based route which only addresses top-level parts). Non-image content
    # types are downgraded to application/octet-stream so that attacker-supplied
    # text/html or image/svg+xml parts cannot execute same-origin scripts.
    @app.route("/api/v1/messages/<msgid>/mime/cid/<path:cid>/download")
    async def download_cid_part(msgid: str, cid: str) -> Response:
        raw = store.get_raw(msgid)
        if raw is None:
            abort(404)
        result = get_mime_part_by_cid(raw, cid)
        if result is None:
            abort(404)
        content, content_type, _filename = result
        # Only raster image/* types keep their declared type; image/svg+xml
        # (script-capable) and all other types are served as application/octet-stream
        # so a malicious part can't be rendered as active content.
        content_type_lower = content_type.lower()
        safe_type = (
            content_type
            if (
                content_type_lower.startswith("image/")
                and content_type_lower != "image/svg+xml"
            )
            else "application/octet-stream"
        )
        return Response(
            content,
            mimetype=safe_type,
            headers={"X-Content-Type-Options": "nosniff"},
        )

    # AIDEV-NOTE: "release"/outgoing-smtp are intentionally unimplemented (a sink has
    # no relay). Stub them so the UI's Release modal opens without console errors.
    @app.route("/api/v2/outgoing-smtp")
    async def outgoing_smtp() -> list[object]:
        return []

    @app.route("/api/v1/messages/<msgid>/release", methods=["POST"])
    async def release(msgid: str) -> tuple[str, int]:
        return "Not Implemented", 501

    # AIDEV-NOTE: after_request is the single place we stamp security headers on
    # every HTTP response. X-Content-Type-Options: nosniff prevents browsers from
    # MIME-sniffing a response away from the declared content-type.
    #
    # SECURITY-CRITICAL — why this CSP permits inline styles + remote img/font/media:
    # The HTML-email preview renders in a sandboxed srcdoc iframe (frontend
    # MessageDetail + mime.buildSrcdoc), and a srcdoc document's effective CSP is the
    # INTERSECTION of this parent policy and the per-email policy injected into the
    # srcdoc. So this parent policy must be a SUPERSET of what an email legitimately
    # needs, or it silently strips ALL email CSS and blocks remote images — making
    # every HTML email render with unreadable browser defaults. We therefore allow
    # 'unsafe-inline' styles and remote img/font/media HERE, and rely on the per-email
    # srcdoc CSP (script-src 'none', form-action 'none', object/frame/base locked) to
    # keep the untrusted email itself sandboxed. script-src stays 'self' so the app
    # shell never executes inline or remote scripts; the sandboxed email never executes
    # scripts at all (its own CSP forbids it AND the iframe has no allow-scripts).
    _CSP = (
        "default-src 'self'; "
        "script-src 'self'; "
        "style-src 'self' 'unsafe-inline' https: http:; "
        "img-src 'self' data: blob: https: http:; "
        "font-src 'self' data: https: http:; "
        "media-src 'self' https: http:; "
        "object-src 'none'; "
        "base-uri 'none'; "
        "frame-ancestors 'self'"
    )

    @app.after_request
    async def _security_headers(response: Response) -> Response:
        response.headers.setdefault("X-Content-Type-Options", "nosniff")
        response.headers.setdefault("Content-Security-Policy", _CSP)
        # AIDEV-NOTE: force revalidation of the SPA bundle on every request so
        # browsers never serve a stale app.js / app.css after an upgrade.  Asset
        # filenames are stable (not content-hashed), so Quart's default
        # max-age=43200 would silently serve old JS.  ETag/Last-Modified are still
        # set by Quart's static handler, yielding cheap 304s instead of re-downloads.
        if request.path.startswith("/static/app/"):
            response.headers["Cache-Control"] = "no-cache"
        return response

    broadcaster = WebSocketBroadcaster(config.ws_queue_size)
    app.broadcaster = broadcaster  # type: ignore[attr-defined]
    smtp_server: list[asyncio.AbstractServer] = []

    @app.websocket("/api/v2/websocket")
    async def ws() -> None:
        # AIDEV-NOTE: accept up front so the HTTP 101 handshake completes
        # immediately. Quart otherwise defers accept() until the first send(),
        # which never runs while the queue is empty -- leaving the browser stuck
        # showing "Disconnected" until the first email arrives.
        await websocket.accept()
        summary = _is_summary(websocket.args.get("summary"))
        queue = broadcaster.register(summary=summary)
        try:
            while True:
                await websocket.send(await queue.get())
        finally:
            broadcaster.unregister(queue)

    @app.before_serving
    async def _start_smtp() -> None:
        handler = SmtpHandler(store, broadcaster.broadcast)
        server = await create_smtp_server(
            asyncio.get_running_loop(),
            handler,
            config.smtp_host,
            config.smtp_port,
            config.max_message_size,
        )
        smtp_server.append(server)

    @app.after_serving
    async def _stop_smtp() -> None:
        for server in smtp_server:
            server.close()
            await server.wait_closed()

    return app
