# MailHedgehog App Icon & Favicon — Design

**Date:** 2026-06-17
**Status:** Approved (brainstorm)
**Scope:** Replace the placeholder pig logo with a purpose-drawn "hedgehog that
handles e-mail" icon, used as both the navbar logo and the favicon.

## Problem

The app is called **MailHedgehog**, but the logo (`static/images/hog.png`) is a
generic brick-red **pig** silhouette inherited from MailHog. It is:

- the wrong animal,
- not square (209×154), so it crops awkwardly as a favicon,
- a single raster used for everything (favicon, navbar, desktop notification),
  with no small-size-optimized variants.

We want a cute, on-brand hedgehog mascot tied to e-mail that stays legible down
to a 16px favicon.

## Decision summary

| Decision | Choice |
| --- | --- |
| Concept | **Peeking hog** — a spiky hedgehog peeking over an envelope |
| Placement | **One icon everywhere** (navbar logo == favicon) |
| Master format | Hand-authored **SVG** (`viewBox 0 0 64 64`, square) |
| Raster fallbacks | `favicon-16.png`, `favicon-32.png`, `apple-touch-icon.png` (180), `icon-128.png` (notifications) |
| Old `hog.png` | **Deleted** after all references are repointed |
| Out of scope (YAGNI) | `favicon.ico`, PWA web manifest, Android maskable icon |

Concept was chosen by rendering candidate SVGs at true favicon sizes (16–64px)
on light/dark backgrounds and comparing them in context (navbar + browser tab).
The "peeking hog" was the only candidate that reads as **both** "clearly a
hedgehog" **and** "clearly mail" while surviving 16px.

## The icon

A spiky brick-red hedgehog peeking up over a cream envelope: a half-disc body
with radiating triangular spikes, two bold eyes with highlights, a small cream
muzzle + nose, and two tiny paws gripping the envelope's top edge.

Design choices that protect small-size legibility:

- **Square** canvas (`0 0 64 64`) so it never crops as a favicon.
- The envelope flap is a **filled triangle** (`#E4D2AD`) over the paper body, so
  the envelope is defined by a fill boundary rather than a hairline stroke that
  vanishes when downscaled to 16px.
- Bold, chunky spikes (11 of them) and large eyes that stay distinct at 16px.
- Paws and the dome shading arc are "bonus" detail that simply melt away at tiny
  sizes without hurting the read.

### Palette

| Token | Hex | Use |
| --- | --- | --- |
| Brand red | `#952225` | spikes, dome (sampled from the original logo) |
| Red shade | `#A82C2C` | subtle dome shading arc |
| Paper | `#F7EFE0` | envelope body |
| Flap | `#E4D2AD` | envelope flap fill |
| Cream | `#F0E2C6` | muzzle, paws |
| Dark | `#2A1A12` | eyes, nose, outlines |
| Tile bg | `#FBF5E9` | apple-touch / app-tile background |

### Approved master art (`icon.svg`)

This is the exact, approved source. Implementation must use it verbatim.

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><path d="M19.51,31.56 L10.83,28.27 L20.11,28.14 Z M20.11,28.14 L12.68,22.58 L21.64,25.01 Z M21.64,25.01 L16.02,17.61 L23.97,22.42 Z M23.97,22.42 L20.61,13.77 L26.92,20.58 Z M26.92,20.58 L26.07,11.33 L30.26,19.62 Z M30.26,19.62 L32.00,10.50 L33.74,19.62 Z M33.74,19.62 L37.93,11.33 L37.08,20.58 Z M37.08,20.58 L43.39,13.77 L40.03,22.42 Z M40.03,22.42 L47.98,17.61 L42.36,25.01 Z M42.36,25.01 L51.32,22.58 L43.89,28.14 Z M43.89,28.14 L53.17,28.27 L44.49,31.56 Z" fill="#952225"/><path d="M18.5,32 A13.5,13.5 0 0 1 45.5,32 Z" fill="#952225"/><path d="M23,31 A10,10 0 0 1 41,31" fill="none" stroke="#A82C2C" stroke-width="2" opacity="0.45"/><path d="M19,32 a3,3 0 0 1 6,0 Z" fill="#F0E2C6" stroke="#2A1A12" stroke-width="1"/><path d="M39,32 a3,3 0 0 1 6,0 Z" fill="#F0E2C6" stroke="#2A1A12" stroke-width="1"/><ellipse cx="32" cy="29" rx="5" ry="3.2" fill="#F0E2C6"/><circle cx="32" cy="28.6" r="2" fill="#2A1A12"/><circle cx="24.5" cy="24" r="3" fill="#2A1A12"/><circle cx="25.5" cy="23" r="0.95" fill="#fff"/><circle cx="39.5" cy="24" r="3" fill="#2A1A12"/><circle cx="40.5" cy="23" r="0.95" fill="#fff"/><rect x="10.5" y="32" width="43" height="24.5" rx="3" fill="#F7EFE0" stroke="#2A1A12" stroke-width="1.6"/><path d="M11.3,32.8 L32,46.5 L52.7,32.8 Z" fill="#E4D2AD"/><path d="M11.3,32.8 L32,46.5 L52.7,32.8" fill="none" stroke="#2A1A12" stroke-width="1.6" stroke-linejoin="round"/></svg>
```

### Approved tile art (source for `apple-touch-icon.png`)

The master, scaled to ~77% and centred on a warm rounded tile (iOS re-rounds the
corners itself; the `rx` keeps it pleasant on Android/desktop too).

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#FBF5E9"/><g transform="translate(7.5 9) scale(0.77)"><!-- icon.svg figure verbatim --></g></svg>
```

## Components & files

All assets live in `src/mailhedgehog/static/images/` (served at
`/static/images/...` by the Flask app; `static_url_path="/static"`).

| File | Source | Notes |
| --- | --- | --- |
| `icon.svg` | authored | transparent vector master; navbar + SVG favicon |
| `favicon-32.png` | rendered from `icon.svg` | transparent, 32×32 |
| `favicon-16.png` | rendered from `icon.svg` | transparent, 16×16 |
| `apple-touch-icon.png` | rendered from tile | 180×180, opaque tile bg |
| `icon-128.png` | rendered from `icon.svg` | transparent, 128×128, desktop notifications |
| ~~`hog.png`~~ | — | **deleted** |

### Regeneration tool

`tools/render_icons.py` — a documented dev utility that regenerates every raster
(and the tile) from `icon.svg` using headless Chrome + Pillow. Rasters are
committed, so contributors only need Chrome if they change the artwork. The
script follows project conventions (type annotations, `ruff format`, `mypy`).

Rationale for Chrome: the conventional `cairosvg` path requires a system
`libcairo` that is not available in this environment, whereas headless Chrome is
present and is the same engine that renders the SVG favicon in browsers.

## Wiring changes

Three existing references currently point at the pig:

1. **`templates/index.html:10`** — favicon link. Replace the single
   `<link rel="icon" ... hog.png>` with a modern set:
   ```html
   <link rel="icon" type="image/svg+xml" href="static/images/icon.svg">
   <link rel="icon" type="image/png" sizes="32x32" href="static/images/favicon-32.png">
   <link rel="icon" type="image/png" sizes="16x16" href="static/images/favicon-16.png">
   <link rel="apple-touch-icon" href="static/images/apple-touch-icon.png">
   ```
2. **`templates/index.html:22`** — navbar logo `<img>`. Point at
   `static/images/icon.svg`, set `height="26"`, and fix the `alt` text
   (currently `"MailHHedgehg"`) to `"MailHedgehog"`.
3. **`static/js/controllers.js:217`** — desktop-notification `icon:`. Change
   `"images/hog.png"` to `"static/images/icon-128.png"`. This also fixes a
   latent bug: the current `images/...` path does not match the `/static/`
   mount, so the notification icon 404s today.

Then delete `static/images/hog.png`.

## Testing (TDD)

New tests, consistent with the existing Flask web tests, added in
`tests/test_static_assets.py`:

1. **Served + content-type** — `GET /static/images/icon.svg` → 200 with
   `image/svg+xml`; each PNG (`favicon-16`, `favicon-32`, `apple-touch-icon`,
   `icon-128`) → 200 with `image/png`.
2. **SVG validity** — `icon.svg` parses as XML and declares a square `viewBox`
   (`0 0 64 64`).
3. **PNG dimensions** — via Pillow: 16×16, 32×32, 180×180, 128×128 respectively.
4. **Template rewiring** — `index.html` references `icon.svg`,
   `apple-touch-icon.png`, and the favicon PNGs, and no longer references
   `hog.png`; `controllers.js` references `icon-128.png`, not `hog.png`.
5. **Old asset gone** — `hog.png` no longer exists on disk.

Both the PNG-dimension test and the render tool need Pillow. It is **not**
currently a project dependency, so add it as a dev/test-only dependency via `uv`
(e.g. a `dev`/`test` dependency group — never via pip/requirements.txt).

## Non-goals

- No redesign of the navbar layout, colors, or typography beyond swapping the
  logo image and fixing its `alt`.
- No `favicon.ico`, web app manifest, or Open Graph image (can be added later if
  desired).
- No animation or dark-mode-specific icon variant.

## Risks / notes

- **Raster regeneration needs Chrome.** Mitigated by committing the rasters; the
  tool is only for art changes.
- **SVG favicon support.** All current evergreen browsers support
  `type="image/svg+xml"` favicons; the PNG links are the fallback for any that
  do not.
- **`apple-touch-icon` background.** It is intentionally opaque (iOS does not
  honor transparency for home-screen icons).
