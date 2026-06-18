// AIDEV-NOTE: Store unit tests. We mock the api module so no network is needed.
// All store logic (dedup, applyLive, resync, LRU eviction, select 404, delete) is
// tested here. Component tests in the separate component test files cover UI concerns.
//
// IMPORTANT: Svelte 5 runes ($state) work in .svelte.ts files but tests run in a
// plain JS/TS context via vitest. The @testing-library/svelte/vite plugin enables
// the browser resolve condition so Svelte 5 client-side runes are active.

import { describe, it, expect, vi, beforeEach } from 'vitest';

// AIDEV-NOTE: We must mock the api module BEFORE importing the store,
// because the store imports api at module load time.
vi.mock('./api.js', () => ({
  listMessages: vi.fn(),
  searchMessages: vi.fn(),
  getMessage: vi.fn(),
  deleteAll: vi.fn(),
  deleteMessage: vi.fn(),
}));

import * as api from './api.js';
import { PAGE } from './store.svelte.js';

// AIDEV-NOTE: We re-import the store module fresh for each test using a dynamic import
// workaround. Because the store is a module-level singleton, we need to reset its
// state between tests. We do this by creating a local createStore-like function that
// mirrors the real store's logic for pure unit testing.
// This avoids module re-initialization issues with vitest module caching.

// Instead, we test the store's exported singleton but reset state by calling
// deleteAllMessages() and resetting mocks in beforeEach.

import { store } from './store.svelte.js';

function makeSummary(id: string, overrides: Partial<{ Subject: string; Size: number }> = {}) {
  return {
    ID: id,
    From: { Mailbox: 'sender', Domain: 'example.com', Params: '', Relays: null },
    To: [{ Mailbox: 'rcpt', Domain: 'example.com', Params: '', Relays: null }],
    Subject: overrides.Subject ?? `Subject ${id}`,
    Created: new Date().toISOString(),
    Size: overrides.Size ?? 100,
  };
}

function makeFullMessage(id: string) {
  return {
    ID: id,
    From: { Mailbox: 'sender', Domain: 'example.com', Params: '', Relays: null },
    To: [{ Mailbox: 'rcpt', Domain: 'example.com', Params: '', Relays: null }],
    Content: { Headers: {}, Body: 'body', Size: 100, MIME: null },
    MIME: null,
    Created: new Date().toISOString(),
    Size: 100,
    Raw: { From: '', To: [], Helo: '', Data: '' },
  };
}

function makePage(items: ReturnType<typeof makeSummary>[], total?: number) {
  return {
    total: total ?? items.length,
    count: items.length,
    start: 0,
    items,
  };
}

// AIDEV-NOTE: We reset the store to a clean state before each test using resetForTest().
// This clears ALL state including search, avoiding cross-test contamination from
// tests that call setSearch() or setAtTop(). vi.clearAllMocks() then resets mock call counts.
beforeEach(() => {
  store.resetForTest();
  vi.clearAllMocks();
});

describe('PAGE constant', () => {
  it('is 50', () => {
    expect(PAGE).toBe(50);
  });
});

describe('loadFirst()', () => {
  it('populates rows and total from the first page', async () => {
    const items = [makeSummary('a'), makeSummary('b'), makeSummary('c')];
    vi.mocked(api.listMessages).mockResolvedValue(makePage(items, 10));

    await store.loadFirst();

    expect(store.rows).toHaveLength(3);
    expect(store.total).toBe(10);
    expect(store.rows[0].ID).toBe('a');
  });

  it('resets rows on a second call (replaces, does not append)', async () => {
    vi.mocked(api.listMessages).mockResolvedValue(makePage([makeSummary('a'), makeSummary('b')], 2));
    await store.loadFirst();

    vi.mocked(api.listMessages).mockResolvedValue(makePage([makeSummary('x')], 1));
    await store.loadFirst();

    expect(store.rows).toHaveLength(1);
    expect(store.rows[0].ID).toBe('x');
    expect(store.total).toBe(1);
  });

  it('resets pendingNew to 0', async () => {
    // Set up pending messages first
    vi.mocked(api.listMessages).mockResolvedValue(makePage([]));
    await store.loadFirst();
    store.setAtTop(false);
    store.applyLive(makeSummary('live1'));
    expect(store.pendingNew).toBe(1);

    // loadFirst should reset
    vi.mocked(api.listMessages).mockResolvedValue(makePage([makeSummary('a')]));
    await store.loadFirst();
    expect(store.pendingNew).toBe(0);
  });
});

describe('loadMore()', () => {
  it('appends next page and updates total', async () => {
    // Start with 2 items, total 5
    const first2 = [makeSummary('a'), makeSummary('b')];
    vi.mocked(api.listMessages).mockResolvedValue(makePage(first2, 5));
    await store.loadFirst();

    // Next page: 3 more items
    const next3 = [makeSummary('c'), makeSummary('d'), makeSummary('e')];
    vi.mocked(api.listMessages).mockResolvedValueOnce({
      total: 5,
      count: 3,
      start: 2,
      items: next3,
    });
    await store.loadMore();

    expect(store.rows).toHaveLength(5);
    expect(store.rows.map((r) => r.ID)).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('skips already-seen IDs (dedup)', async () => {
    const first = [makeSummary('a'), makeSummary('b')];
    vi.mocked(api.listMessages).mockResolvedValue(makePage(first, 4));
    await store.loadFirst();

    // Server returns overlapping IDs (a, b already in store)
    vi.mocked(api.listMessages).mockResolvedValueOnce({
      total: 4,
      count: 4,
      start: 2,
      items: [makeSummary('a'), makeSummary('b'), makeSummary('c'), makeSummary('d')],
    });
    await store.loadMore();

    expect(store.rows).toHaveLength(4);
    expect(store.rows.filter((r) => r.ID === 'a')).toHaveLength(1);
    expect(store.rows.filter((r) => r.ID === 'b')).toHaveLength(1);
  });

  it('does not fetch when rows.length >= total', async () => {
    const items = [makeSummary('a'), makeSummary('b')];
    vi.mocked(api.listMessages).mockResolvedValue(makePage(items, 2));
    await store.loadFirst();

    vi.clearAllMocks();
    await store.loadMore();

    expect(api.listMessages).not.toHaveBeenCalled();
  });
});

describe('applyLive()', () => {
  it('prepends to rows when atTop and not searching', async () => {
    const items = [makeSummary('a'), makeSummary('b')];
    vi.mocked(api.listMessages).mockResolvedValue(makePage(items, 2));
    await store.loadFirst();
    store.setAtTop(true);

    store.applyLive(makeSummary('new1'));

    expect(store.rows[0].ID).toBe('new1');
    expect(store.rows).toHaveLength(3);
    expect(store.total).toBe(3);
    expect(store.pendingNew).toBe(0);
  });

  it('increments pendingNew when not atTop', async () => {
    vi.mocked(api.listMessages).mockResolvedValue(makePage([makeSummary('a')], 1));
    await store.loadFirst();
    store.setAtTop(false);

    store.applyLive(makeSummary('new1'));
    store.applyLive(makeSummary('new2'));

    expect(store.pendingNew).toBe(2);
    expect(store.rows).toHaveLength(1); // rows not changed
    expect(store.total).toBe(1); // total not changed
  });

  it('increments pendingNew when searching', async () => {
    vi.mocked(api.searchMessages).mockResolvedValue(makePage([makeSummary('a')], 1));
    store.setSearch('subject', 'hello');
    await store.loadFirst();
    store.setAtTop(true);

    store.applyLive(makeSummary('new1'));

    expect(store.pendingNew).toBe(1);
    expect(store.rows).toHaveLength(1);
  });

  it('ignores duplicate IDs (dedup)', async () => {
    const items = [makeSummary('a'), makeSummary('b')];
    vi.mocked(api.listMessages).mockResolvedValue(makePage(items, 2));
    await store.loadFirst();
    store.setAtTop(true);

    store.applyLive(makeSummary('a')); // already in list

    expect(store.rows).toHaveLength(2);
    expect(store.total).toBe(2);
    expect(store.pendingNew).toBe(0);
  });
});

describe('resync()', () => {
  it('collapses rows to server first page, dropping ghost rows', async () => {
    const items = [makeSummary('a'), makeSummary('b'), makeSummary('c')];
    vi.mocked(api.listMessages).mockResolvedValue(makePage(items, 3));
    await store.loadFirst();

    // Server evicted 'c', only returns a and b now
    vi.mocked(api.listMessages).mockResolvedValueOnce({
      total: 2,
      count: 2,
      start: 0,
      items: [makeSummary('a'), makeSummary('b')],
    });
    await store.resync();

    expect(store.rows).toHaveLength(2);
    expect(store.rows.map((r) => r.ID)).toEqual(['a', 'b']);
    expect(store.total).toBe(2);
    // seen must be consistent with rows
    expect(store.seen.has('a')).toBe(true);
    expect(store.seen.has('b')).toBe(true);
    expect(store.seen.has('c')).toBe(false);
  });

  it('collapses a deep window (rows.length > PAGE) to first page, dropping ghost rows', async () => {
    // Simulate a client that has scrolled deep: rows.length > PAGE
    // First, load a page of items
    const firstPageItems = Array.from({ length: PAGE }, (_, i) => makeSummary(`p${i}`));
    vi.mocked(api.listMessages).mockResolvedValue(makePage(firstPageItems, PAGE + 10));
    await store.loadFirst();

    // Manually push extra rows to simulate deep scroll beyond first page
    const extraItems = Array.from({ length: 5 }, (_, i) => makeSummary(`extra${i}`));
    for (const item of extraItems) {
      store.rows.push(item);
      store.seen.add(item.ID);
    }
    expect(store.rows).toHaveLength(PAGE + 5);

    // Server returns only the newest PAGE items (first page snapshot)
    const serverPage = Array.from({ length: PAGE }, (_, i) => makeSummary(`new${i}`));
    vi.mocked(api.listMessages).mockResolvedValueOnce(makePage(serverPage, PAGE));
    await store.resync();

    // After resync: rows must exactly equal the server's first page, no ghosts
    expect(store.rows).toHaveLength(PAGE);
    expect(store.rows.map((r) => r.ID)).toEqual(serverPage.map((s) => s.ID));
    expect(store.total).toBe(PAGE);
    // seen must be consistent — no old deep rows remain
    for (const item of extraItems) {
      expect(store.seen.has(item.ID)).toBe(false);
    }
    for (const item of firstPageItems) {
      expect(store.seen.has(item.ID)).toBe(false); // old p* IDs gone too
    }
    for (const item of serverPage) {
      expect(store.seen.has(item.ID)).toBe(true);
    }
  });

  it('resets pendingNew to 0 after resync', async () => {
    vi.mocked(api.listMessages).mockResolvedValue(makePage([], 0));
    await store.loadFirst();
    store.setAtTop(false);
    store.applyLive(makeSummary('x'));
    expect(store.pendingNew).toBe(1);

    vi.mocked(api.listMessages).mockResolvedValueOnce(makePage([makeSummary('x')], 1));
    await store.resync();

    expect(store.pendingNew).toBe(0);
  });

  it('uses searchMessages when search is active', async () => {
    vi.mocked(api.searchMessages).mockResolvedValue(makePage([makeSummary('s1')], 1));
    store.setSearch('subject', 'test');
    await store.loadFirst();
    vi.clearAllMocks();

    vi.mocked(api.searchMessages).mockResolvedValue(makePage([makeSummary('s1')], 1));
    await store.resync();

    expect(api.searchMessages).toHaveBeenCalled();
    expect(api.listMessages).not.toHaveBeenCalled();
  });
});

describe('showPending()', () => {
  it('resets pendingNew to 0 and calls resync', async () => {
    vi.mocked(api.listMessages).mockResolvedValue(makePage([], 0));
    await store.loadFirst();
    store.setAtTop(false);
    store.applyLive(makeSummary('new1'));
    store.applyLive(makeSummary('new2'));
    expect(store.pendingNew).toBe(2);

    vi.mocked(api.listMessages).mockResolvedValueOnce(
      makePage([makeSummary('new2'), makeSummary('new1')], 2)
    );
    await store.showPending();

    expect(store.pendingNew).toBe(0);
    expect(store.rows).toHaveLength(2);
  });
});

describe('select()', () => {
  it('fetches and caches a message', async () => {
    const items = [makeSummary('msg1')];
    vi.mocked(api.listMessages).mockResolvedValue(makePage(items, 1));
    await store.loadFirst();

    const full = makeFullMessage('msg1');
    vi.mocked(api.getMessage).mockResolvedValue(full);

    const result = await store.select('msg1');

    expect(result).toBeDefined();
    expect(result?.ID).toBe('msg1');
    expect(store.selectedId).toBe('msg1');
    expect(api.getMessage).toHaveBeenCalledWith('msg1');
  });

  it('returns cached message without a second fetch', async () => {
    const items = [makeSummary('msg1')];
    vi.mocked(api.listMessages).mockResolvedValue(makePage(items, 1));
    await store.loadFirst();

    const full = makeFullMessage('msg1');
    vi.mocked(api.getMessage).mockResolvedValue(full);

    await store.select('msg1');
    vi.clearAllMocks();
    const result2 = await store.select('msg1');

    expect(api.getMessage).not.toHaveBeenCalled();
    expect(result2?.ID).toBe('msg1');
  });

  it('handles 404 by removing ghost row and setting selectError', async () => {
    const items = [makeSummary('ghost'), makeSummary('real')];
    vi.mocked(api.listMessages).mockResolvedValue(makePage(items, 2));
    await store.loadFirst();

    vi.mocked(api.getMessage).mockRejectedValue(new Error('HTTP 404 Not Found'));

    const result = await store.select('ghost');

    expect(result).toBeNull();
    expect(store.rows.map((r) => r.ID)).not.toContain('ghost');
    expect(store.total).toBe(1);
    expect(store.selectedId).toBeNull();
    expect(store.selectError).toContain('no longer available');
  });

  it('surfaces a non-404 error in selectError without removing row', async () => {
    const items = [makeSummary('msg1')];
    vi.mocked(api.listMessages).mockResolvedValue(makePage(items, 1));
    await store.loadFirst();

    vi.mocked(api.getMessage).mockRejectedValue(new Error('HTTP 500 Internal Server Error'));

    const result = await store.select('msg1');

    expect(result).toBeNull();
    expect(store.rows).toHaveLength(1); // row not removed on non-404
    expect(store.selectError).toMatch(/500/);
  });
});

describe('LRU cache eviction', () => {
  it('evicts oldest entry when cache exceeds cap (50)', async () => {
    // Populate store with one item
    const items = [makeSummary('base')];
    vi.mocked(api.listMessages).mockResolvedValue(makePage(items, 1));
    await store.loadFirst();

    // Fill the cache to LRU_CAP with items 0..49
    const ids = Array.from({ length: 50 }, (_, i) => `msg${i}`);
    for (const id of ids) {
      vi.mocked(api.getMessage).mockResolvedValueOnce(makeFullMessage(id));
      // We need to add row so select doesn't 404
      store.rows.push(makeSummary(id));
      store.seen.add(id);
      await store.select(id);
    }

    // Cache should have 50 entries (0..49)
    expect(store._detailCache.size).toBe(50);

    // Adding one more should evict msg0 (oldest)
    vi.mocked(api.getMessage).mockResolvedValueOnce(makeFullMessage('msg50'));
    store.rows.push(makeSummary('msg50'));
    store.seen.add('msg50');
    await store.select('msg50');

    expect(store._detailCache.size).toBe(50);
    expect(store._detailCache.has('msg0')).toBe(false); // evicted
    expect(store._detailCache.has('msg50')).toBe(true); // new entry present
  });

  it('LRU touch: accessing an older entry makes it survive eviction', async () => {
    // Populate store with one item
    vi.mocked(api.listMessages).mockResolvedValue(makePage([makeSummary('base')], 1));
    await store.loadFirst();

    // Fill cache with msg0..msg49
    const ids = Array.from({ length: 50 }, (_, i) => `lru${i}`);
    for (const id of ids) {
      vi.mocked(api.getMessage).mockResolvedValueOnce(makeFullMessage(id));
      store.rows.push(makeSummary(id));
      store.seen.add(id);
      await store.select(id);
    }

    // Re-access lru0 to make it "recently used" (touch)
    // It should now be at the end of the LRU map
    vi.clearAllMocks();
    await store.select('lru0'); // cache hit — no fetch
    expect(api.getMessage).not.toHaveBeenCalled();

    // Now add lru50 — this should evict lru1 (oldest after lru0 was touched)
    vi.mocked(api.getMessage).mockResolvedValueOnce(makeFullMessage('lru50'));
    store.rows.push(makeSummary('lru50'));
    store.seen.add('lru50');
    await store.select('lru50');

    expect(store._detailCache.has('lru0')).toBe(true); // survived (was touched)
    expect(store._detailCache.has('lru1')).toBe(false); // evicted (was oldest)
    expect(store._detailCache.has('lru50')).toBe(true); // new entry
  });
});

describe('deleteOne()', () => {
  it('removes the row, decrements total, clears selection if selected', async () => {
    const items = [makeSummary('a'), makeSummary('b')];
    vi.mocked(api.listMessages).mockResolvedValue(makePage(items, 2));
    await store.loadFirst();

    vi.mocked(api.getMessage).mockResolvedValue(makeFullMessage('a'));
    await store.select('a');
    expect(store.selectedId).toBe('a');

    vi.mocked(api.deleteMessage).mockResolvedValue(undefined);
    await store.deleteOne('a');

    expect(store.rows.map((r) => r.ID)).not.toContain('a');
    expect(store.total).toBe(1);
    expect(store.selectedId).toBeNull();
    expect(store._detailCache.has('a')).toBe(false);
  });

  it('keeps selection when deleting a different message', async () => {
    const items = [makeSummary('a'), makeSummary('b')];
    vi.mocked(api.listMessages).mockResolvedValue(makePage(items, 2));
    await store.loadFirst();

    vi.mocked(api.getMessage).mockResolvedValue(makeFullMessage('a'));
    await store.select('a');

    vi.mocked(api.deleteMessage).mockResolvedValue(undefined);
    await store.deleteOne('b');

    expect(store.selectedId).toBe('a');
    expect(store.rows).toHaveLength(1);
    expect(store.total).toBe(1);
  });
});

describe('deleteAllMessages()', () => {
  it('clears rows, seen, total, cache, selection, and pendingNew', async () => {
    const items = [makeSummary('a'), makeSummary('b')];
    vi.mocked(api.listMessages).mockResolvedValue(makePage(items, 2));
    await store.loadFirst();

    vi.mocked(api.getMessage).mockResolvedValue(makeFullMessage('a'));
    await store.select('a');
    store.setAtTop(false);
    store.applyLive(makeSummary('c'));
    expect(store.pendingNew).toBe(1);

    vi.mocked(api.deleteAll).mockResolvedValue(undefined);
    await store.deleteAllMessages();

    expect(store.rows).toHaveLength(0);
    expect(store.total).toBe(0);
    expect(store.selectedId).toBeNull();
    expect(store.pendingNew).toBe(0);
    expect(store._detailCache.size).toBe(0);
  });
});

describe('setSearch() and clearSearch()', () => {
  it('setSearch triggers a search fetch', async () => {
    vi.mocked(api.searchMessages).mockResolvedValue(
      makePage([makeSummary('s1')], 1)
    );

    store.setSearch('subject', 'hello');
    await store.loadFirst(); // setSearch calls loadFirst internally but we await explicitly

    expect(store.search.active).toBe(true);
    expect(store.search.kind).toBe('subject');
    expect(store.search.query).toBe('hello');
  });

  it('clearSearch reverts to list mode', async () => {
    vi.mocked(api.searchMessages).mockResolvedValue(makePage([makeSummary('s1')], 1));
    store.setSearch('subject', 'hello');
    await store.loadFirst();

    vi.mocked(api.listMessages).mockResolvedValue(makePage([makeSummary('a')], 1));
    store.clearSearch();
    await store.loadFirst();

    expect(store.search.active).toBe(false);
    expect(api.listMessages).toHaveBeenCalled();
  });
});

describe('clearSelect()', () => {
  it('sets selectedId and selectError to null without calling getMessage', async () => {
    // Arrange: trigger a 404 to get into error state
    const items = [makeSummary('ghost')];
    vi.mocked(api.listMessages).mockResolvedValue(makePage(items, 1));
    await store.loadFirst();

    vi.mocked(api.getMessage).mockRejectedValue(new Error('HTTP 404 Not Found'));
    await store.select('ghost');
    // selectError should be set (404 path sets it and nulls selectedId)
    expect(store.selectError).toBeTruthy();

    // Set selectedId manually to a known value to test clearSelect
    // (We need it non-null: use a successful select first)
    const items2 = [makeSummary('real')];
    vi.mocked(api.listMessages).mockResolvedValue(makePage(items2, 1));
    store.resetForTest();
    vi.clearAllMocks();

    vi.mocked(api.listMessages).mockResolvedValue(makePage([makeSummary('real')], 1));
    await store.loadFirst();
    vi.mocked(api.getMessage).mockResolvedValue(makeFullMessage('real'));
    await store.select('real');
    expect(store.selectedId).toBe('real');

    vi.clearAllMocks();
    store.clearSelect();

    expect(store.selectedId).toBeNull();
    expect(store.selectError).toBeNull();
    // getMessage must NOT have been called — clearSelect does zero HTTP requests
    expect(api.getMessage).not.toHaveBeenCalled();
  });

  it('clears selectError state set by a 404 without any fetch', async () => {
    const items = [makeSummary('ghost2')];
    vi.mocked(api.listMessages).mockResolvedValue(makePage(items, 1));
    await store.loadFirst();

    vi.mocked(api.getMessage).mockRejectedValue(new Error('HTTP 404 Not Found'));
    await store.select('ghost2');
    expect(store.selectError).toBeTruthy();

    vi.clearAllMocks();
    store.clearSelect();

    expect(store.selectError).toBeNull();
    expect(store.selectedId).toBeNull();
    expect(api.getMessage).not.toHaveBeenCalled();
    expect(api.listMessages).not.toHaveBeenCalled();
  });
});

describe('setWsStatus() and setAtTop()', () => {
  it('setWsStatus updates wsStatus', () => {
    store.setWsStatus('connected');
    expect(store.wsStatus).toBe('connected');
    store.setWsStatus('offline');
    expect(store.wsStatus).toBe('offline');
  });

  it('setAtTop updates atTop', () => {
    store.setAtTop(false);
    expect(store.atTop).toBe(false);
    store.setAtTop(true);
    expect(store.atTop).toBe(true);
  });
});
