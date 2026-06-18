// AIDEV-NOTE: App theme tests verify:
// - Toggle adds/removes 'dark' on document.documentElement
// - Initial state respects mocked matchMedia
// - Persists to localStorage under 'mhg-theme'
//
// We render the App component and interact with the theme toggle button.
// Store and WebSocket are mocked so the test doesn't fetch or connect.

import { render, screen, fireEvent, waitFor } from '@testing-library/svelte';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---- Mock store ----
vi.mock('./lib/store.svelte.js', () => ({
  store: {
    rows: [],
    total: 0,
    selectedId: null,
    wsStatus: 'connected',
    pendingNew: 0,
    atTop: true,
    loading: false,
    selectError: null,
    search: { active: false, kind: '', query: '' },
    loadFirst: vi.fn().mockResolvedValue(undefined),
    loadMore: vi.fn(),
    applyLive: vi.fn(),
    resync: vi.fn().mockResolvedValue(undefined),
    setWsStatus: vi.fn(),
    setAtTop: vi.fn(),
    select: vi.fn().mockResolvedValue(null),
    deleteOne: vi.fn(),
    deleteAllMessages: vi.fn().mockResolvedValue(undefined),
    clearSearch: vi.fn(),
    setSearch: vi.fn(),
    showPending: vi.fn(),
  },
}));

// ---- Mock ws ----
vi.mock('./lib/ws.js', () => ({
  connect: vi.fn(() => ({ close: vi.fn() })),
}));

// ---- Mock HTMLDialogElement for jsdom ----
beforeEach(() => {
  if (!HTMLDialogElement.prototype.showModal) {
    HTMLDialogElement.prototype.showModal = vi.fn();
  }
  if (!HTMLDialogElement.prototype.close) {
    HTMLDialogElement.prototype.close = vi.fn();
  }
});

// ---- Helpers ----

function mockMatchMedia(prefersDark: boolean): void {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn((query: string) => ({
      matches: query === '(prefers-color-scheme: dark)' ? prefersDark : false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}

const THEME_KEY = 'mhg-theme';

import App from './App.svelte';

describe('Theme toggle', () => {
  beforeEach(() => {
    // Clean up dark class and localStorage before each test
    document.documentElement.classList.remove('dark');
    localStorage.removeItem(THEME_KEY);
    mockMatchMedia(false);
  });

  afterEach(() => {
    document.documentElement.classList.remove('dark');
    localStorage.removeItem(THEME_KEY);
    vi.restoreAllMocks();
  });

  it('starts in light mode when matchMedia returns false and no stored preference', async () => {
    mockMatchMedia(false);
    render(App);
    await waitFor(() => {
      expect(document.documentElement.classList.contains('dark')).toBe(false);
    });
  });

  it('starts in dark mode when matchMedia returns true and no stored preference', async () => {
    mockMatchMedia(true);
    render(App);
    await waitFor(() => {
      expect(document.documentElement.classList.contains('dark')).toBe(true);
    });
    // Cleanup
    document.documentElement.classList.remove('dark');
  });

  it('respects stored "dark" preference over matchMedia', async () => {
    mockMatchMedia(false); // OS says light
    localStorage.setItem(THEME_KEY, 'dark'); // but user saved dark
    render(App);
    await waitFor(() => {
      expect(document.documentElement.classList.contains('dark')).toBe(true);
    });
  });

  it('respects stored "light" preference over matchMedia', async () => {
    mockMatchMedia(true); // OS says dark
    localStorage.setItem(THEME_KEY, 'light'); // but user saved light
    render(App);
    await waitFor(() => {
      expect(document.documentElement.classList.contains('dark')).toBe(false);
    });
  });

  it('toggle adds dark class and persists "dark" to localStorage', async () => {
    mockMatchMedia(false); // start light
    render(App);

    await waitFor(() => {
      expect(document.documentElement.classList.contains('dark')).toBe(false);
    });

    const toggle = screen.getByTestId('theme-toggle');
    await fireEvent.click(toggle);

    await waitFor(() => {
      expect(document.documentElement.classList.contains('dark')).toBe(true);
      expect(localStorage.getItem(THEME_KEY)).toBe('dark');
    });
  });

  it('toggle removes dark class and persists "light" to localStorage', async () => {
    mockMatchMedia(true); // start dark
    render(App);

    await waitFor(() => {
      expect(document.documentElement.classList.contains('dark')).toBe(true);
    });

    const toggle = screen.getByTestId('theme-toggle');
    await fireEvent.click(toggle);

    await waitFor(() => {
      expect(document.documentElement.classList.contains('dark')).toBe(false);
      expect(localStorage.getItem(THEME_KEY)).toBe('light');
    });
  });

  it('toggling twice returns to original state', async () => {
    mockMatchMedia(false);
    render(App);

    await waitFor(() => {
      expect(document.documentElement.classList.contains('dark')).toBe(false);
    });

    const toggle = screen.getByTestId('theme-toggle');
    await fireEvent.click(toggle);

    await waitFor(() => {
      expect(document.documentElement.classList.contains('dark')).toBe(true);
    });

    await fireEvent.click(toggle);

    await waitFor(() => {
      expect(document.documentElement.classList.contains('dark')).toBe(false);
      expect(localStorage.getItem(THEME_KEY)).toBe('light');
    });
  });
});
