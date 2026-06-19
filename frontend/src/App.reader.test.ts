// AIDEV-NOTE: App reader-open tests. A dedicated mock where selectedId is set and select()
// resolves a (plain) message, so the reader, splitter, and close affordances render.
import { render, screen, fireEvent, waitFor } from '@testing-library/svelte';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FullMessage } from './lib/types.js';

// AIDEV-NOTE: vi.mock is hoisted so we use vi.hoisted() to define shared values
// that need to be available both inside the factory and in tests.
const { clearSelect, mockSelect } = vi.hoisted(() => {
  const fullMessage = {
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
  } satisfies FullMessage;
  return {
    clearSelect: vi.fn(),
    mockSelect: vi.fn().mockResolvedValue(fullMessage),
  };
});

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
    select: mockSelect,
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
