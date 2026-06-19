# List / Detail Layout Rework — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the message list use full width with a rich two-line row (From / →To+N / Subject) when it is the only pane; make the reader a resizable, dismissable split; fix dark mode in the list+reader, the duplicate search ✕, and auto-open Plain for HTML-less mail.

**Architecture:** All changes are in the Svelte SPA under `frontend/`. The list `<section>` becomes a CSS container (`container-type: inline-size`) so one `MessageRow` adapts (rich when wide, compact when narrow) via a scoped `@container` query. `App.svelte` owns a draggable split (new `Splitter.svelte`) whose width lives in the store (`listWidth`, persisted). `MessageDetail` gains a ✕ close, dark-mode classes, and auto-Plain selection. No backend changes.

**Tech Stack:** Svelte 5 (runes) + TypeScript + Tailwind v4 (container queries are core) + Vitest/Testing Library (jsdom). Build = Vite, committed to `src/mailhedgehog/static/app/`.

## Global Constraints

- **No backend changes; no new dependencies.** `Summary` already provides `From`, `To` (truncated to 3), `ToCount`, `Subject`, `Created`, `Size`.
- **Row height is locked at `ROW_HEIGHT` (64px)** in every layout. The `.message-row` element keeps inline `height/min-height/max-height: ROW_HEIGHT; overflow: hidden`. The virtualizer depends on this.
- **Truncating spans keep inline `overflow:hidden;text-overflow:ellipsis;white-space:nowrap`** (existing tests assert these on the DOM).
- **Recipients = first + count:** `→ bob@x.io +2`; single recipient shows the bare address (no `+0`); count uses `ToCount ?? To.length`.
- **Responsive breakpoint:** container width **`480px`** — `< 480px` = compact 2-line (From+time / Subject; recipient & size hidden); `≥ 480px` = rich 2-line (line 1 From · →To+N · time; line 2 Subject · size).
- **Split width:** `MIN_LIST_WIDTH = 320`, default `40%` of viewport, max `60%` of viewport; persisted in `localStorage` key `mhg-list-width`; clamped against `window.innerWidth` on every set/load.
- **Security invariants in `MessageDetail` are unchanged:** the ONLY untrusted-HTML sink is the iframe `srcdoc` attribute binding with `sandbox=""` (no `allow-scripts`/`allow-same-origin`) + `referrerpolicy="no-referrer"`; no `{@html}` anywhere; Plain/Source/Headers/MIME use text interpolation only; `buildSrcdoc()` is untouched.
- **Gates per task:** `cd frontend && npm run check && npx vitest run` must pass. Final task also runs `npm run build` + `git diff --exit-code -- src/mailhedgehog/static/app` and the backend gates (`uv run pytest`, `uv run ruff check . && uv run ruff format --check . && uv run mypy`).
- **Commit messages** end with the trailer: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.

---

### Task 1: Suppress the duplicate native search ✕

**Files:**
- Modify: `frontend/src/app.css`
- Test: `frontend/src/components/SearchBar.test.ts` (add one regression test)

**Interfaces:**
- Consumes: nothing.
- Produces: nothing (CSS + existing custom clear button behavior unchanged).

The search input is `type="search"`, so WebKit/Blink draw their own clear ✕ on top of the app's custom one. Hide the native pseudo-elements; keep the custom button (the only wired one).

- [ ] **Step 1: Add a failing regression test** in `SearchBar.test.ts` asserting exactly one clear control exists after typing and it clears via the store. Append inside a new `describe`:

```ts
describe('SearchBar — single clear control', () => {
  it('shows exactly one (custom) clear button when a query is present, and it clears', async () => {
    render(SearchBar);
    const input = getInput();
    await fireEvent.input(input, { target: { value: 'hello' } });

    const clears = screen.getAllByTestId('search-clear');
    expect(clears.length).toBe(1);

    await fireEvent.click(clears[0]);
    expect(input.value).toBe('');
    expect(store.clearSearch).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run it** — `cd frontend && npx vitest run src/components/SearchBar.test.ts`. It should PASS already for the count/clear (the custom button is the only DOM element; the native control is a shadow pseudo-element jsdom doesn't render). This test is the regression guard locking the behavior in place while we change the CSS. If it does not pass, stop and report.

- [ ] **Step 3: Add the CSS suppression** to `frontend/src/app.css` (append after the existing `@custom-variant` line):

```css
/* AIDEV-NOTE: <input type="search"> draws a native clear (✕) control in WebKit/Blink.
   SearchBar renders its own custom clear button (data-testid="search-clear"); without
   this rule the user sees TWO ✕. Hide the native pseudo-elements; keep the custom one. */
input[type="search"]::-webkit-search-cancel-button,
input[type="search"]::-webkit-search-decoration {
  -webkit-appearance: none;
  appearance: none;
  display: none;
}
```

- [ ] **Step 4: Run gates** — `cd frontend && npm run check && npx vitest run`. Expected: PASS. (The native-control suppression itself is CSS, verified visually later — the test guards the custom button.)

- [ ] **Step 5: Commit** — `git add frontend/src/app.css frontend/src/components/SearchBar.test.ts && git commit`.

---

### Task 2: MessageRow — Candidate B (two-line, recipient, dark mode, responsive)

**Files:**
- Modify: `frontend/src/components/MessageRow.svelte`
- Test: `frontend/src/components/MessageRow.test.ts`

**Interfaces:**
- Consumes: `Summary` (`From`, `To`, `ToCount`, `Subject`, `Created`, `Size`); `ROW_HEIGHT`; `relativeTime`, `formatSize`; `store.selectedId`, `store.select`.
- Produces: a row that is rich (`From · →To+N · time` / `Subject · size`) at container width `≥480px` and compact (`From · time` / `Subject`) below it. Recipient span carries `data-testid="row-recipient"`.

- [ ] **Step 1: Extend the test helper and add failing tests.** In `MessageRow.test.ts`, replace the `makeSummary` helper so it accepts `To`/`ToCount`, and add recipient + dark-mode tests. New helper:

```ts
function makeSummary(overrides: Partial<{
  ID: string;
  Subject: string;
  Size: number;
  Created: string;
  To: { Mailbox: string; Domain: string; Params: string; Relays: null }[];
  ToCount: number;
}> = {}) {
  return {
    ID: overrides.ID ?? 'test-id',
    From: { Mailbox: 'sender', Domain: 'example.com', Params: '', Relays: null },
    To: overrides.To ?? [{ Mailbox: 'rcpt', Domain: 'example.com', Params: '', Relays: null }],
    ToCount: overrides.ToCount,
    Subject: overrides.Subject ?? 'Test Subject',
    Created: overrides.Created ?? new Date(Date.now() - 60_000).toISOString(),
    Size: overrides.Size ?? 1024,
  };
}
```

Add these tests:

```ts
describe('MessageRow — recipient', () => {
  it('shows the first recipient with no +N for a single recipient', () => {
    render(MessageRow, { props: { summary: makeSummary() } });
    const recip = screen.getByTestId('row-recipient');
    expect(recip.textContent).toContain('rcpt@example.com');
    expect(recip.textContent).not.toContain('+');
  });

  it('shows first recipient + count using ToCount', () => {
    render(MessageRow, {
      props: {
        summary: makeSummary({
          To: [{ Mailbox: 'bob', Domain: 'x.io', Params: '', Relays: null }],
          ToCount: 3,
        }),
      },
    });
    const recip = screen.getByTestId('row-recipient');
    expect(recip.textContent).toContain('bob@x.io');
    expect(recip.textContent).toContain('+2');
  });

  it('falls back to To.length when ToCount is absent', () => {
    render(MessageRow, {
      props: {
        summary: makeSummary({
          To: [
            { Mailbox: 'a', Domain: 'x.io', Params: '', Relays: null },
            { Mailbox: 'b', Domain: 'x.io', Params: '', Relays: null },
          ],
        }),
      },
    });
    expect(screen.getByTestId('row-recipient').textContent).toContain('+1');
  });

  it('renders no recipient element when To is empty', () => {
    render(MessageRow, { props: { summary: makeSummary({ To: [] }) } });
    expect(screen.queryByTestId('row-recipient')).toBeNull();
  });
});

describe('MessageRow — dark mode', () => {
  it('the row element carries dark: color variants', () => {
    const { container } = render(MessageRow, { props: { summary: makeSummary() } });
    const row = container.querySelector('.message-row') as HTMLElement;
    expect(row.className).toContain('dark:');
  });
});
```

- [ ] **Step 2: Run to confirm failure** — `npx vitest run src/components/MessageRow.test.ts`. Expected: the new tests FAIL (no `row-recipient`, no `dark:` on row yet).

- [ ] **Step 3: Rewrite `MessageRow.svelte`** to Candidate B. Replace the whole file:

```svelte
<script lang="ts">
  // AIDEV-NOTE: MessageRow renders a single fixed-height (ROW_HEIGHT=64px) row.
  // Layout = Candidate B (two-line, subject-forward), responsive via a scoped @container query:
  //   - container <480px (narrow sidebar): compact — line1 From + time, line2 Subject.
  //   - container >=480px (wide list):     rich — line1 From + →To+N + time, line2 Subject + size.
  // The list <section> in App.svelte sets `container-type: inline-size` to drive this.
  // CRITICAL: height is locked at ROW_HEIGHT with overflow:hidden so a 5000-char subject
  // cannot change row height — the virtualizer offset math depends on it.
  // Truncating spans keep inline overflow/ellipsis/nowrap (asserted by tests).

  import type { Summary } from '../lib/types.js';
  import { store } from '../lib/store.svelte.js';
  import { relativeTime, formatSize } from '../lib/time.js';
  import { ROW_HEIGHT } from './constants.js';

  interface Props {
    summary: Summary;
  }

  let { summary }: Props = $props();

  const ELL = 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';

  const fromDisplay = $derived(
    summary.From ? `${summary.From.Mailbox}@${summary.From.Domain}` : 'Unknown sender',
  );

  // AIDEV-NOTE: first recipient + count. ToCount is the true total (To[] is truncated to 3).
  const recipientDisplay = $derived.by(() => {
    const to = summary.To ?? [];
    if (to.length === 0) return '';
    const first = `${to[0].Mailbox}@${to[0].Domain}`;
    const total = summary.ToCount ?? to.length;
    const extra = total - 1;
    return extra > 0 ? `${first} +${extra}` : first;
  });

  const isSelected = $derived(store.selectedId === summary.ID);

  function handleClick() {
    store.select(summary.ID);
  }
</script>

<button
  type="button"
  class="message-row w-full text-left px-4 flex items-center border-b border-gray-100 dark:border-gray-700 cursor-pointer transition-colors {isSelected
    ? 'bg-blue-50 dark:bg-blue-900/30'
    : 'bg-white dark:bg-gray-800 hover:bg-gray-50 dark:hover:bg-gray-700/40'}"
  style="height: {ROW_HEIGHT}px; min-height: {ROW_HEIGHT}px; max-height: {ROW_HEIGHT}px; overflow: hidden;"
  onclick={handleClick}
  aria-pressed={isSelected}
  aria-label="Message from {fromDisplay}: {summary.Subject}"
>
  <div class="row-col">
    <div class="row-line1">
      <span class="row-sender text-sm font-medium text-gray-900 dark:text-gray-100" style={ELL}>
        {fromDisplay}
      </span>
      {#if recipientDisplay}
        <span
          class="row-recip text-xs text-gray-500 dark:text-gray-400"
          style={ELL}
          data-testid="row-recipient"
        >
          → {recipientDisplay}
        </span>
      {/if}
      <span class="row-time text-xs text-gray-400 dark:text-gray-500">
        {relativeTime(summary.Created)}
      </span>
    </div>
    <div class="row-line2">
      <span class="row-subject text-sm text-gray-700 dark:text-gray-300" style={ELL}>
        {summary.Subject || '(no subject)'}
      </span>
      <span class="row-size text-xs text-gray-400 dark:text-gray-500">
        {formatSize(summary.Size)}
      </span>
    </div>
  </div>
</button>

<style>
  /* AIDEV-NOTE: structural + responsive layout. Colors/typography live in Tailwind
     classes above; this block only does flex sizing and the container-query show/hide.
     The @container query resolves to the nearest ancestor with container-type
     (the list <section> in App.svelte). */
  .row-col {
    display: flex;
    flex-direction: column;
    justify-content: center;
    flex: 1 1 auto;
    min-width: 0;
    gap: 2px;
  }
  .row-line1,
  .row-line2 {
    display: flex;
    align-items: baseline;
    gap: 8px;
    min-width: 0;
  }
  /* Compact (narrow) defaults: sender grows, recipient + size hidden. */
  .row-sender { flex: 1 1 auto; min-width: 0; }
  .row-recip { display: none; flex: 1 1 auto; min-width: 0; }
  .row-time { flex: 0 0 auto; }
  .row-subject { flex: 1 1 auto; min-width: 0; }
  .row-size { display: none; flex: 0 0 auto; }

  /* Rich (wide) layout. */
  @container (min-width: 480px) {
    .row-sender { flex: 0 0 auto; max-width: 45%; }
    .row-recip { display: block; }
    .row-size { display: block; }
  }
</style>
```

- [ ] **Step 4: Run row tests** — `npx vitest run src/components/MessageRow.test.ts`. Expected: PASS (existing height/ellipsis/subject/size/time/no-subject tests + new recipient/dark tests).

- [ ] **Step 5: Run gates** — `npm run check && npx vitest run`. Expected: PASS.

- [ ] **Step 6: Commit** — `git add frontend/src/components/MessageRow.svelte frontend/src/components/MessageRow.test.ts && git commit`.

---

### Task 3: Store — persisted `listWidth`

**Files:**
- Modify: `frontend/src/lib/store.svelte.ts`
- Test: `frontend/src/lib/store.test.ts`

**Interfaces:**
- Produces: exported `clampListWidth(px, viewport)`, `MIN_LIST_WIDTH`; store members `listWidth` (getter), `setListWidth(px)`, `loadListWidth()`; `resetForTest()` resets `listWidth`.
- Consumes: `window.innerWidth`, `localStorage`.

- [ ] **Step 1: Add failing tests** to `store.test.ts`. Append:

```ts
import { clampListWidth, MIN_LIST_WIDTH } from './store.svelte.js';

describe('clampListWidth', () => {
  it('never returns below MIN_LIST_WIDTH', () => {
    expect(clampListWidth(100, 2000)).toBe(MIN_LIST_WIDTH);
  });
  it('never exceeds 60% of the viewport', () => {
    expect(clampListWidth(5000, 1000)).toBe(600);
  });
  it('passes through an in-range value (floored)', () => {
    expect(clampListWidth(450.7, 2000)).toBe(450);
  });
  it('returns the 40% default for non-finite input', () => {
    expect(clampListWidth(NaN, 1000)).toBe(400);
  });
  it('min wins when 60% of a tiny viewport is below MIN', () => {
    expect(clampListWidth(400, 400)).toBe(MIN_LIST_WIDTH);
  });
});

describe('store.listWidth', () => {
  beforeEach(() => {
    localStorage.clear();
    store.resetForTest();
  });
  it('defaults to ~40% of the viewport', () => {
    // jsdom default innerWidth is 1024 → floor(1024*0.4) = 409
    expect(store.listWidth).toBe(clampListWidth(NaN, window.innerWidth));
  });
  it('setListWidth clamps and persists', () => {
    store.setListWidth(100);
    expect(store.listWidth).toBe(MIN_LIST_WIDTH);
    expect(localStorage.getItem('mhg-list-width')).toBe(String(MIN_LIST_WIDTH));
  });
  it('loadListWidth re-reads and clamps a stored value', () => {
    localStorage.setItem('mhg-list-width', '99999');
    store.loadListWidth();
    expect(store.listWidth).toBe(clampListWidth(99999, window.innerWidth));
  });
  it('resetForTest restores the default', () => {
    store.setListWidth(500);
    store.resetForTest();
    expect(store.listWidth).toBe(clampListWidth(NaN, window.innerWidth));
  });
});
```

- [ ] **Step 2: Run to confirm failure** — `npx vitest run src/lib/store.test.ts`. Expected: FAIL (no exports yet).

- [ ] **Step 3: Implement in `store.svelte.ts`.** Add the constants + pure helper near the top (after `LRU_CAP`):

```ts
// AIDEV-NOTE: List-pane width for the resizable reader split. Persisted across reloads,
// clamped to [MIN_LIST_WIDTH, 60% viewport]; defaults to 40% viewport. Pure helper so it
// is deterministically testable without touching window/localStorage.
export const MIN_LIST_WIDTH = 320;
const LIST_MAX_FRACTION = 0.6;
const LIST_DEFAULT_FRACTION = 0.4;
const LIST_WIDTH_KEY = 'mhg-list-width';

export function clampListWidth(px: number, viewport: number): number {
  const max = Math.max(MIN_LIST_WIDTH, Math.floor(viewport * LIST_MAX_FRACTION));
  const fallback = Math.min(max, Math.max(MIN_LIST_WIDTH, Math.floor(viewport * LIST_DEFAULT_FRACTION)));
  if (!Number.isFinite(px)) return fallback;
  return Math.min(max, Math.max(MIN_LIST_WIDTH, Math.floor(px)));
}

function viewportWidth(): number {
  return typeof window !== 'undefined' ? window.innerWidth : 1280;
}
```

Inside `createStore()`, add state + functions (place `listWidth` near the other `$state`):

```ts
let listWidth = $state(clampListWidth(NaN, viewportWidth()));
```

```ts
function setListWidth(px: number): void {
  listWidth = clampListWidth(px, viewportWidth());
  try {
    localStorage.setItem(LIST_WIDTH_KEY, String(listWidth));
  } catch {
    /* ignore storage failures (private mode etc.) */
  }
}

function loadListWidth(): void {
  let stored = NaN;
  try {
    const v = localStorage.getItem(LIST_WIDTH_KEY);
    if (v != null) stored = parseInt(v, 10);
  } catch {
    /* ignore */
  }
  listWidth = clampListWidth(stored, viewportWidth());
}
```

In `resetForTest()` add: `listWidth = clampListWidth(NaN, viewportWidth());`

In the returned object, add the getter and methods:

```ts
get listWidth() { return listWidth; },
setListWidth,
loadListWidth,
```

- [ ] **Step 4: Run store tests** — `npx vitest run src/lib/store.test.ts`. Expected: PASS.

- [ ] **Step 5: Run gates** — `npm run check && npx vitest run`. Expected: PASS.

- [ ] **Step 6: Commit** — `git add frontend/src/lib/store.svelte.ts frontend/src/lib/store.test.ts && git commit`.

---

### Task 4: Splitter component (draggable divider)

**Files:**
- Create: `frontend/src/components/Splitter.svelte`
- Test: `frontend/src/components/Splitter.test.ts`

**Interfaces:**
- Produces: `Splitter` with props `onDrag: (clientX: number) => void`, `onNudge: (deltaPx: number) => void`, optional `ariaValueNow/Min/Max: number`. Root has `data-testid="splitter"`, `role="separator"`, `aria-orientation="vertical"`, `tabindex="0"`. Keyboard: ArrowLeft → `onNudge(-16)`, ArrowRight → `onNudge(16)`, Home → `onNudge(-1e7)`, End → `onNudge(1e7)`. Pointer drag → `onDrag(clientX)` per move while pressed.
- Consumes: nothing (pure presentational; App wires the callbacks to `store.setListWidth`).

- [ ] **Step 1: Write failing tests** `Splitter.test.ts`:

```ts
import { render, screen, fireEvent } from '@testing-library/svelte';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Splitter from './Splitter.svelte';

let onDrag: ReturnType<typeof vi.fn>;
let onNudge: ReturnType<typeof vi.fn>;

beforeEach(() => {
  onDrag = vi.fn();
  onNudge = vi.fn();
});

function renderSplitter() {
  return render(Splitter, { props: { onDrag, onNudge, ariaValueNow: 400, ariaValueMin: 320, ariaValueMax: 600 } });
}

describe('Splitter', () => {
  it('renders an accessible vertical separator', () => {
    renderSplitter();
    const el = screen.getByTestId('splitter');
    expect(el.getAttribute('role')).toBe('separator');
    expect(el.getAttribute('aria-orientation')).toBe('vertical');
    expect(el.getAttribute('tabindex')).toBe('0');
    expect(el.getAttribute('aria-valuenow')).toBe('400');
  });

  it('ArrowLeft/ArrowRight nudge by ∓16', async () => {
    renderSplitter();
    const el = screen.getByTestId('splitter');
    await fireEvent.keyDown(el, { key: 'ArrowLeft' });
    expect(onNudge).toHaveBeenCalledWith(-16);
    await fireEvent.keyDown(el, { key: 'ArrowRight' });
    expect(onNudge).toHaveBeenCalledWith(16);
  });

  it('Home/End nudge to the extremes', async () => {
    renderSplitter();
    const el = screen.getByTestId('splitter');
    await fireEvent.keyDown(el, { key: 'Home' });
    expect(onNudge).toHaveBeenCalledWith(-1e7);
    await fireEvent.keyDown(el, { key: 'End' });
    expect(onNudge).toHaveBeenCalledWith(1e7);
  });

  it('drags: pointermove after pointerdown reports clientX', async () => {
    renderSplitter();
    const el = screen.getByTestId('splitter');
    await fireEvent.pointerDown(el, { pointerId: 1, clientX: 400 });
    await fireEvent.pointerMove(el, { clientX: 520 });
    expect(onDrag).toHaveBeenCalledWith(520);
  });

  it('does not report drag before pointerdown', async () => {
    renderSplitter();
    const el = screen.getByTestId('splitter');
    await fireEvent.pointerMove(el, { clientX: 520 });
    expect(onDrag).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run to confirm failure** — `npx vitest run src/components/Splitter.test.ts`. Expected: FAIL (component missing).

- [ ] **Step 3: Create `Splitter.svelte`:**

```svelte
<script lang="ts">
  // AIDEV-NOTE: Presentational vertical divider for the list/reader split. It translates
  // pointer drags and keyboard nudges into callback calls; it owns NO width state — App
  // clamps + persists via store.setListWidth. Home/End pass ±1e7 sentinels that the
  // consumer's clamp resolves to min/max. Hidden on mobile (list is full-screen there).

  interface Props {
    onDrag: (clientX: number) => void;
    onNudge: (deltaPx: number) => void;
    ariaValueNow?: number;
    ariaValueMin?: number;
    ariaValueMax?: number;
  }

  let { onDrag, onNudge, ariaValueNow, ariaValueMin, ariaValueMax }: Props = $props();

  const STEP = 16;
  let dragging = $state(false);

  function onPointerDown(e: PointerEvent): void {
    dragging = true;
    e.preventDefault();
    const el = e.currentTarget as HTMLElement;
    try { el.setPointerCapture?.(e.pointerId); } catch { /* jsdom / unsupported */ }
    if (typeof document !== 'undefined') {
      document.body.style.userSelect = 'none';
      document.body.style.cursor = 'col-resize';
    }
  }

  function onPointerMove(e: PointerEvent): void {
    if (!dragging) return;
    onDrag(e.clientX);
  }

  function endDrag(e: PointerEvent): void {
    if (!dragging) return;
    dragging = false;
    const el = e.currentTarget as HTMLElement;
    try { el.releasePointerCapture?.(e.pointerId); } catch { /* ignore */ }
    if (typeof document !== 'undefined') {
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
    }
  }

  function onKeyDown(e: KeyboardEvent): void {
    switch (e.key) {
      case 'ArrowLeft': onNudge(-STEP); e.preventDefault(); break;
      case 'ArrowRight': onNudge(STEP); e.preventDefault(); break;
      case 'Home': onNudge(-1e7); e.preventDefault(); break;
      case 'End': onNudge(1e7); e.preventDefault(); break;
    }
  }
</script>

<div
  role="separator"
  aria-orientation="vertical"
  aria-label="Resize message list"
  aria-valuenow={ariaValueNow}
  aria-valuemin={ariaValueMin}
  aria-valuemax={ariaValueMax}
  tabindex="0"
  data-testid="splitter"
  class="hidden md:block shrink-0 w-1.5 cursor-col-resize self-stretch
         bg-gray-200 dark:bg-gray-700 hover:bg-indigo-400 dark:hover:bg-indigo-500
         focus:outline-none focus:bg-indigo-500 transition-colors {dragging ? 'bg-indigo-500' : ''}"
  onpointerdown={onPointerDown}
  onpointermove={onPointerMove}
  onpointerup={endDrag}
  onpointercancel={endDrag}
></div>
```

- [ ] **Step 4: Run splitter tests** — `npx vitest run src/components/Splitter.test.ts`. Expected: PASS.

- [ ] **Step 5: Run gates** — `npm run check && npx vitest run`. Expected: PASS.

- [ ] **Step 6: Commit** — `git add frontend/src/components/Splitter.svelte frontend/src/components/Splitter.test.ts && git commit`.

---

### Task 5: MessageDetail — ✕ close, dark mode, auto-Plain

**Files:**
- Modify: `frontend/src/components/MessageDetail.svelte`
- Test: `frontend/src/components/MessageDetail.test.ts`

**Interfaces:**
- Consumes: `getHtml(message)` (returns `''` when no HTML part).
- Produces: optional prop `onClose?: () => void`; a header ✕ button `data-testid="reader-close"`; initial `activeTab = getHtml(message) ? 'html' : 'plain'`.
- Security invariants from Global Constraints MUST hold — do not touch the iframe attributes, `buildSrcdoc()`, or introduce `{@html}`.

- [ ] **Step 1: Update existing tests + add new ones** in `MessageDetail.test.ts`.

(a) Replace the test `shows the HTML panel by default` so it uses an HTML message:

```ts
  it('shows the HTML panel by default when an HTML part exists', () => {
    render(MessageDetail, { props: { message: makeHtmlMessage() } });
    expect(screen.getByTestId('panel-html')).toBeTruthy();
  });
```

(b) Replace the test `shows no-html-part message when message has no HTML part` with these three:

```ts
  it('opens on the Plain tab when the message has no HTML part', async () => {
    render(MessageDetail, { props: { message: makeFullMessage() } }); // plain only
    await waitFor(() => {
      expect(screen.getByTestId('panel-plain')).toBeTruthy();
      expect(screen.getByText(/Hello, plain text world!/)).toBeTruthy();
    });
    expect(screen.queryByTestId('panel-html')).toBeNull();
  });

  it('still shows the no-html notice if the user manually opens HTML on a plain-only message', async () => {
    render(MessageDetail, { props: { message: makeFullMessage() } });
    await fireEvent.click(screen.getByTestId('tab-html'));
    await waitFor(() => {
      expect(screen.getByText(/No HTML part found/)).toBeTruthy();
    });
  });
```

(c) Add close + dark tests:

```ts
describe('MessageDetail — close + dark', () => {
  it('renders a close button that calls onClose', async () => {
    const onClose = vi.fn();
    render(MessageDetail, { props: { message: makeFullMessage(), onClose } });
    await fireEvent.click(screen.getByTestId('reader-close'));
    expect(onClose).toHaveBeenCalled();
  });

  it('does not crash when onClose is omitted', async () => {
    render(MessageDetail, { props: { message: makeFullMessage() } });
    await fireEvent.click(screen.getByTestId('reader-close')); // no throw
    expect(screen.getByTestId('message-detail')).toBeTruthy();
  });

  it('root carries dark: color variants', () => {
    const { container } = render(MessageDetail, { props: { message: makeFullMessage() } });
    const root = container.querySelector('[data-testid="message-detail"]') as HTMLElement;
    expect(root.className).toContain('dark:');
  });
});
```

- [ ] **Step 2: Run to confirm failures** — `npx vitest run src/components/MessageDetail.test.ts`. Expected: the new/edited tests FAIL.

- [ ] **Step 3: Edit `MessageDetail.svelte`.**

(a) Props — add `onClose`:

```ts
  interface Props {
    message: FullMessage;
    onClose?: () => void;
  }

  let { message, onClose }: Props = $props();
```

(b) Initial-tab `$effect` (replace the existing one at the bottom of the script) — honor no-HTML:

```ts
  // AIDEV-NOTE: pick the initial tab by content. A plain-only message opens directly on
  // Plain (instead of the HTML tab's "no HTML part" notice). HTML messages open on HTML.
  $effect(() => {
    srcdocCache = null;
    srcdocError = null;
    plainTokens = [];
    plainError = null;
    const hasHtml = !!getHtml(message);
    activeTab = hasHtml ? 'html' : 'plain';
    if (hasHtml) {
      buildHtmlTab();
    } else {
      buildPlainTab();
    }
  });
```

(c) Root element — add dark classes (line ~159):

```svelte
<div class="flex flex-col h-full bg-white dark:bg-gray-900 border-l border-gray-200 dark:border-gray-700" data-testid="message-detail">
```

(d) Header bar — add dark classes and a ✕ close button. Replace the header `<div class="px-4 py-3 ...">` block (through its closing `</div>` for the actions) with:

```svelte
  <!-- Header bar: From, Subject, actions -->
  <div class="px-4 py-3 border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 flex items-start justify-between gap-4">
    <div class="min-w-0">
      <div class="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">
        {message.From?.Mailbox ?? ''}@{message.From?.Domain ?? ''}
      </div>
      <div class="text-sm text-gray-700 dark:text-gray-300 truncate mt-0.5">
        {message.Content?.Headers?.['Subject']?.[0] ?? '(no subject)'}
      </div>
    </div>
    <div class="flex-shrink-0 flex items-center gap-2">
      <a
        href={emlUrl(message.ID)}
        download
        class="text-xs px-3 py-1.5 rounded border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
        aria-label="Download .eml file"
      >
        Download .eml
      </a>
      <button
        type="button"
        onclick={handleDelete}
        class="text-xs px-3 py-1.5 rounded border border-red-300 dark:border-red-700 text-red-700 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors"
        aria-label="Delete message"
      >
        Delete
      </button>
      <button
        type="button"
        onclick={() => onClose?.()}
        class="p-1.5 rounded-md text-gray-500 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-700 focus:outline-none focus:ring-2 focus:ring-indigo-500 transition-colors"
        aria-label="Close message"
        title="Close (Esc)"
        data-testid="reader-close"
      >
        <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
          <path fill-rule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clip-rule="evenodd" />
        </svg>
      </button>
    </div>
  </div>
```

(e) Tab bar — dark classes. Replace the tablist `<div>` opening and the per-tab `class:` block:

```svelte
  <div class="flex border-b border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900" role="tablist" aria-label="Message view tabs">
    {#each ([['html', 'HTML'], ['plain', 'Plain'], ['source', 'Source'], ['headers', 'Headers'], ['parts', 'MIME Parts']] as const) as [tab, label]}
      <button
        type="button"
        role="tab"
        aria-selected={activeTab === tab}
        aria-controls="tab-panel-{tab}"
        class="px-4 py-2 text-sm font-medium border-b-2 transition-colors"
        class:border-blue-500={activeTab === tab}
        class:text-blue-600={activeTab === tab}
        class:dark:text-blue-400={activeTab === tab}
        class:border-transparent={activeTab !== tab}
        class:text-gray-500={activeTab !== tab}
        class:dark:text-gray-400={activeTab !== tab}
        class:hover:text-gray-700={activeTab !== tab}
        class:dark:hover:text-gray-200={activeTab !== tab}
        onclick={() => openTab(tab)}
        data-testid="tab-{tab}"
      >
        {label}
      </button>
    {/each}
  </div>
```

(f) Panels — add dark text variants to the muted/notice text and the headers/parts/source/plain content. Apply these dark variants (leave the colored amber/red/blue notice boxes as-is, they read acceptably; just add dark text where pure gray text is used):
  - `panel-plain` empty + `<pre>`: `text-gray-800` → add `dark:text-gray-200`; "No plain text part" `text-gray-400` is fine.
  - Source `<pre>`: `text-gray-700` → add `dark:text-gray-300`.
  - Headers `<dt>` `text-gray-700` → `dark:text-gray-300`; `<dd>` `text-gray-600` → `dark:text-gray-400`.
  - MIME parts `<li>` border `border-gray-200` → `dark:border-gray-700`; `font-mono text-gray-700` → `dark:text-gray-300`.
  - "Loading HTML preview..." / generic `text-gray-400`/`text-gray-500` are fine in dark.

- [ ] **Step 4: Run MessageDetail tests** — `npx vitest run src/components/MessageDetail.test.ts`. Expected: PASS (including all the existing security tests — sandbox attrs, no-`{@html}` source/headers).

- [ ] **Step 5: Run gates** — `npm run check && npx vitest run`. Expected: PASS.

- [ ] **Step 6: Commit** — `git add frontend/src/components/MessageDetail.svelte frontend/src/components/MessageDetail.test.ts && git commit`.

---

### Task 6: App — resizable split, container context, ✕/Esc close, full-width list-only

**Files:**
- Modify: `frontend/src/App.svelte`
- Test: `frontend/src/App.test.ts` (extend mock), `frontend/src/App.reader.test.ts` (new)

**Interfaces:**
- Consumes: `store.listWidth`, `store.setListWidth`, `store.loadListWidth`, `store.clearSelect`; `Splitter` (Task 4); `MessageDetail` `onClose` (Task 5); `clampListWidth` not needed in App.
- Produces: a `<main bind:this>` with a list `<section>` (full-width when nothing selected, `width:listWidth px` + container-type when reading), a `Splitter` between panes when the reader is open, a reader `<section>` with `MessageDetail onClose`. ✕ and Esc both clear the selection. The old "Select a message" placeholder pane is removed (list fills the screen instead).

- [ ] **Step 1: Extend the existing `App.test.ts` mock** so App still mounts: add to the mocked `store` object the members `listWidth: 400`, `setListWidth: vi.fn()`, `loadListWidth: vi.fn()`, `clearSelect: vi.fn()`. (These are read on mount / in the body.) Run `npx vitest run src/App.test.ts` and confirm the existing smoke tests still PASS after you add the new `onMount` call in Step 3 (do this iteratively).

- [ ] **Step 2: Write the new reader test file** `frontend/src/App.reader.test.ts`:

```ts
// AIDEV-NOTE: App reader-open tests. A dedicated mock where selectedId is set and select()
// resolves a (plain) message, so the reader, splitter, and close affordances render.
import { render, screen, fireEvent, waitFor } from '@testing-library/svelte';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FullMessage } from './lib/types.js';

const fullMessage: FullMessage = {
  ID: 'm1',
  From: { Mailbox: 'sender', Domain: 'example.com', Params: '', Relays: null },
  To: [{ Mailbox: 'rcpt', Domain: 'example.com', Params: '', Relays: null }],
  Content: {
    Headers: { 'Content-Type': ['text/plain; charset=utf-8'], Subject: ['Hi'] },
    Body: 'plain body',
    Size: 10,
    MIME: null,
  },
  MIME: null,
  Created: new Date().toISOString(),
  Raw: { From: 'sender@example.com', To: ['rcpt@example.com'], Helo: 'localhost', Data: 'Subject: Hi\r\n\r\nplain body' },
};

const clearSelect = vi.fn();

vi.mock('./lib/store.svelte.js', () => ({
  store: {
    rows: [],
    total: 0,
    selectedId: 'm1',
    wsStatus: 'connected',
    pendingNew: 0,
    atTop: true,
    loading: false,
    proxyImages: false,
    selectError: null,
    search: { active: false, kind: '', query: '' },
    listWidth: 400,
    loadConfig: vi.fn().mockResolvedValue(undefined),
    loadFirst: vi.fn().mockResolvedValue(undefined),
    loadListWidth: vi.fn(),
    setListWidth: vi.fn(),
    loadMore: vi.fn(),
    applyLive: vi.fn(),
    resync: vi.fn().mockResolvedValue(undefined),
    setWsStatus: vi.fn(),
    setAtTop: vi.fn(),
    select: vi.fn().mockResolvedValue(fullMessage),
    clearSelect,
    deleteOne: vi.fn(),
    deleteAllMessages: vi.fn().mockResolvedValue(undefined),
    clearSearch: vi.fn(),
    setSearch: vi.fn(),
    showPending: vi.fn(),
  },
}));

vi.mock('./lib/ws.js', () => ({ connect: vi.fn(() => ({ close: vi.fn() })) }));

beforeEach(() => {
  clearSelect.mockClear();
  if (!window.matchMedia) {
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: vi.fn(() => ({ matches: false, media: '', onchange: null, addListener: vi.fn(), removeListener: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: vi.fn() })),
    });
  }
});

import App from './App.svelte';

describe('App — reader open', () => {
  it('renders the reader and splitter for a selected message', async () => {
    render(App);
    await waitFor(() => expect(screen.getByTestId('message-detail')).toBeTruthy());
    expect(screen.getByTestId('splitter')).toBeTruthy();
  });

  it('clicking the reader ✕ clears the selection', async () => {
    render(App);
    await waitFor(() => expect(screen.getByTestId('reader-close')).toBeTruthy());
    await fireEvent.click(screen.getByTestId('reader-close'));
    expect(clearSelect).toHaveBeenCalled();
  });

  it('pressing Escape clears the selection', async () => {
    render(App);
    await waitFor(() => expect(screen.getByTestId('message-detail')).toBeTruthy());
    await fireEvent.keyDown(window, { key: 'Escape' });
    expect(clearSelect).toHaveBeenCalled();
  });
});
```

- [ ] **Step 3: Run to confirm failure** — `npx vitest run src/App.reader.test.ts`. Expected: FAIL (no splitter/close/Esc wiring yet).

- [ ] **Step 4: Edit `App.svelte`.**

(a) Import Splitter (with the other component imports):

```ts
  import Splitter from './components/Splitter.svelte';
```

(b) Add layout state + handlers (near the other state, after `selectedMessage`):

```ts
  // --- Resizable split ---
  let mainEl = $state<HTMLElement | null>(null);
  const readerOpen = $derived(selectedMessage !== null || store.selectError !== null);

  function closeReader(): void {
    store.clearSelect();
    selectedMessage = null;
  }

  function handleSplitterDrag(clientX: number): void {
    const left = mainEl?.getBoundingClientRect().left ?? 0;
    store.setListWidth(clientX - left);
  }

  function handleSplitterNudge(delta: number): void {
    store.setListWidth(store.listWidth + delta);
  }

  function handleWindowKey(e: KeyboardEvent): void {
    if (e.key === 'Escape' && readerOpen) closeReader();
  }
```

(c) Load persisted width on mount — add `store.loadListWidth();` at the top of the `onMount` callback (before `await store.loadConfig()`).

(d) Add a window key listener — put this just before the root `<div>` in the markup:

```svelte
<svelte:window onkeydown={handleWindowKey} />
```

(e) Replace the entire `<main>…</main>` block with:

```svelte
  <!-- ===== Main body ===== -->
  <main bind:this={mainEl} class="flex-1 flex overflow-hidden" aria-label="Main content">

    <!-- Message List panel. Full-width when nothing is open; a resizable sidebar when reading.
         container-type drives MessageRow's rich/compact responsive layout. -->
    <section
      class="flex flex-col overflow-hidden {readerOpen
        ? 'border-r border-gray-200 dark:border-gray-700 shrink-0 hidden md:flex'
        : 'flex-1'}"
      style={readerOpen
        ? `width: ${store.listWidth}px; container-type: inline-size;`
        : 'container-type: inline-size;'}
      aria-label="Message list"
    >
      {#if initialLoadDone && store.rows.length === 0 && !store.loading}
        <EmptyState
          isSearchActive={store.search.active}
          searchQuery={store.search.query}
        />
      {:else}
        <MessageList />
      {/if}
    </section>

    {#if readerOpen}
      <Splitter
        onDrag={handleSplitterDrag}
        onNudge={handleSplitterNudge}
        ariaValueNow={store.listWidth}
        ariaValueMin={320}
        ariaValueMax={Math.floor((typeof window !== 'undefined' ? window.innerWidth : 1280) * 0.6)}
      />
    {/if}

    <!-- Reader panel -->
    {#if store.selectError}
      <section
        class="flex-1 flex items-center justify-center p-8 bg-white dark:bg-gray-900"
        aria-label="Message detail"
        data-testid="select-error"
      >
        <div class="text-center">
          <p class="text-gray-500 dark:text-gray-400">{store.selectError}</p>
          <button
            type="button"
            class="mt-3 text-sm text-indigo-600 dark:text-indigo-400 underline"
            onclick={() => { closeReader(); }}
          >
            Go back
          </button>
        </div>
      </section>
    {:else if selectedMessage}
      <section
        class="flex-1 flex flex-col overflow-hidden bg-white dark:bg-gray-900"
        aria-label="Message detail"
      >
        <MessageDetail message={selectedMessage} onClose={closeReader} />
      </section>
    {/if}
  </main>
```

(Note: the old "no-selection placeholder" `{:else}` pane is intentionally removed — when nothing is selected the list section is `flex-1` and fills the screen.)

- [ ] **Step 5: Run the App tests** — `npx vitest run src/App.test.ts src/App.reader.test.ts src/App.theme.test.ts`. Expected: PASS. (If `App.theme.test.ts`'s mock lacks the new store members and errors, add `listWidth`/`setListWidth`/`loadListWidth`/`clearSelect` to its mock too.)

- [ ] **Step 6: Run gates** — `npm run check && npx vitest run`. Expected: PASS.

- [ ] **Step 7: Commit** — `git add frontend/src/App.svelte frontend/src/App.test.ts frontend/src/App.reader.test.ts frontend/src/App.theme.test.ts && git commit`.

---

### Task 7: Rebuild committed bundle + full gates + drift guard

**Files:**
- Modify (generated): `src/mailhedgehog/static/app/**` (Vite output)

**Interfaces:** none.

- [ ] **Step 1: Full frontend gate** — `cd frontend && npm run check && npx vitest run`. Expected: svelte-check 0 errors / 0 warnings; all vitest suites pass.

- [ ] **Step 2: Build the committed bundle** — `cd frontend && npm run build`. Expected: writes `../src/mailhedgehog/static/app/` (stable filenames `app.js`/`app.css`).

- [ ] **Step 3: Backend sanity (no regressions)** — from repo root: `uv run pytest -q && uv run ruff check . && uv run ruff format --check . && uv run mypy`. Expected: all green (backend is untouched, but confirm).

- [ ] **Step 4: Commit the rebuilt bundle** — `git add src/mailhedgehog/static/app && git commit -m "build: rebuild committed UI bundle for list/detail layout"` (include the trailer).

- [ ] **Step 5: Drift guard** — `git diff --exit-code -- src/mailhedgehog/static/app`. Expected: clean (exit 0). If dirty, the build wasn't committed — add and amend.

---

## Verification (controller, after all tasks)

1. Run the app (`uv run mailhedgehog`) and render with headless Chrome at a wide width and a dragged-narrow width, in light and dark, confirming: rich two-line rows when list-only; recipient `→ first +N`; compact rows when narrow; dark mode reaches list + reader; splitter drags and persists across reload; ✕ and Esc return to the full-width list; a plain-only message opens on Plain; the search box shows a single ✕.
2. Whole-branch code review (security focus on `MessageDetail` invariants), then finishing-a-development-branch.

## Self-review notes

- Spec coverage: row enrichment (T2), recipient format (T2), resizable split (T3+T4+T6), ✕/Esc close (T5+T6), dark mode (T2+T5; others already done), double-✕ (T1), auto-Plain (T5), full-width list-only (T6), rebuild/drift (T7). ✓
- Type consistency: `onDrag(clientX:number)`, `onNudge(delta:number)`, `onClose?:()=>void`, `clampListWidth(px,viewport)`, `setListWidth(px)`/`loadListWidth()`/`listWidth` getter — used identically across tasks. ✓
- Row height invariant preserved in every layout (inline styles retained). ✓
