"""Quart application factory: HTTP API, websocket, and SMTP lifecycle."""

from __future__ import annotations

from pathlib import Path

from quart import Quart, Response, abort, request

from mailhedgehog.config import Config
from mailhedgehog.parser import get_mime_part
from mailhedgehog.storage import MessageStore

_PKG = Path(__file__).parent


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
        start = request.args.get("start", 0, type=int)
        limit = request.args.get("limit", 50, type=int)
        items, total = store.list(start, limit)
        return {
            "total": total,
            "count": len(items),
            "start": max(start, 0),
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
        start = request.args.get("start", 0, type=int)
        limit = request.args.get("limit", 50, type=int)
        items, total = store.search(kind, query, start, limit)
        return {
            "total": total,
            "count": len(items),
            "start": max(start, 0),
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
            disposition += f'; filename="{filename}"'
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

    return app
