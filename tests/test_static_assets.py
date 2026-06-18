"""Tests for the app icon / favicon static assets and their wiring."""

import xml.etree.ElementTree as ET
from io import BytesIO
from pathlib import Path

import pytest
from PIL import Image

from mailhedgehog.config import Config
from mailhedgehog.storage import MessageStore
from mailhedgehog.web import create_app

# AIDEV-NOTE: Images now live under static/app/images/ (built by Vite from
# frontend/public/images/).  The old static/images/ directory was removed in
# Task 7 when the AngularJS UI was replaced by the Svelte SPA.
_IMAGES = (
    Path(__file__).resolve().parent.parent
    / "src"
    / "mailhedgehog"
    / "static"
    / "app"
    / "images"
)


@pytest.fixture
def app():
    config = Config(smtp_port=0, http_port=0, max_messages=100, max_bytes=10_000_000)
    store = MessageStore(config.max_messages, config.max_bytes)
    return create_app(config, store)


# ---------------------------------------------------------------------------
# Favicon / icon assets served from the new /static/app/images/ paths
# ---------------------------------------------------------------------------


async def test_icon_svg_served_with_svg_mimetype(app):
    resp = await app.test_client().get("/static/app/images/icon.svg")
    assert resp.status_code == 200
    assert "image/svg+xml" in resp.content_type


def test_icon_svg_is_square_xml():
    root = ET.fromstring((_IMAGES / "icon.svg").read_text())
    assert root.attrib["viewBox"] == "0 0 64 64"


@pytest.mark.parametrize(
    ("name", "size"),
    [
        ("favicon-16.png", 16),
        ("favicon-32.png", 32),
        ("icon-128.png", 128),
        ("apple-touch-icon.png", 180),
    ],
)
async def test_png_served_with_correct_size(app, name, size):
    resp = await app.test_client().get(f"/static/app/images/{name}")
    assert resp.status_code == 200
    assert "image/png" in resp.content_type
    image = Image.open(BytesIO(await resp.get_data()))
    assert image.size == (size, size)


def test_old_pig_asset_is_gone():
    assert not (_IMAGES / "hog.png").exists()


# ---------------------------------------------------------------------------
# Index route: serves the built SPA with correct content and cache headers
# ---------------------------------------------------------------------------


async def test_index_returns_built_spa_html(app):
    """GET / returns the built Svelte SPA HTML referencing app.js and app.css."""
    resp = await app.test_client().get("/")
    assert resp.status_code == 200
    body = await resp.get_data(as_text=True)
    assert "app.js" in body
    assert "app.css" in body


async def test_index_references_new_icons(app):
    """The served index.html references icons at the new /static/app/images/ paths."""
    body = await (await app.test_client().get("/")).get_data(as_text=True)
    assert "static/app/images/icon.svg" in body
    assert "static/app/images/apple-touch-icon.png" in body
    assert "static/app/images/favicon-32.png" in body
    assert "static/app/images/favicon-16.png" in body
    assert "hog.png" not in body


async def test_index_has_no_cache_header(app):
    """GET / carries Cache-Control: no-cache so stale HTML is never served."""
    resp = await app.test_client().get("/")
    assert resp.status_code == 200
    cc = resp.headers.get("Cache-Control", "")
    assert "no-cache" in cc


# ---------------------------------------------------------------------------
# Bundle assets resolve and are served with no-cache
# ---------------------------------------------------------------------------


async def test_app_js_resolves(app):
    """GET /static/app/app.js → 200 (asset referenced by index.html exists)."""
    resp = await app.test_client().get("/static/app/app.js")
    assert resp.status_code == 200


async def test_app_css_resolves(app):
    """GET /static/app/app.css → 200 (asset referenced by index.html exists)."""
    resp = await app.test_client().get("/static/app/app.css")
    assert resp.status_code == 200


async def test_static_app_asset_has_no_cache_header(app):
    """Responses for /static/app/* assets carry Cache-Control: no-cache."""
    resp = await app.test_client().get("/static/app/app.js")
    assert resp.status_code == 200
    cc = resp.headers.get("Cache-Control", "")
    assert "no-cache" in cc
