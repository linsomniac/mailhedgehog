# List / Detail Layout Rework — mailhedgehog web UI

**Date:** 2026-06-18
**Status:** Approved (design dialogue + candidate render); ready for implementation plan
**Branch:** `list-detail-layout`

## Problem

The modernized Svelte SPA presents the inbox as a two-pane master/detail. When **no
message is selected** the list pane is already full-width (`flex-1`), but each *row*
wastes that width: the sender is capped at a fixed 160px, there is **no recipient
column at all**, and the rest spills into the subject. The pre-rewrite (MailHog)
UI showed more sender text, the recipient next to the sender, and more subject room.

When a message **is** selected the list collapses to a fixed **320px sidebar** with no
way to resize it, and only an implicit way back to the list (deselect). Several
secondary defects compound the experience:

1. **Dark mode does not reach the list or the reader.** `MessageRow` and
   `MessageDetail` use only light color utilities (`bg-white`, `text-gray-900`,
   `border-gray-200`, …) with **no `dark:` variants**, so toggling the theme leaves
   them light.
2. **Search shows two ✕ buttons.** The search input is `type="search"`, so the
   browser renders its own native clear control *in addition to* the app's custom
   clear button. Two ✕, visually confusing.
3. **No-HTML messages open on an empty HTML tab.** A plain-only message opens on the
   default HTML tab, which shows "No HTML part found. Switch to the Plain tab" instead
   of just showing the plain body.

## Goal

Make the list use its space when it is the only thing shown, keep From / To / Subject
visible, let the user **resize and dismiss** the reader, fix the dark-mode gap, the
double-✕, and the no-HTML-tab papercut — all additively, preserving the existing
security invariants and MailHog API compatibility.

## Decisions (resolved with the user)

- **Row layout (wide):** **Candidate B — two-line, subject-forward.**
  - Line 1: `From` (semibold) · `→ To+N` (muted) · right-aligned relative `time`.
  - Line 2: `Subject` spanning the full width · right-aligned `size`.
  - Row height stays **locked at `ROW_HEIGHT` (64px)** — the virtualizer depends on a
    fixed row height; nothing here may change it.
- **Recipients:** **first recipient + count** — e.g. `→ bob@x.io +2`. Single-recipient
  mail shows just the address (no `+0`). Uses `Summary.To[0]` and `Summary.ToCount`
  (falls back to `To.length` when `ToCount` is absent).
- **Responsive row:** one component, two layouts driven by a **CSS container query** on
  the list pane (Tailwind v4 `@container`). Wide → the two-line rich layout (with
  recipient). Narrow (sidebar) → a compact two-line form: line 1 `From` + `time`,
  line 2 `Subject`; recipient and size hidden. Both forms are exactly 64px tall.
- **Reader = resizable split.** Replace the fixed 320px sidebar with a **draggable
  vertical divider**.
  - Default list width **40%** of the main area, clamped to **[320px, 60%]**.
  - Persisted in `localStorage` under `mhg-list-width` (stored as integer px;
    re-clamped on load against the current window).
  - Divider is keyboard accessible: `role="separator"`, `aria-orientation="vertical"`,
    `tabindex="0"`, Left/Right arrows nudge by 16px (Home/End jump to min/max).
  - Pointer drag via Pointer Events (works for mouse + touch); a body-level
    `cursor: col-resize` + text-selection suppression while dragging.
- **Close reader.** A **✕** button in the reader header returns to the full-width
  list (clears the selection). **Esc** does the same while the reader is focused/open.
- **Mobile (`< 768px`).** Unchanged interaction model: selecting a message shows the
  reader full-width and hides the list; ✕/Esc returns. The splitter and its persisted
  width apply on `md+` only.
- **Dark mode.** Add `dark:` variants across `MessageRow`, the list's empty/“no
  messages” states, the splitter, and **all** of `MessageDetail` (header, tab bar, and
  every tab panel including the info/warn/error notes). Audit `EmptyState`,
  `ConfirmDialog`, `StatusDot` for parity while here.
- **Search double-✕.** Suppress the browser-native clear control with CSS
  (`::-webkit-search-cancel-button`, `::-webkit-search-decoration` → `display:none`,
  plus `appearance:none`) in `app.css`; keep the existing custom clear button (the only
  wired one). No markup change to the input type required.
- **No-HTML auto-Plain.** On message load, detect whether an HTML part exists
  (`getHtml(message)` non-empty). If not, set the initial `activeTab` to `plain` and
  build the plain tab; otherwise keep `html` as today. The existing
  "no-html-part" message stays as a fallback for the edge case where HTML is detected
  but fails to build.

## Non-goals

- No backend changes. `Summary` already carries `From`, `To` (truncated to 3),
  `ToCount`, `Subject`, `Created`, `Size`. The slim projection is untouched.
- No change to `ROW_HEIGHT` or the virtualizer contract.
- No change to the security model of `MessageDetail` (see Invariants).
- No new runtime/JS dependencies (drag + container queries are hand-rolled / Tailwind
  built-ins).

## Architecture

The change is concentrated in the SPA shell and three components; the data layer gains
only a small amount of persisted UI state.

- **`App.svelte`** owns the split. It renders the list `<section>` with an explicit
  width (px on `md+`, full-width when nothing is selected), a `Splitter` between the
  panes when a message is open on `md+`, and the reader `<section>`. It wires the
  ✕/Esc close to clearing the selection. The list pane is the **container-query
  context** (`@container`) for the row's responsive layout.
- **`Splitter.svelte` (new)** — a presentational divider: emits width changes via a
  callback prop while dragging / on keyboard nudge. Pure DOM + Pointer Events; no store
  coupling. App clamps and persists the value.
- **`MessageRow.svelte`** — rewritten to Candidate B with container-query variants and
  full dark-mode classes. Recipient helper formats `→ first +N`.
- **`MessageDetail.svelte`** — add a ✕ close button to the header; add dark-mode
  classes throughout; change initial-tab selection to honor no-HTML. The
  security-critical iframe and the "text interpolation only" rule are untouched.
- **`store.svelte.ts`** — add `listWidth` UI state with load/clamp/persist helpers and
  reset in `resetForTest()`. (Selection clear already exists as `clearSelect()`.)
- **`app.css`** — add the `::-webkit-search-cancel-button` suppression.

### Data flow (reader open)

```
user clicks row → store.select(id) → App $effect fetches full message
opens reader → App renders [ list (listWidth px) | Splitter | reader (flex-1) ]
drag splitter → Splitter callback → App clamps [320, 60%] → store.listWidth → persist
✕ / Esc → App clears selection → list returns to flex-1 (full width)
```

## Security invariants (MUST hold — `MessageDetail` is security-critical)

1. The **only** untrusted-HTML sink remains the iframe `srcdoc` attribute binding, and
   that iframe keeps `sandbox=""` **without** `allow-scripts` / `allow-same-origin` and
   `referrerpolicy="no-referrer"`. No `{@html}` is introduced anywhere.
2. Plain / Source / Headers / MIME tabs keep **text interpolation only**.
3. `buildSrcdoc()` (sanitization, cid rewrite, CSP injection) is unchanged.
4. Adding dark-mode classes and the close button must not alter any of the above.

## Testing

Frontend (Vitest + Testing Library; jsdom):

- **MessageRow:** renders From, recipient as `→ first +N` (and bare address when
  single), subject, time, size; height stays `ROW_HEIGHT`; selected state styling;
  dark-mode classes present. (Container-query *visual* switching isn't observable in
  jsdom — assert both layouts' content/classes exist in the DOM, mirroring the existing
  MessageList jsdom caveat.)
- **Splitter:** keyboard nudges emit clamped width-change callbacks (Left/Right/Home/
  End); pointer drag emits deltas. Pure-DOM, no store.
- **store:** `listWidth` defaults, clamp on load (too small / too large / NaN),
  persistence round-trip, `resetForTest()` resets it.
- **App:** opening a message shows the splitter on `md+`; ✕ clears selection (list back
  to full width); Esc clears selection. (Update existing App test mocks as needed.)
- **MessageDetail:** a message with no HTML part opens with the **Plain** tab active and
  renders the plain body (not the "no HTML" notice); a message with HTML still opens on
  HTML. Security: still no `{@html}`; iframe sandbox attributes intact.
- **SearchBar:** the custom clear button still clears; (native control suppression is
  CSS-only and not assertable in jsdom — covered by code review).

Gates (must stay green):

- Backend unaffected, but run `uv run pytest`, `ruff`, `mypy` to confirm no
  collateral.
- Frontend: `npm run check` (svelte-check 0/0), `npx vitest run`, `npm run build`,
  then `git diff --exit-code -- src/mailhedgehog/static/app` (committed-build drift
  guard).

## Risks / notes

- **Container queries:** Tailwind v4 ships container queries in core (`@container`,
  `@min-[…]:`). Confirm the project's Tailwind is v4 (it is — `app.css` uses
  `@custom-variant`). Breakpoint for "rich vs compact": container width ≈ **480px**.
- **Persisted width vs window resize:** clamp `listWidth` to `[320, 0.6 × main width]`
  on every apply so a narrow window can't strand the divider off-screen.
- **Drift guard:** the committed Vite build under `src/mailhedgehog/static/app/` must be
  rebuilt and committed in the final task; CI's path-filtered job enforces it.
