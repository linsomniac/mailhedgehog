# Web UI Modernization — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to
> implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the CDN-dependent AngularJS UI with a self-hosted Svelte+TS SPA that scales
to 1k–15k messages, with minimal additive MailHog-compatible backend changes.

**Architecture:** Single-screen Svelte 5 SPA built by Vite into a committed
`src/mailhedgehog/static/app/`, served at `/`. Virtualized infinite-scroll list backed by a
slim list/search projection + slim WebSocket frames. Secure sandboxed-iframe HTML rendering.
Backend gains decoded-header search, O(limit) pagination, a nested-cid endpoint, and security
headers — full message shape and existing endpoints stay byte-compatible.

**Tech Stack:** Backend: Quart, aiosmtpd (unchanged runtime deps), Python 3.10, pytest, ruff,
mypy. Frontend: Vite + Svelte 5 (runes) + TypeScript + Tailwind + Vitest +
`@testing-library/svelte` + `svelte-check` + `@tanstack/svelte-virtual` (dev/build-only).

## Global Constraints

- No new **runtime** Python deps (stays `quart` + `aiosmtpd`). Frontend tooling is dev-only.
- Full message shape, default `/api/v2/messages` & `/api/v2/search` item shape, and the default
  WebSocket frame are **byte-unchanged** (MailHog compat). All new behavior is gated behind
  `?summary=1`, new endpoints, or new search `kind` values.
- `Content.Headers` in the full message stays **raw** (encoded-words undecoded) — compat.
- Default caps (100 messages / 50 MB) unchanged.
- Python style: type annotations on all functions; `ruff format`; `ruff check .`; `mypy` clean
  (`files=["src"]`). Keep `AIDEV-NOTE:` anchors where code is subtle.
- Frontend: TypeScript strict; `svelte-check` clean; Vitest green. Build output committed with
  **stable (non-hashed) filenames**, `sourcemap=false`. Never `{@html}` except the sandboxed
  iframe `srcdoc`.
- Boring/maintainable over clever. TDD: failing test → minimal code → green → commit.

## Execution order (dependencies)

Backend API additions first (T1–T5, independent of the frontend), then the frontend scaffold
(T6) so build output exists, then switch index-serving + migrate tests (T7), then the frontend
feature build-out (T8–T11), then CI guard + docs (T12).

---

### Task 1 (B1): Header decoding + casefolded metadata search

**Files:**
- Modify: `src/mailhedgehog/parser.py` (add `decode_header_value`)
- Modify: `src/mailhedgehog/storage.py` (per-entry cached metadata blob; `_matches` refactor)
- Test: `tests/test_parser.py`, `tests/test_storage.py` (extend existing)

**Interfaces:**
- Produces: `parser.decode_header_value(raw: str) -> str` — RFC 2047 decode, never raises.
- Produces: new search kinds `subject`, `metadata` handled in `MessageStore.search`.
- Consumes: existing `parser.safe_str`, `storage._addr_text`.

**Details:**
- `decode_header_value`: use `email.header.decode_header` + `email.header.make_header`, wrap the
  whole thing in try/except returning `safe_str(raw)` on any failure; always return
  `safe_str`-clean text (run result through `safe_str`). Encoded-word example
  `=?UTF-8?B?Y2Fmw6k=?=` → `café`.
- In `MessageStore._Entry`, add a `search` field (a small dataclass or dict) holding
  `subject`, `frm`, `to`, each `unicodedata.normalize("NFC", casefold(...))`. Build it once at
  `add()` time from: Subject = `decode_header_value(Content.Headers["Subject"][0])` (guard
  missing); From = `Raw.From` + decoded display + `_addr_text(From)`; To = `Raw.To` joined +
  decoded display names + `_addr_text` of each `To`. Metadata = subject+frm+to concatenated.
- `_matches(entry, kind, needle)`: needle is already `casefold`+NFC; compare against the cached
  field for `from`/`to`/`subject`/`metadata`; for `containing` scan `entry.message["Raw"]["Data"]`
  via `unicodedata.normalize("NFC", data.casefold())` computed **on demand** (not cached).
  `search()` computes `needle = normalize("NFC", query.casefold())`.

**Steps:**
- [ ] Write failing tests: `decode_header_value` decodes B/Q encoded-words and returns input on
  garbage; `search(kind="subject", "café")` matches a message whose Subject header is
  `=?UTF-8?B?Y2Fmw6k=?=`; `search(kind="metadata", ...)` matches subject OR from OR to;
  composed-vs-decomposed `é` matches; `kind="from"`/`"to"`/`"containing"` still behave.
- [ ] Run tests → fail.
- [ ] Implement `decode_header_value`; add cached `_Entry.search`; refactor `_matches`/`search`.
- [ ] Run tests → pass. `ruff format && ruff check . && mypy`.
- [ ] Commit: `feat(search): decode encoded-word headers; casefolded metadata/subject search`.

---

### Task 2 (B2): O(limit) pagination, kind allowlist, clamps, threaded search route

**Files:**
- Modify: `src/mailhedgehog/storage.py` (id order list; remove per-page full reversal)
- Modify: `src/mailhedgehog/web.py` (kind allowlist → 400; clamp limit/start; thread offload)
- Test: `tests/test_storage.py`, `tests/test_api_extras.py`

**Interfaces:**
- Produces: `KNOWN_SEARCH_KINDS = {"from","to","containing","subject","metadata"}` (in storage).
- Produces: `MAX_PAGE_LIMIT = 200` clamp in `web.py`.

**Details:**
- Maintain `self._order: list[str]` in `MessageStore`: append id in `add()`; remove in
  `_pop_oldest`/`delete`/`clear`. `list()` slices newest-first from `_order` in O(limit):
  `ids = self._order[max(0, len-start-limit) : len-start][::-1]` (handle `start>=len` → empty).
  Keep returning `(items, total)` with `total = len(self._entries)`.
- `search()`: validate `kind` against `KNOWN_SEARCH_KINDS`; raise `ValueError` on unknown (web
  maps to 400). Iterate newest-first over `_order`. Do **not** early-stop the count.
- `web.py` `search` + `list_messages`: clamp `limit` to `[0, MAX_PAGE_LIMIT]`, `start>=0`.
  Wrap unknown-kind `ValueError` → `abort(400)`. For `search`, run the scan off-loop:
  `items, total = await asyncio.to_thread(store.search, kind, query, start, limit)`.

**Steps:**
- [ ] Failing tests: paging correctness incl. `start>total` → empty items + real total; deleting
  a middle message keeps order correct; unknown kind → `ValueError` (storage) and HTTP 400
  (api); `limit=10000` clamped to 200; search route returns correct results (thread offload is
  transparent).
- [ ] Run → fail. Implement. Run → pass. `ruff/mypy`.
- [ ] Commit: `perf(storage): O(limit) newest-first paging; validate search kind; clamp limits`.

---

### Task 3 (B3): Slim projection on list & search

**Files:**
- Modify: `src/mailhedgehog/web.py` (add `to_summary`; honor `summary` param)
- Test: `tests/test_api_messages.py`, `tests/test_api_extras.py`

**Interfaces:**
- Produces: `web.to_summary(message) -> dict` → `{ID, From, To, Subject, Created, Size}`.

**Details:**
- `Subject` = `parser.decode_header_value(headers.get("Subject", [""])[0])` (guard missing).
- `To` truncated: keep first 3 address dicts + add `"ToCount": <total>` (document as
  summary-only). `Size` = `message["Content"]["Size"]`.
- list & search: read `summary = request.args.get("summary")` truthy (`"1"/"true"`); when set,
  `items = [to_summary(m) for m in items]`. Envelope (`total/count/start/items`) unchanged.
  Default (no `summary`) returns the full items exactly as today.

**Steps:**
- [ ] Failing tests: `?summary=1` returns only the 6 slim keys with decoded Subject and
  truncated To+ToCount; default (no param) returns full message items unchanged; `total`/`count`
  identical for summary=0/1.
- [ ] Run → fail. Implement. Run → pass. `ruff/mypy`.
- [ ] Commit: `feat(api): additive slim ?summary=1 projection for list/search`.

---

### Task 4 (B4): Slim WebSocket frames

**Files:**
- Modify: `src/mailhedgehog/web.py` (`WebSocketBroadcaster.register(summary)`, ws route param)
- Test: `tests/test_websocket.py`

**Details:**
- `register(summary: bool=False) -> asyncio.Queue[str]`; track which queues want slim. In
  `broadcast(message)`: compute `full = json.dumps(message)` and (lazily, only if any slim
  client) `slim = json.dumps(to_summary(message))`; enqueue the appropriate string per client.
  Preserve the bounded-queue `QueueFull`→drop behavior.
- ws route: `summary = request.args.get("summary")` truthy → `register(summary=True)`. Default
  unchanged.

**Steps:**
- [ ] Failing tests: a `summary=1` subscriber receives a frame parseable to the 6 slim keys; a
  default subscriber still receives the full message; bounded-queue drop still holds for both.
- [ ] Run → fail. Implement. Run → pass. `ruff/mypy`.
- [ ] Commit: `feat(ws): opt-in slim ?summary=1 frames; full frame stays default`.

---

### Task 5 (B5a): Nested-cid endpoint + security headers

**Files:**
- Modify: `src/mailhedgehog/parser.py` (`get_mime_part_by_cid`)
- Modify: `src/mailhedgehog/web.py` (cid route; `nosniff`; `after_request` security headers)
- Test: `tests/test_api_extras.py`

**Interfaces:**
- Produces: `parser.get_mime_part_by_cid(raw: bytes, cid: str) -> tuple[bytes,str,str|None]|None`.
- Produces: `GET /api/v1/messages/<msgid>/mime/cid/<path:cid>/download`.

**Details:**
- `get_mime_part_by_cid`: `message_from_bytes(raw)`, walk **all** parts (`msg.walk()`),
  normalize each part's `Content-ID` (strip `<>`, casefold) and compare to the normalized
  requested cid (URL-decoded by Quart's `<path:>`); on match return
  `(get_payload(decode=True) or b"", get_content_type(), get_filename())`.
- cid route: 404 when unresolved. Serve `image/*` with its own type; **any non-image type →
  `application/octet-stream`**. Always set `X-Content-Type-Options: nosniff`. (Defense: a part
  declaring `text/html`/`image/svg+xml` can't execute same-origin.)
- Add `nosniff` to the existing `/download` and `/mime/part/<int>/download` responses.
- `@app.after_request`: set on all responses `X-Content-Type-Options: nosniff` and, for the
  app document/static, `Content-Security-Policy: default-src 'self'; script-src 'self';
  object-src 'none'; base-uri 'none'; frame-ancestors 'self'`. (Index-serving switch is T7.)

**Steps:**
- [ ] Failing tests: inline image in `multipart/related` nested inside `multipart/alternative`
  resolves via the cid endpoint; a part with `Content-Type: text/html` referenced by cid is
  served as `application/octet-stream` + nosniff; unknown cid → 404; security headers present.
- [ ] Run → fail. Implement. Run → pass. `ruff/mypy`.
- [ ] Commit: `feat(api): nested cid part endpoint; nosniff + CSP security headers`.

---

### Task 6 (F1): Frontend scaffold + Vite build pipeline

**Files:**
- Create: `frontend/` (package.json, package-lock.json, .nvmrc, vite.config.ts, tsconfig.json,
  svelte.config.js, tailwind.config.js, postcss.config.js, index.html, src/main.ts,
  src/App.svelte, src/app.css), `frontend/public/` (move favicons + icon.svg here)
- Create: committed build output `src/mailhedgehog/static/app/`
- Modify: `tools/render_icons.py` (retarget to `frontend/public/images/`)
- Modify: `.gitignore` (ignore `frontend/node_modules`, `frontend/.vite`, `*.map` under static)

**Details:**
- Vite config: `base: '/static/app/'`, `build.outDir: '../src/mailhedgehog/static/app'`,
  `emptyOutDir: true`, `build.sourcemap: false`, rollup `output.entryFileNames: 'app.js'`,
  `chunkFileNames: 'app-[name].js'`, `assetFileNames: 'app.[ext]'` (stable names). Tailwind +
  PostCSS wired. `@tanstack/svelte-virtual` added (used in T9).
- `App.svelte` for this task is a minimal shell ("mailhedgehog" header + empty state) that
  type-checks, tests, and **builds** — real features land in T8–T11.
- npm scripts: `dev`, `build`, `check` (svelte-check), `test` (vitest run).
- Move `src/mailhedgehog/static/images/*` to `frontend/public/images/` (so Vite emits them);
  the old `static/images/` directory is removed once T7 deletes the AngularJS assets.

**Steps:**
- [ ] Scaffold; `npm install` (writes lockfile); `npm run check` passes on the shell.
- [ ] Add one Vitest smoke test (App renders header) → green.
- [ ] `npm run build` emits `src/mailhedgehog/static/app/{index.html,app.js,app.css,images/...}`
  with stable names and no `.map`.
- [ ] Commit: `feat(ui): Vite+Svelte+TS+Tailwind scaffold; committed build pipeline` (include
  the built `static/app/` output).

---

### Task 7 (B5b + B6): Serve built index + migrate tests

**Files:**
- Modify: `src/mailhedgehog/web.py` (`index()` serves `static/app/index.html`; `no-cache`)
- Delete: `src/mailhedgehog/templates/`, `static/js/controllers.js`, `static/js/strutil.js`,
  old `static/css/style.css`, leftover `static/images/` (now under `frontend/public`)
- Modify: `tests/test_static_assets.py`
- Test: `tests/test_api_messages.py` (index serves built HTML)

**Details:**
- `index()` returns `(_PKG/"static"/"app"/"index.html").read_text()` with
  `Cache-Control: no-cache`. Built bundle gets long cache via the `?v=` query Vite emits in the
  HTML (filenames stable).
- Drop test assertions referencing `controllers.js` and AngularJS index body; **keep** favicon
  PNG-size/mimetype/SVG tests (now served from `static/app/images/` or wherever Vite emits —
  update paths). Add a test: `GET /` returns HTML referencing `app.js`/`app.css` whose paths
  resolve via the test client.

**Steps:**
- [ ] Failing tests: `GET /` returns built index referencing existing `app.js`/`app.css`;
  favicon endpoints still serve correct PNG sizes/mimetypes at new paths.
- [ ] Run → fail. Switch `index()`, delete old assets, fix tests. Run → pass. `ruff/mypy` +
  full `pytest`.
- [ ] Commit: `refactor(web): serve built SPA; remove AngularJS assets; migrate asset tests`.

---

### Task 8 (F2): Typed API client + reconnecting WebSocket

**Files:**
- Create: `frontend/src/lib/types.ts`, `frontend/src/lib/api.ts`, `frontend/src/lib/ws.ts`
- Test: `frontend/src/lib/api.test.ts`, `frontend/src/lib/ws.test.ts`

**Interfaces:**
- `types.ts`: `Addr`, `FullMessage`, `Summary` (`{ID,From,To,ToCount?,Subject,Created,Size}`),
  `Page<T> = {total,count,start,items:T[]}`.
- `api.ts`: `listMessages(start,limit)`, `searchMessages(kind,query,start,limit)` (both
  `summary=1`, all params `encodeURIComponent`), `getMessage(id)`, `deleteAll()`,
  `deleteMessage(id)`, `emlUrl(id)`, `partUrl(id,n)`, `cidUrl(id,cid)`.
- `ws.ts`: `connect(onSlim, onStatus, onOpenResync)` returning `{close}`; uses
  `/api/v2/websocket?summary=1`.

**Details:**
- `ws.ts`: capped exp backoff (1s→30s) **with jitter**, reset only on confirmed `open`, single
  in-flight reconnect timer, suppress reconnect on intentional close; status enum
  `connected|reconnecting|offline`; on every (re)open call `onOpenResync()`.

**Steps:**
- [ ] Failing tests: api builds correctly-encoded URLs (query with `&`/`#`/space); ws backoff
  uses jitter + resets on open + suppresses on manual close (fake timers + mock WebSocket).
- [ ] Run → fail. Implement. `npm run check && npm test` → pass.
- [ ] Commit: `feat(ui): typed API client + reconnecting websocket`.

---

### Task 9 (F3): Bounded windowed store + virtual list

**Files:**
- Create: `frontend/src/lib/store.svelte.ts`, `frontend/src/components/MessageList.svelte`,
  `frontend/src/components/MessageRow.svelte`
- Test: `frontend/src/lib/store.test.ts`, component tests for list/row

**Details:**
- Store (runes): rows keyed by ID with a `Set` for dedup; `total`; `selectedId`; `wsStatus`;
  `pendingNew`; LRU detail cache (~50). `loadPage(start)`; `applyLive(summary)` (prepend if at
  top & not searching, else `pendingNew++`); `resync()` (reload first page; reconcile to
  server `total`; drop rows beyond range); `clearAll()`.
- `MessageList`: `@tanstack/svelte-virtual` fixed-height rows + overscan; infinite scroll fetches
  next slim page near bottom; "N new messages" pill; on at-top prepend with `scrollTop>0` bump
  scrollTop by one row.
- `MessageRow`: fixed height; single-line From/Subject with ellipsis; relative time; size.

**Steps:**
- [ ] Failing tests: row-height invariant with a 5000-char subject; prepend-at-top vs pill;
  WS/page dedup by ID; resync reconciles to total; LRU evicts at cap.
- [ ] Run → fail. Implement. `check && test` → pass.
- [ ] Commit: `feat(ui): bounded windowed store + virtualized message list`.

---

### Task 10 (F4): Message detail + native MIME decoding

**Files:**
- Create: `frontend/src/lib/mime.ts`, `frontend/src/components/MessageDetail.svelte`
- Test: `frontend/src/lib/mime.test.ts`, detail component test

**Details:**
- `mime.ts`: `decodePart(body, encoding, charset)` via `atob`→`Uint8Array`→`TextDecoder`
  (`{fatal:false}`, fallback utf-8) + tiny quoted-printable decoder (soft `=<CRLF>`; for RFC2047
  'Q', `_`→space); **size cap** (~2–5 MB → throw/sentinel → "too large, download"); try/catch.
  `findPart(message, mime)` recursive; `buildSrcdoc(html, id, parts)` via `DOMParser`: strip
  `<script>`/`<base>`, rewrite `cid:` refs (URL-decode, casefold, strip `<>`) to `cidUrl`,
  blank unresolved; inject `<meta http-equiv=CSP>` allowing remote img/style/font/media but
  `script-src 'none'; form-action 'none'; frame-src 'none'; object-src 'none'`; serialize.
  `linkify(text)`: escape first, link only http/https/mailto, `rel="noopener noreferrer nofollow"`.
- `MessageDetail`: tabs HTML / Plain / Source / Headers / MIME parts. HTML in `<iframe sandbox
  srcdoc=... referrerpolicy=no-referrer>` (no allow-scripts/allow-same-origin), lazy on tab
  open. Source via text interpolation, size-capped. 404 on open → "no longer available" (drop
  row + cache). Delete + download `.eml` actions.

**Steps:**
- [ ] Failing tests: base64/QP/charset (shift_jis, iso-2022-jp) decode; `buildSrcdoc` strips
  script/base, injects CSP, rewrites/blanks cid; `linkify` rejects `javascript:`/`data:`.
- [ ] Run → fail. Implement. `check && test` → pass.
- [ ] Commit: `feat(ui): secure message detail view + native MIME decoding`.

---

### Task 11 (F5): App shell, search, actions, polish

**Files:**
- Modify: `frontend/src/App.svelte`; Create `SearchBar.svelte`, `ConfirmDialog.svelte`,
  `StatusDot.svelte`, `EmptyState.svelte`, `frontend/src/lib/time.ts`
- Test: search field behavior, confirm dialog, theme

**Details:**
- Header: search box + field selector (Metadata default / Subject / From / To / Body), actions
  (delete all → confirm dialog; theme toggle), connection `StatusDot`. Body kind =
  Enter-to-search; others debounced (~250ms). Wire store `loadPage`/search/live/resync; download
  `.eml`; relative time (`Intl.RelativeTimeFormat`) + size (`Intl.NumberFormat`) in `time.ts`.
  Notifications opt-in + throttled. Light/dark via `prefers-color-scheme` + toggle (persisted).
- Delete one/all reconcile the list. Empty + loading + error states.

**Steps:**
- [ ] Failing tests: Body=Enter triggers search, others debounce; delete-all confirm; theme
  toggle persists.
- [ ] Run → fail. Implement. `check && test && build` → pass; commit built output.
- [ ] Commit: `feat(ui): app shell, search, actions, theming`.

---

### Task 12 (F6): CI drift guard + docs

**Files:**
- Create: `.github/workflows/frontend.yml`
- Modify: `README.md` (rebuild command, large-inbox `MH_MAX_*` memory note, UI section)
- Optional: `frontend/README.md` / CONTRIBUTING note

**Details:**
- Path-filtered workflow (`on: pull_request/push` with `paths: [frontend/**,
  src/mailhedgehog/static/**]`): setup-node + cache, `npm ci`, `npm run check`, `npm test`,
  `npm run build`, then `git diff --exit-code -- src/mailhedgehog/static/app` (fail on drift).
- README: document `cd frontend && npm ci && npm run build` to rebuild the UI; note that real
  RSS exceeds `MH_MAX_BYTES` (raw bytes + str copies) so size containers accordingly at 15k.

**Steps:**
- [ ] Add workflow + docs. Validate YAML. Confirm path filter excludes backend-only PRs.
- [ ] Commit: `ci(ui): path-filtered build-drift guard; docs for rebuild + memory`.

---

## Final review & finish

After T12: run the whole Python suite + ruff + mypy and the frontend `check/test/build`;
dispatch the broad whole-branch code review (most capable model); address Critical/Important
findings; then use **superpowers:finishing-a-development-branch**.

## Self-review notes (author)

- Spec coverage: list/view(HTML+raw+plain+headers+MIME)/delete-all/delete-one/search
  (subject/from/to/metadata/body) all mapped; scale via virtualization + slim projection + slim
  WS + O(limit) paging + threaded body search; robustness via self-hosting, sandbox+CSP,
  bounded caches, reconnect-with-resync.
- Type consistency: `Summary`/`to_summary` keys (`ID,From,To,ToCount,Subject,Created,Size`) used
  identically in B3/B4/F2/F3. `cidUrl`↔cid route path. `KNOWN_SEARCH_KINDS` shared name.
