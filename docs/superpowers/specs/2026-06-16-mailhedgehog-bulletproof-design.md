# MailHedgehog: Tested & Bulletproof Backend — Design

- **Date:** 2026-06-16
- **Status:** Approved (pending spec review)
- **Branch:** `harden-backend`

## 1. Context & problem statement

MailHedgehog is a Python "SMTP sink": it accepts every message sent to it, stores
it in memory, and exposes it through a MailHog-compatible web UI (Angular frontend
under `static/` + `templates/index.html`). It is a deliberately simple replacement
for the MailHog Go backend.

It works for trivial ASCII, single-part email but fails on real-world mail. The
known symptom is "unicode encoding/decoding issues" that were hard to track down.
The goal of this work is to make the backend **tested and bulletproof**, with the
primary requirement that it **never gets bogged down by volume** — old messages are
auto-expired.

## 2. Root-cause analysis (current bugs)

Found by reading `mail.py`, the `mailhedgehog` entrypoint, and the frontend
(`controllers.js`, `strutil.js`, `index.html`):

1. **`envelope.content.decode()` (`mail.py:41`)** uses strict UTF-8. Any non-UTF-8
   bytes (ISO-8859-1 / Windows-1252 text, binary attachment bytes, `8bit`/`binary`
   transfer-encoding) raise `UnicodeDecodeError`, which propagates out of
   `handle_DATA`, fails the SMTP transaction, and silently loses the message. **This
   is the primary "unicode bug."**
2. **Multipart bodies (`mail.py:32`, `MIME: None`).** `data.get_payload()` on a
   multipart message returns a list of `Message` objects (not JSON-serializable), and
   `Content.MIME` is hardcoded `None`. The frontend's HTML tab, MIME tab, and
   `findMatchingMIME()` all require a **top-level** `message.MIME.Parts` tree, so every
   HTML email / attachment is broken in the UI. The field is also in the wrong place
   (nested under `Content` instead of top-level).
3. **`format_address` (`mail.py:17-19`)** does `email.split('@')`, which raises
   `ValueError` on a missing/group/malformed `From:`/`To:` header (`data['From']` can be
   `None`). Another lost-message crash.
4. **Header collapsing (`mail.py:30`).** `{x: [y] for (x, y) in data.items()}` drops
   duplicate headers (e.g. multiple `Received:`). The frontend expects name → list.
5. **Unbounded websocket queues (`mailhedgehog:35-36`).** A slow/dead WS client's
   `asyncio.Queue` grows without limit — a "bogged down" vector independent of message
   count.
6. **No error isolation.** Any exception in `format_message` kills delivery instead of
   being caught and stored as an "unparseable" placeholder.
7. **Smaller issues:** SMTP server is not shut down correctly (`cleanup` closes the
   coroutine, not the server object); `index()` reads `templates/index.html`
   CWD-relative (breaks when installed); HTTP/2 push-promises are called
   unconditionally and throw on plain HTTP; `debug=True` is hardcoded on.

## 3. Goals & non-goals

### Goals
- Never crash, never lose a message, never reject at SMTP regardless of input.
- Correct display of real-world mail: charset variety, transfer-encodings, RFC 2047
  headers, multipart (incl. nested), attachments.
- Bounded memory: auto-expiry by **message count and total bytes**, plus an SMTP-level
  per-message size cap and a bounded websocket queue.
- Full web-UI functionality (everything the frontend calls except message release).
- A real test suite (pytest), full type annotations (`mypy --strict`), `ruff`
  formatting/linting — packaged as a proper `uv` project.

### Non-goals (explicitly out of scope)
- **Message "release" / outgoing SMTP relay** — contradicts being a sink; needs a real
  relay. The UI's Release button is stubbed to degrade gracefully (see §8).
- **"Jim" chaos-monkey** endpoints.
- **Persistent storage** — remains in-memory by design (README anti-feature).
- **Time-based TTL expiry** — not included; count + size caps are sufficient and avoid
  a background sweeper. (Revisit later if needed.)
- **Frontend rewrite** — the proven Angular/`strutil.js` frontend is reused unchanged.

## 4. Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Project structure | Restructure as a typed `uv` package | Strongest foundation for "tested & bulletproof"; matches standard tooling |
| UI scope | Everything the UI exposes (except release) | Full functionality requested |
| Auto-expiry | **Count + total-size cap** (both configurable) | Protects against many-small *and* few-huge; no background sweeper |
| Encoding strategy | **Approach A — faithful & crash-proof** | Reuses proven frontend decoders; zero frontend changes; minimal risk |
| Configuration | Environment variables | 12-factor; ideal for the Docker workflow |
| CI | Minimal GitHub Actions (ruff + mypy + pytest) | Low cost; reinforces "bulletproof". May be dropped. |

### Encoding strategy (Approach A), in detail
- Operate on raw `bytes`; convert to `str` **only at the JSON boundary** using UTF-8
  with `errors="replace"` plus lone-surrogate scrubbing. This makes
  `UnicodeDecodeError` and `json.dumps` failures structurally impossible.
- Keep header values and part bodies in their **raw on-the-wire form** (RFC 2047 and
  transfer-encoding left intact). The frontend's `strutil.js` already decodes base64,
  quoted-printable, charset, and RFC 2047 encoded-words correctly.
- Populate the recursive top-level `MIME.Parts` tree so HTML mail and attachments
  render.
- Store the **original raw bytes** per message and serve *downloads* (whole message +
  individual MIME parts) from those exact bytes, so attachments are byte-perfect even
  though display JSON is lossy-but-safe.

Alternative B (decode bodies to Unicode on the backend) was rejected: it changes the
wire contract and forces rewriting the frontend decoders — more risk for a UI that
already works.

## 5. Architecture & layout

```
pyproject.toml            # uv project; deps + ruff/mypy/pytest config; console-script entrypoint
Dockerfile                # updated to uv
.github/workflows/ci.yml  # ruff + mypy + pytest (optional)
src/mailhedgehog/
  __init__.py
  __main__.py             # `python -m mailhedgehog`
  config.py               # Config dataclass, .from_env()
  parser.py               # parse(raw: bytes, mail_from, rcpt_tos, helo) -> Message dict  (pure)
  storage.py              # MessageStore: bounded by count + bytes; get/list/search/delete/clear
  smtp.py                 # SmtpHandler: parse -> store -> broadcast; never raises
  web.py                  # Quart app factory: API routes + websocket + static/templates
  app.py                  # wiring + run(); main()
  web/static/...          # moved in as package data (frontend unchanged)
  web/templates/index.html
tests/
  conftest.py
  fixtures/*.eml          # raw email corpus (the encoding matrix)
  test_parser.py
  test_storage.py
  test_config.py
  test_smtp_integration.py
  test_api.py
  test_websocket.py
```

Each module has one responsibility and is independently testable. `parser.py` is pure
(`bytes` in, `dict` out, no I/O), which makes the encoding matrix easy to lock down.

## 6. Data model (frontend contract)

Each message serializes to this MailHog-compatible shape. Note `MIME` is **top-level**
(the current code's biggest structural bug is putting it under `Content` and as `None`):

```jsonc
{
  "ID": "<uuid-hex>@mailhedgehog.example",
  "From": {"Mailbox": "...", "Domain": "...", "Params": "", "Relays": null},
  "To":   [ {"Mailbox": "...", "Domain": "...", "Params": "", "Relays": null}, ... ],
  "Created": "2026-06-16T12:34:56.789+00:00",
  "Content": {
    "Headers": { "Subject": ["..."], "Received": ["...", "..."], ... },  // name -> list, order/dupes preserved, raw values
    "Body": "<raw top-level body string>",
    "Size": 12345,
    "MIME": null
  },
  "MIME": { "Parts": [ { "Headers": {...}, "Body": "<raw>", "Size": N, "MIME": null | {"Parts": [...]} }, ... ] } | null,
  "Raw": { "From": "<envelope MAIL FROM>", "To": ["<rcpt>", ...], "Helo": "<HELO>", "Data": "<raw message, lossy-safe str>" }
}
```

Robustness rules:
- `From` / `To` are built from the **SMTP envelope** (`mail_from`, `rcpt_tos`), not from
  headers — always present, never crash on a malformed `From:` header.
- `Headers` preserves duplicates and order (name → list of raw string values).
- A "part" and `Content` share the shape `{Headers, Body, Size, MIME}`; `MIME.Parts` is
  recursive for nested multipart.
- `Size` for a leaf part is the length of its **decoded** payload bytes (meaningful
  "N bytes" for attachments); `Content.Size` is the length of the raw message body.
- All strings are surrogate-scrubbed and JSON-safe.
- `ID` uses uuid hex + `@mailhedgehog.example`; used directly in URLs (single path
  segment, no slashes).

## 7. Storage & "never get bogged down"

`MessageStore` holds an ordered map (newest-first) of entries `{json, raw_bytes, size}`,
where `size = len(raw_bytes)` (the dominant memory cost). After each insert it enforces,
in order:

1. **Count cap** — `MH_MAX_MESSAGES` (default 100): evict oldest beyond N.
2. **Total-size cap** — `MH_MAX_BYTES` (default 50 MiB): evict oldest until under budget.
   The most recently inserted message is always retained, even if it alone exceeds the
   byte cap (the default `MH_MAX_MESSAGE_SIZE` < `MH_MAX_BYTES` makes this impossible
   unless misconfigured).

Two further guards live outside the store:

3. **SMTP `data_size_limit`** — `MH_MAX_MESSAGE_SIZE` (default 25 MiB): oversized messages
   are rejected at the SMTP layer before reaching memory.
4. **Bounded websocket queue** — `asyncio.Queue(maxsize=MH_WS_QUEUE_SIZE)` (default 256):
   broadcast uses `put_nowait`; on `QueueFull` the frame is dropped for that client. A
   slow/dead client can no longer grow memory; it reconciles on the next `refresh()`.

Concurrency: everything runs on Quart's single asyncio event loop and store mutations
are synchronous (no `await` inside a critical section), so no locks are required.
Eviction does not emit a websocket event (matches MailHog); the UI's `totalMessages`
reconciles on refresh.

## 8. SMTP ingestion

- aiosmtpd `SMTP` protocol started in `@app.before_serving`; the **awaited server object**
  is stored and properly closed (`server.close()` + `await server.wait_closed()`) in
  `@app.after_serving`.
- Options: `enable_SMTPUTF8=True` (internationalized addresses), `decode_data=False`
  (we own the bytes), `data_size_limit` set from config.
- `handle_DATA` wraps `parse()` in `try/except`. On **any** exception it stores a synthetic
  "unparseable message" placeholder (best-effort `Raw.Data` + an error note in a header)
  and still returns `250 OK`. A sink must never reject; a parser bug must never lose a
  message or drop the connection.

## 9. HTTP API

| Endpoint | Today | Plan |
|---|---|---|
| `GET /api/v2/messages?start=&limit=` | exists, ignores paging | honor pagination, clamp `start`; return `{total, count, start, items}` |
| `GET /api/v1/messages/<id>` | exists | return message; proper `404` |
| `DELETE /api/v1/messages` | exists | clear all |
| `DELETE /api/v1/messages/<id>` | **missing** | delete one; `404` if absent |
| `GET /api/v2/search?kind=&query=&start=&limit=` | **missing** | `kind` ∈ {`containing`,`to`,`from`}; linear scan; same response shape as list |
| `GET /api/v1/messages/<id>/download` | **missing** | exact raw bytes; `Content-Type: message/rfc822`; attachment filename |
| `GET /api/v1/messages/<id>/mime/part/<n>/download` | **missing** | decoded bytes of top-level part `n`; its `Content-Type`; filename from `Content-Disposition` |
| `GET /api/v2/websocket` | exists | bounded queue (§7) |
| `GET /api/v2/outgoing-smtp` | missing | **stub** → `[]` (so the Release modal opens without a JS error) |
| `POST /api/v1/messages/<id>/release` | missing | **stub** → `501 Not Implemented` |

Other fixes: HTTP/2 push-promises wrapped in `try/except` (they throw on plain HTTP);
`index.html` served from a package resource path, not CWD-relative.

## 10. Configuration (environment variables)

`Config` is a dataclass built by `Config.from_env()`, fully unit-tested, with the module
defaults below.

| Variable | Default | Meaning |
|---|---|---|
| `MH_SMTP_HOST` | `""` (all interfaces) | SMTP bind address |
| `MH_SMTP_PORT` | `1025` | SMTP port |
| `MH_HTTP_HOST` | `""` (all interfaces) | HTTP bind address |
| `MH_HTTP_PORT` | `8025` | HTTP port |
| `MH_MAX_MESSAGES` | `100` | Max retained messages (count cap) |
| `MH_MAX_BYTES` | `52428800` (50 MiB) | Max total retained bytes (size cap) |
| `MH_MAX_MESSAGE_SIZE` | `26214400` (25 MiB) | SMTP `data_size_limit` (per-message) |
| `MH_WS_QUEUE_SIZE` | `256` | Per-client websocket queue bound |
| `MH_DEBUG` | `false` | Quart debug (was hardcoded `true`) |
| `MH_TLS_CERT` | unset | TLS cert path (optional, enables HTTPS/H2) |
| `MH_TLS_KEY` | unset | TLS key path (optional) |

## 11. Testing strategy (TDD)

Written test-first; gated by `ruff`, `mypy --strict`, and `pytest`.

- **`test_parser.py`** — raw `.eml` fixture corpus driving the encoding matrix, each
  asserting the exact output dict **and that nothing raises**:
  - plain ASCII single-part
  - UTF-8 body with `Content-Transfer-Encoding: 8bit`
  - ISO-8859-1 and Windows-1252 bodies
  - base64 and quoted-printable text bodies
  - RFC 2047 encoded-word `Subject` (B and Q)
  - `multipart/alternative` (text + HTML)
  - `multipart/mixed` with a binary attachment (base64)
  - nested multipart (`mixed` containing `alternative`)
  - missing `From:`, group-syntax `To:`, malformed addresses
  - duplicate headers (multiple `Received:`)
  - raw binary body (`Content-Transfer-Encoding: binary`, non-UTF-8 bytes)
  - truncated / garbage blob → "unparseable" placeholder
- **`test_storage.py`** — eviction by count, by bytes, interleaved; newest-first
  ordering; get/delete/clear; size accounting after eviction.
- **`test_config.py`** — env parsing, defaults, invalid values.
- **`test_smtp_integration.py`** — real round-trip via `aiosmtplib` on an ephemeral port;
  nasty messages (non-UTF-8, multipart, malformed) return `250` and appear via the API.
- **`test_api.py`** — Quart `test_client`: pagination, `404`s, delete-one/all, search
  kinds, byte-exact whole-message download, MIME-part download.
- **`test_websocket.py`** — broadcast on new mail; a slow client (never reads) drops
  frames without unbounded growth and the server stays healthy.

Coverage goal: the parser and storage modules at/near 100%; integration tests cover the
SMTP→store→API and websocket paths end-to-end.

## 12. Packaging & deployment

- `pyproject.toml` with `uv`; runtime deps `quart`, `aiosmtpd`; dev deps `pytest`,
  `pytest-asyncio`, `aiosmtplib`, `mypy`, `ruff`.
- Console-script entrypoint `mailhedgehog = "mailhedgehog.app:main"`, plus
  `python -m mailhedgehog`.
- `static/` and `templates/` move under `src/mailhedgehog/web/` and ship as package data;
  Quart is configured to serve them from the package path.
- `Dockerfile` updated to use `uv` (e.g. `uv sync`), preserving the existing two-port
  (`1025`/`8025`) exposure and non-root user.
- `.github/workflows/ci.yml` (optional): `ruff check`, `ruff format --check`,
  `mypy --strict src`, `pytest`.

## 13. Implementation order (high level)

1. Scaffold `uv` package + tooling config; move frontend assets; keep app runnable.
2. `config.py` + tests.
3. `parser.py` + the fixture corpus (TDD) — the core of the unicode fix.
4. `storage.py` + eviction tests.
5. `smtp.py` ingestion with error isolation + integration tests.
6. `web.py` API + websocket (incl. new endpoints) + API/WS tests.
7. `app.py` wiring, `__main__`, console script; Dockerfile; optional CI.
8. README/docs update; final `ruff`/`mypy`/`pytest` green.

A detailed step-by-step plan will be produced separately (writing-plans).
