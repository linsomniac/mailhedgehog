// AIDEV-NOTE: MessageList component tests.
// We can only do limited testing in jsdom because @tanstack/svelte-virtual depends on
// real element measurements (getBoundingClientRect returns 0 in jsdom, so virtual items
// won't render). We focus on:
// - The "N new messages" pill renders when pendingNew > 0
// - The pill does NOT render when pendingNew === 0
// - The pill text reflects the count and uses correct singular/plural
//
// Deep virtualizer behavior (item positioning, infinite scroll trigger) cannot be
// reliably tested in jsdom. Store logic tests cover the underlying business logic.
//
// AIDEV-NOTE: vi.mock factory is hoisted to top of file by vitest, so it CANNOT reference
// variables declared later (they aren't initialized yet). The solution is to use
// vi.hoisted() to declare the mock object before hoisting, or define it inside the factory
// and expose it via module-level variable set after import.

import { render, screen, fireEvent } from '@testing-library/svelte';
import { describe, it, expect, vi, beforeEach } from 'vitest';

// AIDEV-NOTE: Use vi.hoisted() to create the mock store object before vi.mock hoisting.
// This ensures the factory function can reference mockStore without "before initialization" errors.
const { mockStore } = vi.hoisted(() => {
  const mockStore = {
    rows: [] as import('../lib/types.js').Summary[],
    total: 0,
    loading: false,
    pendingNew: 0,
    atTop: true,
    selectedId: null as string | null,
    search: { active: false, kind: '', query: '' },
    selectError: null as string | null,
    wsStatus: 'connected' as 'connected' | 'reconnecting' | 'offline',
    showPending: vi.fn().mockResolvedValue(undefined),
    setAtTop: vi.fn(),
    loadMore: vi.fn().mockResolvedValue(undefined),
    select: vi.fn().mockResolvedValue(null),
    resetForTest: vi.fn(),
  };
  return { mockStore };
});

vi.mock('../lib/store.svelte.js', () => ({
  store: mockStore,
}));

vi.mock('../lib/api.js', () => ({
  listMessages: vi.fn(),
  searchMessages: vi.fn(),
  getMessage: vi.fn(),
  deleteAll: vi.fn(),
  deleteMessage: vi.fn(),
}));

import MessageList from './MessageList.svelte';

beforeEach(() => {
  vi.clearAllMocks();
  mockStore.rows = [];
  mockStore.total = 0;
  mockStore.loading = false;
  mockStore.pendingNew = 0;
  mockStore.atTop = true;
  mockStore.selectedId = null;
  mockStore.search = { active: false, kind: '', query: '' };
});

describe('MessageList pending pill', () => {
  it('does NOT render the pill when pendingNew is 0', () => {
    mockStore.pendingNew = 0;
    render(MessageList);
    expect(screen.queryByTestId('pending-pill')).toBeNull();
  });

  it('renders the pill when pendingNew > 0', () => {
    mockStore.pendingNew = 3;
    render(MessageList);
    const pill = screen.getByTestId('pending-pill');
    expect(pill).toBeTruthy();
  });

  it('shows correct singular text for 1 new message', () => {
    mockStore.pendingNew = 1;
    render(MessageList);
    expect(screen.getByText('1 new message')).toBeTruthy();
  });

  it('shows correct plural text for multiple new messages', () => {
    mockStore.pendingNew = 5;
    render(MessageList);
    expect(screen.getByText('5 new messages')).toBeTruthy();
  });

  it('calls showPending when pill is clicked', async () => {
    mockStore.pendingNew = 2;
    render(MessageList);
    const btn = screen.getByText('2 new messages');
    await fireEvent.click(btn);
    expect(mockStore.showPending).toHaveBeenCalledOnce();
  });
});

describe('MessageList empty state', () => {
  it('renders empty state when rows is empty and not loading', () => {
    mockStore.rows = [];
    mockStore.total = 0;
    mockStore.loading = false;
    render(MessageList);
    expect(screen.getByText('No messages')).toBeTruthy();
  });

  it('shows search-specific empty message when search is active', () => {
    mockStore.rows = [];
    mockStore.total = 0;
    mockStore.loading = false;
    mockStore.search = { active: true, kind: 'subject', query: 'hello' };
    render(MessageList);
    expect(screen.getByText(/No results for/)).toBeTruthy();
    expect(screen.getByText(/hello/)).toBeTruthy();
  });
});
