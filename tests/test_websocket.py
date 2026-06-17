import asyncio
import json

import pytest

from mailhedgehog.config import Config
from mailhedgehog.storage import MessageStore
from mailhedgehog.web import WebSocketBroadcaster, create_app


async def test_broadcaster_is_bounded():
    b = WebSocketBroadcaster(queue_size=2)
    q = b.register()
    for i in range(5):
        await b.broadcast({"ID": str(i)})
    assert q.qsize() == 2  # excess dropped, no unbounded growth
    b.unregister(q)


async def test_broadcaster_delivers_to_registered_clients():
    b = WebSocketBroadcaster(queue_size=10)
    q = b.register()
    await b.broadcast({"ID": "abc"})
    assert json.loads(q.get_nowait())["ID"] == "abc"


async def test_unregister_stops_delivery():
    b = WebSocketBroadcaster(queue_size=10)
    q = b.register()
    b.unregister(q)
    await b.broadcast({"ID": "x"})
    assert q.empty()


@pytest.fixture
def app_and_store():
    config = Config(smtp_port=0, http_port=0, ws_queue_size=10)
    store = MessageStore(config.max_messages, config.max_bytes)
    return create_app(config, store), store


async def test_websocket_receives_broadcast(app_and_store):
    app, _ = app_and_store
    client = app.test_client()
    async with client.websocket("/api/v2/websocket") as ws:
        await asyncio.sleep(0)  # let the handler task enter Quart's ASGI dispatch
        await asyncio.sleep(0)  # let the handler reach broadcaster.register()
        await app.broadcaster.broadcast({"ID": "live"})
        data = json.loads(await ws.receive())
        assert data["ID"] == "live"
