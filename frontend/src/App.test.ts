// AIDEV-NOTE: App.svelte smoke tests — light coverage (store/ws mocked, virtualizer not exercised).
// See App.theme.test.ts for theme toggle tests.

import { render, screen, waitFor } from '@testing-library/svelte';
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock store
vi.mock('./lib/store.svelte.js', () => ({
  store: {
    rows: [],
    total: 0,
    selectedId: null,
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
    select: vi.fn().mockResolvedValue(null),
    clearSelect: vi.fn(),
    deleteOne: vi.fn(),
    deleteAllMessages: vi.fn().mockResolvedValue(undefined),
    clearSearch: vi.fn(),
    setSearch: vi.fn(),
    showPending: vi.fn(),
  },
}));

// Mock WebSocket
vi.mock('./lib/ws.js', () => ({
  connect: vi.fn(() => ({ close: vi.fn() })),
}));

beforeEach(() => {
  if (!HTMLDialogElement.prototype.showModal) {
    HTMLDialogElement.prototype.showModal = vi.fn();
  }
  if (!HTMLDialogElement.prototype.close) {
    HTMLDialogElement.prototype.close = vi.fn();
  }
  // Ensure matchMedia is available
  if (!window.matchMedia) {
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: vi.fn(() => ({
        matches: false,
        media: '',
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    });
  }
});

import App from './App.svelte';

describe('App', () => {
  it('renders the mailhedgehog logo/heading', () => {
    render(App);
    // The heading is now a <span> in the header link; we find it by text
    expect(screen.getByText('mailhedgehog')).toBeTruthy();
  });

  it('renders the search bar', () => {
    render(App);
    expect(screen.getByTestId('search-input')).toBeTruthy();
  });

  it('renders the theme toggle', () => {
    render(App);
    expect(screen.getByTestId('theme-toggle')).toBeTruthy();
  });

  it('renders the delete all button', () => {
    render(App);
    expect(screen.getByTestId('delete-all-btn')).toBeTruthy();
  });

  it('renders the status dot', () => {
    render(App);
    expect(screen.getByTestId('status-dot')).toBeTruthy();
  });

  it('shows the empty state after loadFirst resolves with empty rows', async () => {
    render(App);
    await waitFor(() => {
      expect(screen.getByTestId('empty-state')).toBeTruthy();
    });
  });
});
