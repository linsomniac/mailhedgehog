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
    app, store = app_and_store
    # Add >200 messages so clamp actually fires and count == 200 (not just < 200)
    # Note: store.max_messages defaults to 100, so we only see min(205, 100) = 100
    # in store, but the API clamps to MAX_PAGE_LIMIT=200. Need custom config.
    config = Config(smtp_port=0, http_port=0, max_messages=300)
    store = MessageStore(config.max_messages, config.max_bytes)
    app = create_app(config, store)

    for i in range(205):
        m = parse(s.ASCII, f"u{i}@example.com", ["b@example.com"], "h")
        store.add(m, s.ASCII)
    client = app.test_client()
    resp = await client.get("/api/v2/messages?limit=10000")
    data = await resp.get_json()
    assert resp.status_code == 200
    # count must be clamped to 200 (205 messages > 200, so count == 200)
    assert data["count"] == 200


async def test_search_limit_clamped_to_max(app_and_store):
    """limit=10000 in /api/v2/search must be clamped to MAX_PAGE_LIMIT=200."""
    app, store = app_and_store
    # Add >200 messages that all match the search query
    # Note: store.max_messages defaults to 100, so use custom config.
    config = Config(smtp_port=0, http_port=0, max_messages=300)
    store = MessageStore(config.max_messages, config.max_bytes)
    app = create_app(config, store)

    for i in range(205):
        m = parse(s.ASCII, f"alice-{i}@example.com", ["bob@example.com"], "h")
        store.add(m, s.ASCII)
    client = app.test_client()
    resp = await client.get("/api/v2/search?kind=from&query=alice&limit=10000")
    data = await resp.get_json()
    assert resp.status_code == 200
    # count must be clamped to 200 (205 messages > 200, so count == 200)
    assert data["count"] == 200
    # Also test that negative start is clamped to 0 in response
    resp = await client.get("/api/v2/search?kind=from&query=alice&start=-10&limit=50")
    data = await resp.get_json()
    assert resp.status_code == 200
    assert data["start"] == 0


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


# ---------------------------------------------------------------------------
# Task 3 (B3): ?summary=1 slim projection on list & search
# ---------------------------------------------------------------------------

_SUMMARY_KEYS = {"ID", "From", "To", "ToCount", "Subject", "Created", "Size"}
_FULL_EXTRA_KEYS = {"Content", "MIME", "Raw"}  # present in full, absent in summary


async def test_list_summary_keys_and_decoded_subject(app_and_store):
    """?summary=1 on list returns ONLY the 7 slim keys with decoded Subject."""
    app, store = app_and_store
    m = parse(s.RFC2047_SUBJECT, "a@x.test", ["b@x.test"], "h")
    store.add(m, s.RFC2047_SUBJECT)
    client = app.test_client()
    resp = await client.get("/api/v2/messages?summary=1")
    assert resp.status_code == 200
    data = await resp.get_json()
    assert data["total"] == 1
    assert data["count"] == 1
    item = data["items"][0]
    # Exactly the 7 slim keys — no extras
    assert set(item.keys()) == _SUMMARY_KEYS
    # RFC-2047 encoded subject must be decoded: =?UTF-8?B?Y2Fmw6k=?= → "café"
    assert item["Subject"] == "café"
    # Size must be an int
    assert isinstance(item["Size"], int)


async def test_list_summary_true_truthy(app_and_store):
    """?summary=true (case-insensitive) is also accepted as truthy."""
    app, store = app_and_store
    m = parse(s.ASCII, "a@example.com", ["b@example.com"], "h")
    store.add(m, s.ASCII)
    client = app.test_client()
    resp = await client.get("/api/v2/messages?summary=True")
    data = await resp.get_json()
    assert resp.status_code == 200
    assert set(data["items"][0].keys()) == _SUMMARY_KEYS


async def test_list_no_summary_returns_full_items(app_and_store):
    """Default (no summary param) returns full message items with Content/MIME/Raw."""
    app, store = app_and_store
    m = parse(s.ASCII, "alice@example.com", ["bob@example.com"], "h")
    store.add(m, s.ASCII)
    client = app.test_client()
    resp = await client.get("/api/v2/messages")
    data = await resp.get_json()
    assert resp.status_code == 200
    item = data["items"][0]
    # Full items must have Content, MIME, Raw
    for key in _FULL_EXTRA_KEYS:
        assert key in item, f"Full item missing key: {key}"


async def test_list_summary_to_truncated_and_tocount(app_and_store):
    """?summary=1 truncates To to 3 entries and sets ToCount to the real total."""
    app, store = app_and_store
    recipients = [f"r{i}@example.com" for i in range(5)]
    # Build a raw email with 5 To addresses
    raw = (
        b"From: sender@example.com\r\n"
        b"To: r0@example.com, r1@example.com, r2@example.com,"
        b" r3@example.com, r4@example.com\r\n"
        b"Subject: Multi-To\r\n"
        b"\r\n"
        b"body\r\n"
    )
    m = parse(raw, "sender@example.com", recipients, "h")
    store.add(m, raw)
    client = app.test_client()
    resp = await client.get("/api/v2/messages?summary=1")
    data = await resp.get_json()
    item = data["items"][0]
    assert item["ToCount"] == 5
    assert len(item["To"]) == 3


async def test_list_summary_missing_subject(app_and_store):
    """?summary=1 returns empty string for Subject when header is missing."""
    app, store = app_and_store
    raw = b"From: a@x.test\r\nTo: b@x.test\r\n\r\nbody\r\n"
    m = parse(raw, "a@x.test", ["b@x.test"], "h")
    store.add(m, raw)
    client = app.test_client()
    resp = await client.get("/api/v2/messages?summary=1")
    data = await resp.get_json()
    assert data["items"][0]["Subject"] == ""


async def test_list_total_count_identical_summary_vs_full(app_and_store):
    """total and count are identical for summary=0 vs summary=1 over same store."""
    app, store = app_and_store
    for i in range(3):
        m = parse(s.ASCII, f"u{i}@example.com", ["b@example.com"], "h")
        store.add(m, s.ASCII)
    client = app.test_client()
    full = await (await client.get("/api/v2/messages")).get_json()
    slim = await (await client.get("/api/v2/messages?summary=1")).get_json()
    assert full["total"] == slim["total"]
    assert full["count"] == slim["count"]
    assert full["start"] == slim["start"]


async def test_search_summary_keys_and_decoded_subject(app_and_store):
    """?summary=1 on search returns ONLY the 7 slim keys with decoded Subject."""
    app, store = app_and_store
    m = parse(s.RFC2047_SUBJECT, "a@x.test", ["b@x.test"], "h")
    store.add(m, s.RFC2047_SUBJECT)
    client = app.test_client()
    resp = await client.get("/api/v2/search?kind=from&query=a%40x.test&summary=1")
    assert resp.status_code == 200
    data = await resp.get_json()
    assert data["total"] == 1
    item = data["items"][0]
    assert set(item.keys()) == _SUMMARY_KEYS
    assert item["Subject"] == "café"


async def test_search_no_summary_returns_full_items(app_and_store):
    """Default search (no summary param) still returns full message items."""
    app, store = app_and_store
    m = parse(s.ASCII, "alice@example.com", ["bob@example.com"], "h")
    store.add(m, s.ASCII)
    client = app.test_client()
    resp = await client.get("/api/v2/search?kind=from&query=alice")
    data = await resp.get_json()
    item = data["items"][0]
    for key in _FULL_EXTRA_KEYS:
        assert key in item, f"Full search item missing key: {key}"


async def test_search_summary_to_truncated_and_tocount(app_and_store):
    """?summary=1 on search truncates To to 3 and sets correct ToCount."""
    app, store = app_and_store
    recipients = [f"r{i}@example.com" for i in range(5)]
    raw = (
        b"From: sender@example.com\r\n"
        b"To: r0@example.com, r1@example.com, r2@example.com,"
        b" r3@example.com, r4@example.com\r\n"
        b"Subject: Multi-To\r\n"
        b"\r\n"
        b"body\r\n"
    )
    m = parse(raw, "sender@example.com", recipients, "h")
    store.add(m, raw)
    client = app.test_client()
    resp = await client.get("/api/v2/search?kind=from&query=sender&summary=1")
    data = await resp.get_json()
    item = data["items"][0]
    assert item["ToCount"] == 5
    assert len(item["To"]) == 3


async def test_search_total_count_identical_summary_vs_full(app_and_store):
    """total and count are identical for summary=0 vs summary=1 on search."""
    app, store = app_and_store
    for i in range(3):
        m = parse(s.ASCII, f"alice-{i}@example.com", ["b@example.com"], "h")
        store.add(m, s.ASCII)
    client = app.test_client()
    full = await (await client.get("/api/v2/search?kind=from&query=alice")).get_json()
    slim = await (
        await client.get("/api/v2/search?kind=from&query=alice&summary=1")
    ).get_json()
    assert full["total"] == slim["total"]
    assert full["count"] == slim["count"]
    assert full["start"] == slim["start"]


# ---------------------------------------------------------------------------
# Task 5 (B5a): nested cid endpoint + security headers
# ---------------------------------------------------------------------------


async def test_cid_endpoint_resolves_nested_inline_image(app_and_store):
    """Nested inline image (multipart/related inside multipart/alternative) is
    returned with its image/* content-type and nosniff header."""
    app, store = app_and_store
    m = parse(s.MULTIPART_RELATED_WITH_CID, "a@x.test", ["b@x.test"], "h")
    store.add(m, s.MULTIPART_RELATED_WITH_CID)
    client = app.test_client()
    resp = await client.get(f"/api/v1/messages/{m['ID']}/mime/cid/logo/download")
    assert resp.status_code == 200
    body = await resp.get_data()
    import base64

    assert body == base64.b64decode(b"AAEC")
    assert resp.content_type.startswith("image/png")
    assert resp.headers.get("X-Content-Type-Options") == "nosniff"


async def test_cid_endpoint_resolves_cid_with_angle_brackets(app_and_store):
    """CID lookup with angle brackets in the URL (URL-encoded) still resolves."""
    app, store = app_and_store
    m = parse(s.MULTIPART_RELATED_WITH_CID, "a@x.test", ["b@x.test"], "h")
    store.add(m, s.MULTIPART_RELATED_WITH_CID)
    client = app.test_client()
    # Quart's <path:cid> receives the URL-decoded value; test with bare cid too
    resp = await client.get(f"/api/v1/messages/{m['ID']}/mime/cid/%3Clogo%3E/download")
    assert resp.status_code == 200
    assert resp.content_type.startswith("image/png")


async def test_cid_endpoint_text_html_served_as_octet_stream(app_and_store):
    """A part with Content-Type: text/html referenced by cid is served as
    application/octet-stream (active-type downgrade) with nosniff header."""
    app, store = app_and_store
    m = parse(s.MULTIPART_RELATED_HTML_CID, "a@x.test", ["b@x.test"], "h")
    store.add(m, s.MULTIPART_RELATED_HTML_CID)
    client = app.test_client()
    resp = await client.get(f"/api/v1/messages/{m['ID']}/mime/cid/htmlpart/download")
    assert resp.status_code == 200
    assert resp.content_type.startswith("application/octet-stream")
    assert resp.headers.get("X-Content-Type-Options") == "nosniff"


async def test_cid_endpoint_unknown_cid_returns_404(app_and_store):
    """Requesting a cid that does not exist in the message returns 404."""
    app, store = app_and_store
    m = parse(s.MULTIPART_RELATED_WITH_CID, "a@x.test", ["b@x.test"], "h")
    store.add(m, s.MULTIPART_RELATED_WITH_CID)
    client = app.test_client()
    resp = await client.get(f"/api/v1/messages/{m['ID']}/mime/cid/nosuchcid/download")
    assert resp.status_code == 404


async def test_cid_endpoint_missing_message_returns_404(app_and_store):
    """Requesting a cid for a non-existent message ID returns 404."""
    app, store = app_and_store
    client = app.test_client()
    resp = await client.get("/api/v1/messages/nonexistent/mime/cid/logo/download")
    assert resp.status_code == 404


async def test_after_request_csp_header_on_index(app_and_store):
    """after_request hook adds CSP and nosniff headers to all responses."""
    app, _ = app_and_store
    client = app.test_client()
    resp = await client.get("/")
    assert resp.headers.get("X-Content-Type-Options") == "nosniff"
    csp = resp.headers.get("Content-Security-Policy", "")
    assert "default-src 'self'" in csp
    assert "object-src 'none'" in csp
    assert "frame-ancestors 'self'" in csp


async def test_after_request_csp_header_on_api_response(app_and_store):
    """after_request hook adds CSP and nosniff headers to API JSON responses too."""
    app, store = app_and_store
    m = parse(s.ASCII, "a@x.test", ["b@x.test"], "h")
    store.add(m, s.ASCII)
    client = app.test_client()
    resp = await client.get("/api/v2/messages")
    assert resp.headers.get("X-Content-Type-Options") == "nosniff"
    csp = resp.headers.get("Content-Security-Policy", "")
    assert "default-src 'self'" in csp
