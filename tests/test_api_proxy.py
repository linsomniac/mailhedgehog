from quart import Quart

from mailhedgehog.config import Config
from mailhedgehog.fetcher import FetchError
from mailhedgehog.storage import MessageStore
from mailhedgehog.web import create_app


def _app(**cfg: object) -> Quart:
    config = Config(smtp_port=0, http_port=0, **cfg)
    store = MessageStore(config.max_messages, config.max_bytes)
    return create_app(config, store)


async def test_config_endpoint_reports_flag_off():
    client = _app(proxy_remote_images=False).test_client()
    data = await (await client.get("/api/v2/config")).get_json()
    assert data == {"proxyRemoteImages": False}


async def test_config_endpoint_reports_flag_on():
    client = _app(proxy_remote_images=True).test_client()
    data = await (await client.get("/api/v2/config")).get_json()
    assert data == {"proxyRemoteImages": True}


async def test_proxy_404_when_disabled():
    client = _app(proxy_remote_images=False).test_client()
    resp = await client.get("/api/v2/proxy?url=http://example.com/a.png")
    assert resp.status_code == 404


async def test_proxy_400_when_url_missing():
    client = _app(proxy_remote_images=True).test_client()
    resp = await client.get("/api/v2/proxy")
    assert resp.status_code == 400


async def test_proxy_streams_image_when_enabled(monkeypatch):
    # AIDEV-NOTE: route test mocks the fetcher; SSRF behavior is covered by
    # tests/test_fetcher.py. This verifies wiring, status, and headers only.
    monkeypatch.setattr(
        "mailhedgehog.web.fetch_remote_image",
        lambda url, **kw: (b"\x89PNG-bytes", "image/png"),
    )
    client = _app(proxy_remote_images=True).test_client()
    resp = await client.get("/api/v2/proxy?url=http://example.com/a.png")
    assert resp.status_code == 200
    assert (await resp.get_data()) == b"\x89PNG-bytes"
    assert resp.headers["Content-Type"].startswith("image/png")
    assert resp.headers["X-Content-Type-Options"] == "nosniff"
    assert resp.headers["Cache-Control"] == "private, max-age=300"


async def test_proxy_502_on_fetch_error(monkeypatch):
    def boom(url, **kw):
        raise FetchError("blocked")

    monkeypatch.setattr("mailhedgehog.web.fetch_remote_image", boom)
    client = _app(proxy_remote_images=True).test_client()
    resp = await client.get("/api/v2/proxy?url=http://10.0.0.1/a.png")
    assert resp.status_code == 502


async def test_proxy_502_on_unexpected_error(monkeypatch):
    def boom(url, **kw):
        raise RuntimeError("unexpected")

    monkeypatch.setattr("mailhedgehog.web.fetch_remote_image", boom)
    client = _app(proxy_remote_images=True).test_client()
    resp = await client.get("/api/v2/proxy?url=http://example.com/a.png")
    assert resp.status_code == 502


async def test_proxy_502_on_newline_content_type(monkeypatch):
    # A content-type containing a newline would raise in Response(mimetype=...);
    # the route must convert that into 502, never 500 / a stack trace.
    monkeypatch.setattr(
        "mailhedgehog.web.fetch_remote_image",
        lambda url, **kw: (b"x", "image/png\r\nX-Injected: yes"),
    )
    client = _app(proxy_remote_images=True).test_client()
    resp = await client.get("/api/v2/proxy?url=http://example.com/a.png")
    assert resp.status_code == 502
