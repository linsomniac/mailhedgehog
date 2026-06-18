"""Quart application factory: HTTP API, websocket, and SMTP lifecycle."""

from __future__ import annotations

import asyncio
import json
from pathlib import Path

from quart import Quart, Response, abort, request, websocket

from mailhedgehog.config import Config
from mailhedgehog.parser import Message, get_mime_part
from mailhedgehog.smtp import SmtpHandler, create_smtp_server
from mailhedgehog.storage import KNOWN_SEARCH_KINDS, MessageStore

# AIDEV-NOTE: hard cap on page size to keep list and search responses bounded.
# Requests with limit > MAX_PAGE_LIMIT are silently clamped, not rejected.
MAX_PAGE_LIMIT = 200

_PKG = Path(__file__).parent


# AIDEV-NOTE: bounded per-client queues. A slow/dead UI client drops live frames
# (it reconciles on the next /api/v2/messages refresh) and can never grow memory.
class WebSocketBroadcaster:
    def __init__(self, queue_size: int) -> None:
        self._queue_size = queue_size
        self._clients: set[asyncio.Queue[str]] = set()

    def register(self) -> asyncio.Queue[str]:
        queue: asyncio.Queue[str] = asyncio.Queue(maxsize=self._queue_size)
        self._clients.add(queue)
        return queue

    def unregister(self, queue: asyncio.Queue[str]) -> None:
        self._clients.discard(queue)

    async def broadcast(self, message: Message) -> None:
        data = json.dumps(message)
        for queue in list(self._clients):
            try:
                queue.put_nowait(data)
            except asyncio.QueueFull:
                pass


def create_app(config: Config, store: MessageStore) -> Quart:
    app = Quart(
        __name__,
        static_folder=str(_PKG / "static"),
        static_url_path="/static",
    )

    @app.route("/")
    async def index() -> str:
        return (_PKG / "templates" / "index.html").read_text()

    @app.route("/api/v2/messages")
    async def list_messages() -> dict[str, object]:
        start = max(request.args.get("start", 0, type=int), 0)
        limit = min(max(request.args.get("limit", 50, type=int), 0), MAX_PAGE_LIMIT)
        items, total = store.list(start, limit)
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
        return {
            "total": total,
            "count": len(items),
            "start": start,
            "items": items,
        }

    @app.route("/api/v1/messages/<msgid>/download")
    async def download(msgid: str) -> Response:
        raw = store.get_raw(msgid)
        if raw is None:
            abort(404)
        return Response(
            raw,
            mimetype="message/rfc822",
            headers={"Content-Disposition": f'attachment; filename="{msgid}.eml"'},
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
            content, mimetype=content_type, headers={"Content-Disposition": disposition}
        )

    # AIDEV-NOTE: "release"/outgoing-smtp are intentionally unimplemented (a sink has
    # no relay). Stub them so the UI's Release modal opens without console errors.
    @app.route("/api/v2/outgoing-smtp")
    async def outgoing_smtp() -> list[object]:
        return []

    @app.route("/api/v1/messages/<msgid>/release", methods=["POST"])
    async def release(msgid: str) -> tuple[str, int]:
        return "Not Implemented", 501

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
        queue = broadcaster.register()
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
