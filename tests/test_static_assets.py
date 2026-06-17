"""Tests for the app icon / favicon static assets and their wiring."""

import xml.etree.ElementTree as ET
from io import BytesIO
from pathlib import Path

import pytest
from PIL import Image

from mailhedgehog.config import Config
from mailhedgehog.storage import MessageStore
from mailhedgehog.web import create_app

_IMAGES = (
    Path(__file__).resolve().parent.parent
    / "src"
    / "mailhedgehog"
    / "static"
    / "images"
)


@pytest.fixture
def app():
    config = Config(smtp_port=0, http_port=0, max_messages=100, max_bytes=10_000_000)
    store = MessageStore(config.max_messages, config.max_bytes)
    return create_app(config, store)


async def test_icon_svg_served_with_svg_mimetype(app):
    resp = await app.test_client().get("/static/images/icon.svg")
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
    resp = await app.test_client().get(f"/static/images/{name}")
    assert resp.status_code == 200
    assert "image/png" in resp.content_type
    image = Image.open(BytesIO(await resp.get_data()))
    assert image.size == (size, size)
