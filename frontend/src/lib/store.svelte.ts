// AIDEV-NOTE: Svelte 5 runes-based message store for mailhedgehog.
// This is the core data layer: manages the bounded windowed list (newest-first),
// dedup by ID, LRU detail cache (cap 50), and WebSocket live-message integration.
//
// Key design decisions:
// - rows is newest-first (index 0 = newest). applyLive prepends; loadMore appends.
// - seen: Set<string> is a plain (non-$state) imperative dedup index for O(1) dedup.
// - pendingNew accumulates incoming live messages when not atTop or when searching.
// - resync() collapses the window to the server's first page (first-page-snapshot).
// - select() handles 404 by removing the ghost row and surfacing selectError.
// - The store is a singleton exported object; use $state/$derived in .svelte.ts context.

import type { FullMessage, Summary } from './types.js';
import type { Status } from './ws.js';
import * as api from './api.js';

// AIDEV-NOTE: PAGE is the page size for list/search fetches. 50 is a good balance
// between bandwidth and scroll inertia for a local dev-tool mail catcher.
export const PAGE = 50;
const LRU_CAP = 50;

// AIDEV-NOTE: LRU cache using Map insertion-order. delete+set on access refreshes recency.
// Evicts the oldest (first) entry when size exceeds LRU_CAP.
function lruSet(cache: Map<string, FullMessage>, id: string, msg: FullMessage): void {
  if (cache.has(id)) cache.delete(id);
  cache.set(id, msg);
  if (cache.size > LRU_CAP) {
    // Delete the oldest (first) key
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
}

function lruGet(cache: Map<string, FullMessage>, id: string): FullMessage | undefined {
  const val = cache.get(id);
  if (val !== undefined) {
    // Touch: move to end (most recently used)
    cache.delete(id);
    cache.set(id, val);
  }
  return val;
}

function createStore() {
  // --- Core reactive state ---
  let rows = $state<Summary[]>([]);
  // AIDEV-NOTE: seen is intentionally NOT $state — it is an imperative dedup index
  // mutated in-place via .add()/.delete(). Svelte 5's proxy does not track in-place
  // Set mutation, and seen is never read in a reactive/template expression anyway.
  // Mirror the same reasoning as detailCache below.
  let seen = new Set<string>();
  let total = $state(0);
  let selectedId = $state<string | null>(null);
  let wsStatus = $state<Status>('reconnecting');
  let pendingNew = $state(0);
  let atTop = $state(true);
  let loading = $state(false);
  // AIDEV-NOTE: proxyImages mirrors the server's MH_PROXY_REMOTE_IMAGES flag,
  // fetched once at startup via loadConfig(). When true, MessageDetail rewrites
  // remote <img> URLs through the proxy. Defaults false (direct load).
  let proxyImages = $state(false);
  let selectError = $state<string | null>(null);

  // Search state
  let searchActive = $state(false);
  let searchKind = $state('');
  let searchQuery = $state('');

  // AIDEV-NOTE: Detail cache is NOT $state because its mutation pattern (delete+set for LRU)
  // doesn't integrate cleanly with Svelte's proxy tracking and isn't needed for reactivity —
  // callers await select() which returns the message directly.
  const detailCache = new Map<string, FullMessage>();

  // --- Internal helpers ---

  function currentFetch(start: number, limit: number): Promise<import('./types.js').Page<Summary>> {
    if (searchActive && searchQuery) {
      return api.searchMessages(searchKind, searchQuery, start, limit);
    }
    return api.listMessages(start, limit);
  }

  // AIDEV-NOTE: loadConfig fetches the server bootstrap config once at startup.
  // On any failure it leaves proxyImages=false so images still attempt to load
  // directly — graceful degradation, never a hard error.
  async function loadConfig(): Promise<void> {
    try {
      const cfg = await api.getConfig();
      proxyImages = cfg.proxyRemoteImages;
    } catch {
      proxyImages = false;
    }
  }

  // AIDEV-NOTE: loadFirst resets the list entirely and fetches page 0.
  // Called on init, setSearch, clearSearch, and after deleteAll.
  async function loadFirst(): Promise<void> {
    loading = true;
    try {
      const page = await currentFetch(0, PAGE);
      rows = page.items;
      seen = new Set(page.items.map((s) => s.ID));
      total = page.total;
      pendingNew = 0;
    } finally {
      loading = false;
    }
  }

  // AIDEV-NOTE: loadMore appends the next page. It uses rows.length as the start offset.
  // Dedup via seen protects against races where the same ID arrives twice.
  async function loadMore(): Promise<void> {
    if (loading || rows.length >= total) return;
    loading = true;
    try {
      const page = await currentFetch(rows.length, PAGE);
      total = page.total; // server may have grown or shrunk
      for (const s of page.items) {
        if (!seen.has(s.ID)) {
          rows.push(s);
          seen.add(s.ID);
        }
      }
    } finally {
      loading = false;
    }
  }

  // AIDEV-NOTE: applyLive handles a single incoming live Summary from WebSocket.
  // If the user is at the top AND not searching → prepend immediately (newest first).
  // Otherwise → increment pendingNew so the "N new messages" pill shows up.
  // Always dedup: ignore if ID already in seen.
  function applyLive(summary: Summary): void {
    if (seen.has(summary.ID)) return;
    if (atTop && !searchActive) {
      rows.unshift(summary);
      seen.add(summary.ID);
      total++;
    } else {
      pendingNew++;
    }
  }

  // AIDEV-NOTE: resync intentionally collapses the window to the server's NEWEST page;
  // deep-scroll position is NOT preserved across resync. This is acceptable because resync
  // only fires on (a) the user clicking the "N new messages" pill (they're going to the top
  // anyway) and (b) a websocket (re)open (rare recovery to drop frames missed while
  // disconnected). The FIFO/oldest-evicted storage model makes a first-page snapshot the
  // safe source of truth — client rows beyond the server's first page are likely ghosts of
  // evicted messages.
  async function resync(): Promise<void> {
    loading = true;
    try {
      const page = await currentFetch(0, PAGE);
      rows = page.items;
      seen = new Set(page.items.map((s) => s.ID));
      total = page.total;
      pendingNew = 0;
    } finally {
      loading = false;
    }
  }

  // AIDEV-NOTE: showPending is called when the user clicks the "N new messages" pill.
  // It resets pendingNew and triggers a resync from the server.
  // The MessageList component is responsible for scrolling to top after this call.
  async function showPending(): Promise<void> {
    pendingNew = 0;
    await resync();
  }

  function setSearch(kind: string, query: string): void {
    searchActive = true;
    searchKind = kind;
    searchQuery = query;
    loadFirst();
  }

  function clearSearch(): void {
    searchActive = false;
    searchKind = '';
    searchQuery = '';
    loadFirst();
  }

  // AIDEV-NOTE: clearSelect() dismisses any selectError / not-available state WITHOUT
  // making any network request. Sets selectedId=null and selectError=null.
  // Use this for the "Go back" button instead of select('') which abuses the error path
  // and fires a spurious HTTP request.
  function clearSelect(): void {
    selectedId = null;
    selectError = null;
  }

  // AIDEV-NOTE: select() returns the full message. It tries the LRU cache first.
  // On cache miss, fetches from API. On 404, removes the ghost row from the list.
  // Does NOT throw — surfaces errors via the selectError field.
  async function select(id: string): Promise<FullMessage | null> {
    selectError = null;
    selectedId = id;

    const cached = lruGet(detailCache, id);
    if (cached) return cached;

    try {
      const msg = await api.getMessage(id);
      lruSet(detailCache, id, msg);
      return msg;
    } catch (err) {
      const isNotFound =
        err instanceof Error && (err.message.includes('404') || err.message.includes('Not Found'));
      if (isNotFound) {
        // Remove ghost row
        rows = rows.filter((r) => r.ID !== id);
        seen.delete(id);
        total = Math.max(0, total - 1);
        if (selectedId === id) selectedId = null;
        selectError = 'Message no longer available';
      } else {
        selectError = err instanceof Error ? err.message : 'Failed to load message';
      }
      return null;
    }
  }

  async function deleteOne(id: string): Promise<void> {
    await api.deleteMessage(id);
    rows = rows.filter((r) => r.ID !== id);
    seen.delete(id);
    total = Math.max(0, total - 1);
    detailCache.delete(id);
    if (selectedId === id) selectedId = null;
  }

  async function deleteAllMessages(): Promise<void> {
    await api.deleteAll();
    rows = [];
    seen = new Set();
    total = 0;
    detailCache.clear();
    selectedId = null;
    pendingNew = 0;
  }

  function setWsStatus(status: Status): void {
    wsStatus = status;
  }

  function setAtTop(value: boolean): void {
    atTop = value;
  }

  // AIDEV-NOTE: resetForTest() is a testing seam that resets ALL state including search
  // and wsStatus. DO NOT call in production code. Used in test beforeEach to ensure
  // the singleton store starts each test in a known clean state.
  function resetForTest(): void {
    rows = [];
    seen = new Set();
    total = 0;
    detailCache.clear();
    selectedId = null;
    pendingNew = 0;
    atTop = true;
    wsStatus = 'reconnecting';
    loading = false;
    proxyImages = false;
    selectError = null;
    searchActive = false;
    searchKind = '';
    searchQuery = '';
  }

  // AIDEV-NOTE: Expose state as getters so the reactive $state values are readable
  // from outside the store factory (Svelte 5 runes don't escape the .svelte.ts boundary
  // via plain object spread — getters preserve reactivity).
  return {
    get rows() { return rows; },
    get seen() { return seen; },
    get total() { return total; },
    get selectedId() { return selectedId; },
    get wsStatus() { return wsStatus; },
    get pendingNew() { return pendingNew; },
    get atTop() { return atTop; },
    get loading() { return loading; },
    get proxyImages() { return proxyImages; },
    get selectError() { return selectError; },
    get search() {
      return { active: searchActive, kind: searchKind, query: searchQuery };
    },
    loadConfig,
    loadFirst,
    loadMore,
    applyLive,
    resync,
    showPending,
    setSearch,
    clearSearch,
    clearSelect,
    select,
    deleteOne,
    deleteAllMessages,
    setWsStatus,
    setAtTop,
    // Expose for testing only — do NOT use in production components
    get _detailCache() { return detailCache; },
    resetForTest,
  };
}

// AIDEV-NOTE: Singleton store instance. Import and use in Svelte components directly.
// The store is module-scoped so all components share the same reactive state.
export const store = createStore();
