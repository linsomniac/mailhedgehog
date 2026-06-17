import pytest

from mailhedgehog.config import Config
from mailhedgehog.parser import parse
from mailhedgehog.storage import MessageStore
from mailhedgehog.web import create_app
from tests import sample_emails as s


@pytest.fixture
def app_and_store():
    config = Config(smtp_port=0, http_port=0)
    store = MessageStore(config.max_messages, config.max_bytes)
    return create_app(config, store), store


async def test_search_endpoint(app_and_store):
    app, store = app_and_store
    m = parse(s.ASCII, "alice@example.com", ["bob@example.com"], "h")
    store.add(m, s.ASCII)
    client = app.test_client()
    resp = await client.get("/api/v2/search?kind=from&query=alice")
    data = await resp.get_json()
    assert data["total"] == 1
    assert data["items"][0]["ID"] == m["ID"]


async def test_download_raw_message(app_and_store):
    app, store = app_and_store
    m = parse(s.ASCII, "a@x.test", ["b@x.test"], "h")
    store.add(m, s.ASCII)
    client = app.test_client()
    resp = await client.get(f"/api/v1/messages/{m['ID']}/download")
    assert resp.status_code == 200
    assert (await resp.get_data()) == s.ASCII
    assert "attachment" in resp.headers["Content-Disposition"]
    assert (await client.get("/api/v1/messages/missing/download")).status_code == 404


async def test_download_mime_part(app_and_store):
    app, store = app_and_store
    m = parse(s.MULTIPART_ATTACHMENT, "a@x.test", ["b@x.test"], "h")
    store.add(m, s.MULTIPART_ATTACHMENT)
    client = app.test_client()
    resp = await client.get(f"/api/v1/messages/{m['ID']}/mime/part/1/download")
    assert resp.status_code == 200
    assert (await resp.get_data()) == bytes([0, 1, 2, 3, 4, 5])
    assert "hi.bin" in resp.headers["Content-Disposition"]
    assert (
        await client.get(f"/api/v1/messages/{m['ID']}/mime/part/9/download")
    ).status_code == 404


async def test_stubs(app_and_store):
    app, _ = app_and_store
    client = app.test_client()
    assert (await (await client.get("/api/v2/outgoing-smtp")).get_json()) == []
    assert (await client.post("/api/v1/messages/x/release")).status_code == 501
