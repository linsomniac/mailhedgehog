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
# AIDEV-NOTE: source of truth for icons is frontend/public/images/; Vite copies
# these into static/app/images/ during the build.  Regenerate here, then rebuild
# the frontend (or copy the PNGs manually) to update the served assets.
IMAGES = _ROOT / "frontend" / "public" / "images"
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
