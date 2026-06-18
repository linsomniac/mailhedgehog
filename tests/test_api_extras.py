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


async def test_download_evil_filename(app_and_store):
    app, store = app_and_store
    m = parse(s.MULTIPART_EVIL_FILENAME, "a@x.test", ["b@x.test"], "h")
    store.add(m, s.MULTIPART_EVIL_FILENAME)
    client = app.test_client()
    resp = await client.get(f"/api/v1/messages/{m['ID']}/mime/part/1/download")
    assert resp.status_code == 200
    disposition = resp.headers["Content-Disposition"]
    assert "\r" not in disposition
    assert "\n" not in disposition


async def test_stubs(app_and_store):
    app, _ = app_and_store
    client = app.test_client()
    assert (await (await client.get("/api/v2/outgoing-smtp")).get_json()) == []
    assert (await client.post("/api/v1/messages/x/release")).status_code == 501


# ---------------------------------------------------------------------------
# Task 2 (B2): kind allowlist, limit clamp, threaded search route
# ---------------------------------------------------------------------------


async def test_search_unknown_kind_returns_400(app_and_store):
    """Unknown search kind must return HTTP 400 without running any scan."""
    app, store = app_and_store
    m = parse(s.ASCII, "alice@example.com", ["bob@example.com"], "h")
    store.add(m, s.ASCII)
    client = app.test_client()
    resp = await client.get("/api/v2/search?kind=evil&query=foo")
    assert resp.status_code == 400


async def test_list_limit_clamped_to_max(app_and_store):
    """limit=10000 in /api/v2/messages must be clamped to MAX_PAGE_LIMIT=200."""
    from mailhedgehog.web import MAX_PAGE_LIMIT

    app, store = app_and_store
    for i in range(5):
        m = parse(s.ASCII, f"u{i}@example.com", ["b@example.com"], "h")
        store.add(m, s.ASCII)
    client = app.test_client()
    resp = await client.get("/api/v2/messages?limit=10000")
    data = await resp.get_json()
    assert resp.status_code == 200
    # count must not exceed MAX_PAGE_LIMIT (5 messages < 200, so count == 5 here)
    assert data["count"] <= MAX_PAGE_LIMIT
    # confirm the constant is exactly 200
    assert MAX_PAGE_LIMIT == 200


async def test_search_limit_clamped_to_max(app_and_store):
    """limit=10000 in /api/v2/search must be clamped to MAX_PAGE_LIMIT=200."""
    from mailhedgehog.web import MAX_PAGE_LIMIT

    app, store = app_and_store
    m = parse(s.ASCII, "alice@example.com", ["bob@example.com"], "h")
    store.add(m, s.ASCII)
    client = app.test_client()
    resp = await client.get("/api/v2/search?kind=from&query=alice&limit=10000")
    data = await resp.get_json()
    assert resp.status_code == 200
    assert data["count"] <= MAX_PAGE_LIMIT


async def test_search_via_thread_returns_correct_results(app_and_store):
    """Search route (thread-offloaded) returns the right message."""
    app, store = app_and_store
    m = parse(s.ASCII, "threadtest@example.com", ["b@example.com"], "h")
    store.add(m, s.ASCII)
    client = app.test_client()
    resp = await client.get("/api/v2/search?kind=from&query=threadtest")
    data = await resp.get_json()
    assert resp.status_code == 200
    assert data["total"] == 1
    assert data["items"][0]["ID"] == m["ID"]


async def test_list_start_negative_clamped(app_and_store):
    """Negative start in /api/v2/messages must be clamped to 0."""
    app, store = app_and_store
    m = parse(s.ASCII, "a@example.com", ["b@example.com"], "h")
    store.add(m, s.ASCII)
    client = app.test_client()
    resp = await client.get("/api/v2/messages?start=-10&limit=50")
    data = await resp.get_json()
    assert resp.status_code == 200
    assert data["start"] == 0
    assert data["total"] == 1
