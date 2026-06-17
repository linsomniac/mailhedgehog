import pytest

from mailhedgehog.config import Config
from mailhedgehog.parser import parse
from mailhedgehog.storage import MessageStore
from mailhedgehog.web import create_app
from tests import sample_emails as s


@pytest.fixture
def app_and_store():
    config = Config(smtp_port=0, http_port=0, max_messages=100, max_bytes=10_000_000)
    store = MessageStore(config.max_messages, config.max_bytes)
    return create_app(config, store), store


def _seed(store, n):
    ids = []
    for _ in range(n):
        m = parse(s.ASCII, "alice@example.com", ["bob@example.com"], "h")
        store.add(m, s.ASCII)
        ids.append(m["ID"])
    return ids


async def test_index_serves_html(app_and_store):
    app, _ = app_and_store
    client = app.test_client()
    resp = await client.get("/")
    assert resp.status_code == 200
    body = await resp.get_data(as_text=True)
    assert "MailHedgehog" in body


async def test_list_messages_pagination(app_and_store):
    app, store = app_and_store
    _seed(store, 3)
    client = app.test_client()
    resp = await client.get("/api/v2/messages?limit=2")
    data = await resp.get_json()
    assert data["total"] == 3
    assert data["count"] == 2
    assert data["start"] == 0
    assert len(data["items"]) == 2


async def test_get_single_message_and_404(app_and_store):
    app, store = app_and_store
    ids = _seed(store, 1)
    client = app.test_client()
    resp = await client.get(f"/api/v1/messages/{ids[0]}")
    assert resp.status_code == 200
    assert (await resp.get_json())["ID"] == ids[0]
    assert (await client.get("/api/v1/messages/nope")).status_code == 404


async def test_delete_one_and_delete_all(app_and_store):
    app, store = app_and_store
    ids = _seed(store, 2)
    client = app.test_client()
    assert (await client.delete(f"/api/v1/messages/{ids[0]}")).status_code == 200
    assert len(store) == 1
    assert (await client.delete("/api/v1/messages/missing")).status_code == 404
    assert (await client.delete("/api/v1/messages")).status_code == 200
    assert len(store) == 0
