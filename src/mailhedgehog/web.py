"""Quart application factory: HTTP API, websocket, and SMTP lifecycle."""

from __future__ import annotations

from pathlib import Path

from quart import Quart, abort, request

from mailhedgehog.config import Config
from mailhedgehog.storage import MessageStore

_WEB = Path(__file__).parent / "web"


def create_app(config: Config, store: MessageStore) -> Quart:
    app = Quart(
        __name__,
        static_folder=str(_WEB / "static"),
        static_url_path="/static",
    )

    @app.route("/")
    async def index() -> str:
        return (_WEB / "templates" / "index.html").read_text()

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

    return app
