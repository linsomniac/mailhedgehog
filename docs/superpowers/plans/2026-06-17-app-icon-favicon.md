# MailHedgehog App Icon & Favicon Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the placeholder pig logo with a purpose-drawn "peeking hog" hedgehog icon used as both the navbar logo and the favicon.

**Architecture:** Hand-authored square SVG master (`icon.svg`) drives everything. A committed dev script rasterises it to PNG fallbacks via headless Chrome. Three template/JS references are repointed at the new assets and the pig is deleted. Tests assert the assets are served with correct content-types/sizes and that the wiring no longer mentions the pig.

**Tech Stack:** Quart (async Flask) web app, served static files, SVG/PNG assets, headless Google Chrome (rasteriser), Pillow (test-only image assertions), pytest + pytest-asyncio.

## Global Constraints

- **Python:** `>=3.10`. **Package manager: `uv` only** — never pip/poetry/requirements.txt. Add deps with `uv add`.
- **Format/lint:** `uv run ruff format .` then `uv run ruff check .` (rules `E,F,I,UP,B`; line-length **88**). CI runs both over the **whole repo** (`tools/` and `tests/` included), so all new files must be clean and formatted.
- **Types:** annotate every function. `uv run mypy` runs `--strict` over **`src/` only** (config `files=["src"]`); `tools/` and `tests/` are not type-checked but must still be lint-clean.
- **Tests:** pytest with `asyncio_mode = "auto"`. Async web tests use `app = create_app(config, store)` then `client = app.test_client()` and `await client.get(...)`.
- **Art is LOCKED.** Use the approved `icon.svg` markup from the spec verbatim — do not redraw or "improve" it. Palette: red `#952225`, red-shade `#A82C2C`, paper `#F7EFE0`, flap `#E4D2AD`, cream `#F0E2C6`, dark `#2A1A12`, tile `#FBF5E9`.
- **Assets dir:** `src/mailhedgehog/static/images/`, served at `/static/images/...`.
- **Every commit message ends with:** `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`
- **Baseline:** 68 tests pass before this work; expect **77** after (2 + 4 + 3 new). Run `uv run pytest -q` to confirm baseline first.

## File Structure

| File | Action | Responsibility |
| --- | --- | --- |
| `src/mailhedgehog/static/images/icon.svg` | create | transparent vector master (navbar + svg favicon) |
| `src/mailhedgehog/static/images/favicon-16.png` | create (generated) | 16×16 transparent raster fallback |
| `src/mailhedgehog/static/images/favicon-32.png` | create (generated) | 32×32 transparent raster fallback |
| `src/mailhedgehog/static/images/icon-128.png` | create (generated) | 128×128 transparent, desktop notification |
| `src/mailhedgehog/static/images/apple-touch-icon.png` | create (generated) | 180×180 opaque tile, iOS home screen |
| `src/mailhedgehog/static/images/hog.png` | delete | the old pig |
| `tools/render_icons.py` | create | regenerate the PNGs from `icon.svg` (Chrome) |
| `src/mailhedgehog/templates/index.html` | modify | favicon links + navbar `<img>` + `alt` |
| `src/mailhedgehog/static/js/controllers.js` | modify | notification icon path |
| `pyproject.toml` + `uv.lock` | modify | add Pillow to the `dev` group |
| `tests/test_static_assets.py` | create | asset + wiring tests (grows across tasks) |

---

### Task 1: SVG master asset

**Files:**
- Create: `src/mailhedgehog/static/images/icon.svg`
- Test: `tests/test_static_assets.py`

**Interfaces:**
- Consumes: `mailhedgehog.web.create_app(config, store)`, `mailhedgehog.config.Config`, `mailhedgehog.storage.MessageStore` (existing).
- Produces: `src/mailhedgehog/static/images/icon.svg` (square `viewBox 0 0 64 64`), served at `/static/images/icon.svg`. Later tasks raster it and reference it.

- [ ] **Step 1: Write the failing tests**

Create `tests/test_static_assets.py`:

```python
"""Tests for the app icon / favicon static assets and their wiring."""

import xml.etree.ElementTree as ET
from pathlib import Path

import pytest

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
    config = Config(
        smtp_port=0, http_port=0, max_messages=100, max_bytes=10_000_000
    )
    store = MessageStore(config.max_messages, config.max_bytes)
    return create_app(config, store)


async def test_icon_svg_served_with_svg_mimetype(app):
    resp = await app.test_client().get("/static/images/icon.svg")
    assert resp.status_code == 200
    assert "image/svg+xml" in resp.content_type


def test_icon_svg_is_square_xml():
    root = ET.fromstring((_IMAGES / "icon.svg").read_text())
    assert root.attrib["viewBox"] == "0 0 64 64"
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `uv run pytest tests/test_static_assets.py -q`
Expected: FAIL — `test_icon_svg_served_with_svg_mimetype` gets 404, `test_icon_svg_is_square_xml` raises `FileNotFoundError`.

- [ ] **Step 3: Create the SVG master**

Create `src/mailhedgehog/static/images/icon.svg` with exactly this content (single line, no trailing newline needed):

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><path d="M19.51,31.56 L10.83,28.27 L20.11,28.14 Z M20.11,28.14 L12.68,22.58 L21.64,25.01 Z M21.64,25.01 L16.02,17.61 L23.97,22.42 Z M23.97,22.42 L20.61,13.77 L26.92,20.58 Z M26.92,20.58 L26.07,11.33 L30.26,19.62 Z M30.26,19.62 L32.00,10.50 L33.74,19.62 Z M33.74,19.62 L37.93,11.33 L37.08,20.58 Z M37.08,20.58 L43.39,13.77 L40.03,22.42 Z M40.03,22.42 L47.98,17.61 L42.36,25.01 Z M42.36,25.01 L51.32,22.58 L43.89,28.14 Z M43.89,28.14 L53.17,28.27 L44.49,31.56 Z" fill="#952225"/><path d="M18.5,32 A13.5,13.5 0 0 1 45.5,32 Z" fill="#952225"/><path d="M23,31 A10,10 0 0 1 41,31" fill="none" stroke="#A82C2C" stroke-width="2" opacity="0.45"/><path d="M19,32 a3,3 0 0 1 6,0 Z" fill="#F0E2C6" stroke="#2A1A12" stroke-width="1"/><path d="M39,32 a3,3 0 0 1 6,0 Z" fill="#F0E2C6" stroke="#2A1A12" stroke-width="1"/><ellipse cx="32" cy="29" rx="5" ry="3.2" fill="#F0E2C6"/><circle cx="32" cy="28.6" r="2" fill="#2A1A12"/><circle cx="24.5" cy="24" r="3" fill="#2A1A12"/><circle cx="25.5" cy="23" r="0.95" fill="#fff"/><circle cx="39.5" cy="24" r="3" fill="#2A1A12"/><circle cx="40.5" cy="23" r="0.95" fill="#fff"/><rect x="10.5" y="32" width="43" height="24.5" rx="3" fill="#F7EFE0" stroke="#2A1A12" stroke-width="1.6"/><path d="M11.3,32.8 L32,46.5 L52.7,32.8 Z" fill="#E4D2AD"/><path d="M11.3,32.8 L32,46.5 L52.7,32.8" fill="none" stroke="#2A1A12" stroke-width="1.6" stroke-linejoin="round"/></svg>
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `uv run pytest tests/test_static_assets.py -q`
Expected: PASS (2 passed).

- [ ] **Step 5: Lint + commit**

```bash
uv run ruff format tests/test_static_assets.py
uv run ruff check tests/test_static_assets.py
git add src/mailhedgehog/static/images/icon.svg tests/test_static_assets.py
git commit -m "feat(web): add hedgehog icon.svg master asset" \
  -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Raster fallbacks + regeneration tool

**Files:**
- Create: `tools/render_icons.py`
- Create (generated): `src/mailhedgehog/static/images/{favicon-16,favicon-32,icon-128,apple-touch-icon}.png`
- Modify: `pyproject.toml`, `uv.lock` (add Pillow dev dep)
- Test: `tests/test_static_assets.py` (append)

**Interfaces:**
- Consumes: `icon.svg` from Task 1; `google-chrome` on `PATH`.
- Produces: four PNGs served at `/static/images/<name>.png` with sizes 16, 32, 128, 180. Task 3 references `apple-touch-icon.png` and the favicon PNGs in `index.html`, and `icon-128.png` in `controllers.js`.

- [ ] **Step 1: Add Pillow as a dev dependency**

Run: `uv add --dev pillow`
Expected: `pyproject.toml` `[dependency-groups] dev` now lists `pillow`; `uv.lock` updated; env synced.

- [ ] **Step 2: Write the failing tests**

Append to `tests/test_static_assets.py` — add this import near the top imports block:

```python
from io import BytesIO
```

and (also near the top) the third-party import:

```python
from PIL import Image
```

Then append these test functions at the end of the file:

```python
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
```

The import block at the top of the file should now read:

```python
import xml.etree.ElementTree as ET
from io import BytesIO
from pathlib import Path

import pytest
from PIL import Image

from mailhedgehog.config import Config
from mailhedgehog.storage import MessageStore
from mailhedgehog.web import create_app
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `uv run pytest tests/test_static_assets.py -q`
Expected: FAIL — the four `test_png_served_with_correct_size` cases get 404.

- [ ] **Step 4: Create the regeneration tool**

Create `tools/render_icons.py`:

```python
#!/usr/bin/env python3
"""Regenerate MailHedgehog raster icons from the SVG master (icon.svg).

Usage:

    uv run python tools/render_icons.py

Requires headless Google Chrome on PATH -- the same engine that renders the SVG
favicon in browsers. (cairosvg is the conventional rasteriser but needs a
system libcairo that is unavailable in this environment.) The generated PNGs
are committed, so this only needs to run when icon.svg changes.
"""

from __future__ import annotations

import subprocess
import tempfile
from pathlib import Path

_ROOT = Path(__file__).resolve().parent.parent
IMAGES = _ROOT / "src" / "mailhedgehog" / "static" / "images"
MASTER = IMAGES / "icon.svg"
TILE_BG = "#FBF5E9"

# (filename, pixel size, wrap on the opaque app tile?)
TARGETS: list[tuple[str, int, bool]] = [
    ("favicon-16.png", 16, False),
    ("favicon-32.png", 32, False),
    ("icon-128.png", 128, False),
    ("apple-touch-icon.png", 180, True),
]


def inner_markup(svg: str) -> str:
    """Return the markup between the master <svg ...> and </svg>."""
    return svg[svg.index(">") + 1 : svg.rindex("</svg>")]


def wrap(body: str, *, tile: bool) -> str:
    """Wrap figure markup in an svg root, optionally on the app tile."""
    if tile:
        return (
            '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">'
            f'<rect width="64" height="64" rx="14" fill="{TILE_BG}"/>'
            f'<g transform="translate(7.5 9) scale(0.77)">{body}</g>'
            "</svg>"
        )
    return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">{body}</svg>'


def render(svg: str, size: int, out: Path) -> None:
    """Rasterise the svg to a size-by-size PNG via headless Chrome."""
    sized = svg.replace("viewBox", f'width="{size}" height="{size}" viewBox', 1)
    with tempfile.TemporaryDirectory() as tmp:
        src = Path(tmp) / "icon.svg"
        src.write_text(sized)
        subprocess.run(
            [
                "google-chrome",
                "--headless=new",
                "--no-sandbox",
                "--disable-gpu",
                "--hide-scrollbars",
                "--default-background-color=00000000",
                "--force-device-scale-factor=1",
                f"--window-size={size},{size}",
                f"--user-data-dir={tmp}/profile",
                "--no-first-run",
                f"--screenshot={out}",
                src.as_uri(),
            ],
            check=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )


def main() -> None:
    body = inner_markup(MASTER.read_text())
    for name, size, tile in TARGETS:
        render(wrap(body, tile=tile), size, IMAGES / name)
        print(f"wrote {name} ({size}x{size})")


if __name__ == "__main__":
    main()
```

- [ ] **Step 5: Generate the rasters**

Run: `uv run python tools/render_icons.py`
Expected output:
```
wrote favicon-16.png (16x16)
wrote favicon-32.png (32x32)
wrote icon-128.png (128x128)
wrote apple-touch-icon.png (180x180)
```
Verify: `file src/mailhedgehog/static/images/*.png` shows the four PNGs at the right dimensions.

- [ ] **Step 6: Run tests to verify they pass**

Run: `uv run pytest tests/test_static_assets.py -q`
Expected: PASS (6 passed).

- [ ] **Step 7: Lint + commit**

```bash
uv run ruff format tools/render_icons.py tests/test_static_assets.py
uv run ruff check tools/render_icons.py tests/test_static_assets.py
git add tools/render_icons.py pyproject.toml uv.lock \
  src/mailhedgehog/static/images/favicon-16.png \
  src/mailhedgehog/static/images/favicon-32.png \
  src/mailhedgehog/static/images/icon-128.png \
  src/mailhedgehog/static/images/apple-touch-icon.png \
  tests/test_static_assets.py
git commit -m "feat(web): add raster icon fallbacks + render tool" \
  -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Rewire references and delete the pig

**Files:**
- Modify: `src/mailhedgehog/templates/index.html`
- Modify: `src/mailhedgehog/static/js/controllers.js`
- Delete: `src/mailhedgehog/static/images/hog.png`
- Test: `tests/test_static_assets.py` (append)

**Interfaces:**
- Consumes: `icon.svg` (Task 1) and the four PNGs (Task 2).
- Produces: final wiring. No code symbols for later tasks (this is the last task).

- [ ] **Step 1: Write the failing tests**

Append these test functions to the end of `tests/test_static_assets.py`:

```python
async def test_index_references_new_icons_not_pig(app):
    body = await (await app.test_client().get("/")).get_data(as_text=True)
    assert "static/images/icon.svg" in body
    assert "static/images/apple-touch-icon.png" in body
    assert "static/images/favicon-32.png" in body
    assert "static/images/favicon-16.png" in body
    assert "hog.png" not in body


def test_controllers_js_references_notification_icon_not_pig():
    js = (_IMAGES.parent / "js" / "controllers.js").read_text()
    assert "static/images/icon-128.png" in js
    assert "hog.png" not in js


def test_old_pig_asset_is_gone():
    assert not (_IMAGES / "hog.png").exists()
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `uv run pytest tests/test_static_assets.py -q`
Expected: FAIL — index/controllers still reference `hog.png`; `hog.png` still on disk.

- [ ] **Step 3: Update the favicon links in `index.html`**

In `src/mailhedgehog/templates/index.html`, replace this line:

```html
    <link rel="icon" type="image/png" href="static/images/hog.png">
```

with:

```html
    <link rel="icon" type="image/svg+xml" href="static/images/icon.svg">
    <link rel="icon" type="image/png" sizes="32x32" href="static/images/favicon-32.png">
    <link rel="icon" type="image/png" sizes="16x16" href="static/images/favicon-16.png">
    <link rel="apple-touch-icon" href="static/images/apple-touch-icon.png">
```

- [ ] **Step 4: Update the navbar logo in `index.html`**

In the same file, replace this line:

```html
              <img src="static/images/hog.png" height="20" alt="MailHHedgehg"> MailHedgehog
```

with (new icon, taller, fixed `alt` typo):

```html
              <img src="static/images/icon.svg" height="26" alt="MailHedgehog"> MailHedgehog
```

- [ ] **Step 5: Update the desktop-notification icon in `controllers.js`**

In `src/mailhedgehog/static/js/controllers.js` (inside `createNotification`, ~line 176), replace this line:

```javascript
      icon: "images/hog.png"
```

with (correct `/static/` path — the old one 404s):

```javascript
      icon: "static/images/icon-128.png"
```

- [ ] **Step 6: Delete the pig**

```bash
git rm src/mailhedgehog/static/images/hog.png
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `uv run pytest tests/test_static_assets.py -q`
Expected: PASS (9 passed).

- [ ] **Step 8: Full verification**

```bash
uv run ruff format .
uv run ruff check .
uv run mypy
uv run pytest -q
```
Expected: ruff clean, ruff format reports nothing to change, mypy passes, **77 passed**.

- [ ] **Step 9: Commit**

```bash
git add src/mailhedgehog/templates/index.html \
  src/mailhedgehog/static/js/controllers.js tests/test_static_assets.py
git commit -m "feat(web): use hedgehog icon everywhere; drop pig logo" \
  -m "Repoint favicon links, navbar logo, and the desktop-notification" \
  -m "icon at the new hedgehog assets; fix the notification icon's stale" \
  -m "/images path; fix the navbar alt typo; delete hog.png." \
  -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage:**
- New peeking-hog icon, square SVG master → Task 1. ✓
- Raster set (16/32/180/128) → Task 2. ✓
- One icon everywhere (navbar + favicon) → Task 1 (svg) + Task 3 (navbar img + favicon links). ✓
- Delete `hog.png` → Task 3 Step 6. ✓
- Fix notification icon path → Task 3 Step 5. ✓
- Regeneration tool (Chrome) → Task 2. (Spec said "Chrome + Pillow"; tool is Chrome-only because Chrome renders exact sizes — Pillow is needed only by the dimension test. Documented in the tool docstring.) ✓
- Pillow as test-only dep → Task 2 Step 1. ✓
- Tests: served + content-type, svg square xml, png dimensions, template/JS rewiring, pig absent → Tasks 1–3. ✓
- Out of scope (`.ico`, manifest, og) → not added. ✓

**Placeholder scan:** No TBD/TODO; every code/edit step shows exact content and commands. ✓

**Type/name consistency:** `create_app(config, store)`, `Config(smtp_port=..., http_port=..., max_messages=..., max_bytes=...)`, `MessageStore(max_messages, max_bytes)`, `app.test_client()`, `await client.get(...)`, `resp.content_type`, `resp.get_data(...)` all match the existing web tests and `web.py`. Asset filenames are identical across the tool, the tests, and the `index.html`/`controllers.js` edits. ✓
