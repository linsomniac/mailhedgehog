import asyncio
import base64
import json
import os
import socket

import pytest

from mailhedgehog.config import Config
from mailhedgehog.parser import parse
from mailhedgehog.storage import MessageStore
from mailhedgehog.web import WebSocketBroadcaster, create_app
from tests.sample_emails import ASCII

# AIDEV-NOTE: Realistic full message used by slim-frame tests. parse() produces
# the full 7-top-key shape that to_summary() expects (ID, From, To, Content, ...).
_FULL_MSG = parse(ASCII, "alice@example.com", ["bob@example.com"], None)

# Keys that to_summary always returns (7-key slim projection).
_SLIM_KEYS = {"ID", "From", "To", "ToCount", "Subject", "Created", "Size"}


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


async def test_websocket_accepts_before_any_broadcast(app_and_store):
    # AIDEV-NOTE: regression for "Disconnected" UI bug. Quart only sends the
    # websocket.accept (HTTP 101) handshake on the first send()/receive() or an
    # explicit accept(). The handler must accept up front; otherwise it blocks on
    # an empty queue and the browser never sees the connection open.
    app, _ = app_and_store
    client = app.test_client()
    async with client.websocket("/api/v2/websocket") as ws:
        for _ in range(100):
            if ws.accepted:
                break
            await asyncio.sleep(0.01)
        assert ws.accepted, "handler must accept the websocket before any broadcast"


async def test_websocket_receives_broadcast(app_and_store):
    app, _ = app_and_store
    client = app.test_client()
    async with client.websocket("/api/v2/websocket") as ws:
        await asyncio.sleep(0)  # let the handler task enter Quart's ASGI dispatch
        await asyncio.sleep(0)  # let the handler reach broadcaster.register()
        await app.broadcaster.broadcast({"ID": "live"})
        data = json.loads(await asyncio.wait_for(ws.receive(), timeout=2.0))
        assert data["ID"] == "live"


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
    except TimeoutError:
        return False
    finally:
        s.close()


def _free_port() -> int:
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port: int = s.getsockname()[1]
    s.close()
    return port


async def test_server_emits_websocket_ping_when_idle() -> None:
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


# ---------------------------------------------------------------------------
# Task 4 (B4): opt-in slim ?summary=1 frames
# ---------------------------------------------------------------------------


async def test_broadcaster_slim_client_receives_slim_frame():
    """A client registered with summary=True gets the 7-key slim projection."""
    b = WebSocketBroadcaster(queue_size=10)
    q = b.register(summary=True)
    await b.broadcast(_FULL_MSG)
    frame = json.loads(q.get_nowait())
    assert set(frame.keys()) == _SLIM_KEYS, (
        f"expected slim keys, got {set(frame.keys())}"
    )


async def test_broadcaster_full_client_receives_full_frame():
    """A client registered with summary=False (default) gets all message keys."""
    b = WebSocketBroadcaster(queue_size=10)
    q = b.register(summary=False)
    await b.broadcast(_FULL_MSG)
    frame = json.loads(q.get_nowait())
    # Full message has keys beyond the slim set (e.g. Content, MIME, Raw).
    assert "Content" in frame and "Raw" in frame, (
        "full frame must include Content and Raw"
    )


async def test_broadcaster_default_register_receives_full_frame():
    """register() with no args still delivers the full frame (backward compat)."""
    b = WebSocketBroadcaster(queue_size=10)
    q = b.register()
    await b.broadcast(_FULL_MSG)
    frame = json.loads(q.get_nowait())
    assert "Content" in frame and "Raw" in frame, (
        "default register() must deliver full frame"
    )


async def test_broadcaster_mixed_clients_each_get_correct_frame():
    """One slim and one full client receive different frames from same broadcast."""
    b = WebSocketBroadcaster(queue_size=10)
    q_slim = b.register(summary=True)
    q_full = b.register(summary=False)
    await b.broadcast(_FULL_MSG)
    slim_frame = json.loads(q_slim.get_nowait())
    full_frame = json.loads(q_full.get_nowait())
    assert set(slim_frame.keys()) == _SLIM_KEYS
    assert "Content" in full_frame and "Raw" in full_frame


async def test_broadcaster_slim_bounded_queue_drops_on_full():
    """Bounded-queue drop semantics preserved for summary clients."""
    b = WebSocketBroadcaster(queue_size=2)
    q = b.register(summary=True)
    for _ in range(5):
        await b.broadcast(_FULL_MSG)
    assert q.qsize() == 2  # excess dropped, queue never exceeds capacity
    b.unregister(q)


async def test_broadcaster_lazy_slim_serialization_no_slim_clients():
    """When no summary clients exist, to_summary is never called.

    This is implicitly verified by broadcasting a message with the minimal shape
    used in existing tests (no Content key), which would crash to_summary if called.
    """
    b = WebSocketBroadcaster(queue_size=10)
    q = b.register(summary=False)
    # Broadcast a minimal dict that lacks the keys to_summary expects.
    # If broadcast() naively calls to_summary() even when no slim clients are
    # registered it would raise KeyError; the test would fail.
    await b.broadcast({"ID": "minimal"})
    frame = json.loads(q.get_nowait())
    assert frame["ID"] == "minimal"


async def test_websocket_summary_param_delivers_slim_frame(app_and_store):
    """End-to-end: ?summary=1 WS connection receives a slim JSON frame."""
    app, _ = app_and_store
    client = app.test_client()
    async with client.websocket("/api/v2/websocket?summary=1") as ws:
        await asyncio.sleep(0)
        await asyncio.sleep(0)
        await app.broadcaster.broadcast(_FULL_MSG)
        frame = json.loads(await asyncio.wait_for(ws.receive(), timeout=2.0))
    assert set(frame.keys()) == _SLIM_KEYS


async def test_websocket_no_summary_param_delivers_full_frame(app_and_store):
    """End-to-end: WS connection without ?summary receives a full JSON frame."""
    app, _ = app_and_store
    client = app.test_client()
    async with client.websocket("/api/v2/websocket") as ws:
        await asyncio.sleep(0)
        await asyncio.sleep(0)
        await app.broadcaster.broadcast(_FULL_MSG)
        frame = json.loads(await asyncio.wait_for(ws.receive(), timeout=2.0))
    assert "Content" in frame and "Raw" in frame
