// AIDEV-NOTE: MessageRow component tests.
// We test style/class invariants (fixed height + ellipsis/nowrap) that protect the
// virtualizer's offset math. jsdom does not compute layout, so we assert CSS properties
// on the rendered DOM element, not actual pixel measurements.
//
// A 5000-char subject MUST NOT escape the row — we verify the style/class is applied,
// not that layout clamps (jsdom won't compute that).

import { render, screen } from '@testing-library/svelte';
import { describe, it, expect, vi, beforeEach } from 'vitest';

// AIDEV-NOTE: Mock the store so MessageRow doesn't depend on real store state.
vi.mock('../lib/store.svelte.js', () => ({
  store: {
    selectedId: null,
    select: vi.fn(),
  },
}));

// AIDEV-NOTE: Mock api module to prevent any real fetches (store mock uses it indirectly).
vi.mock('../lib/api.js', () => ({
  listMessages: vi.fn(),
  searchMessages: vi.fn(),
  getMessage: vi.fn(),
  deleteAll: vi.fn(),
  deleteMessage: vi.fn(),
}));

import { ROW_HEIGHT } from './constants.js';
import MessageRow from './MessageRow.svelte';

function makeSummary(overrides: Partial<{
  ID: string;
  Subject: string;
  Size: number;
  Created: string;
}> = {}) {
  return {
    ID: overrides.ID ?? 'test-id',
    From: { Mailbox: 'sender', Domain: 'example.com', Params: '', Relays: null },
    To: [{ Mailbox: 'rcpt', Domain: 'example.com', Params: '', Relays: null }],
    Subject: overrides.Subject ?? 'Test Subject',
    Created: overrides.Created ?? new Date(Date.now() - 60_000).toISOString(),
    Size: overrides.Size ?? 1024,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('MessageRow', () => {
  it('exports ROW_HEIGHT as a positive number', () => {
    expect(ROW_HEIGHT).toBeGreaterThan(0);
    expect(typeof ROW_HEIGHT).toBe('number');
  });

  it('renders sender email address', () => {
    render(MessageRow, { props: { summary: makeSummary() } });
    expect(screen.getByText('sender@example.com')).toBeTruthy();
  });

  it('renders subject', () => {
    render(MessageRow, { props: { summary: makeSummary({ Subject: 'Hello World' }) } });
    expect(screen.getByText('Hello World')).toBeTruthy();
  });

  it('applies fixed height style to the row element', () => {
    const { container } = render(MessageRow, { props: { summary: makeSummary() } });
    const row = container.querySelector('.message-row') as HTMLElement;
    expect(row).toBeTruthy();
    expect(row.style.height).toBe(`${ROW_HEIGHT}px`);
    expect(row.style.maxHeight).toBe(`${ROW_HEIGHT}px`);
    expect(row.style.overflow).toBe('hidden');
  });

  it('applies overflow:hidden and text-overflow:ellipsis to subject span', () => {
    render(MessageRow, { props: { summary: makeSummary({ Subject: 'Test Subject' }) } });
    const spans = document.querySelectorAll('span[style*="text-overflow: ellipsis"]');
    // At least one span with ellipsis style should exist
    expect(spans.length).toBeGreaterThan(0);
  });

  it('applies whitespace:nowrap to subject span so it cannot wrap', () => {
    render(MessageRow, { props: { summary: makeSummary({ Subject: 'Test Subject' }) } });
    const spans = document.querySelectorAll('span[style*="white-space: nowrap"]');
    expect(spans.length).toBeGreaterThan(0);
  });

  it('CRITICAL: 5000-char subject does not change row height (overflow:hidden applied)', () => {
    // AIDEV-NOTE: jsdom cannot compute actual layout height changes, but we verify
    // overflow:hidden is on the row. This is the invariant that protects the virtualizer.
    const longSubject = 'A'.repeat(5000);
    const { container } = render(MessageRow, {
      props: { summary: makeSummary({ Subject: longSubject }) },
    });
    const row = container.querySelector('.message-row') as HTMLElement;
    expect(row).toBeTruthy();
    // The fixed height + overflow:hidden is the guard. Verify both are set.
    expect(row.style.height).toBe(`${ROW_HEIGHT}px`);
    expect(row.style.overflow).toBe('hidden');
    // Subject text is in a nowrap+ellipsis span
    const spans = container.querySelectorAll('span[style*="white-space: nowrap"]');
    expect(spans.length).toBeGreaterThan(0);
  });

  it('renders size formatted as KB for values >=1024', () => {
    render(MessageRow, { props: { summary: makeSummary({ Size: 2048 }) } });
    expect(screen.getByText('2.0 KB')).toBeTruthy();
  });

  it('renders size formatted as B for small values', () => {
    render(MessageRow, { props: { summary: makeSummary({ Size: 512 }) } });
    expect(screen.getByText('512 B')).toBeTruthy();
  });

  it('renders relative time (just now for very recent messages)', () => {
    const recentCreated = new Date(Date.now() - 5000).toISOString();
    render(MessageRow, { props: { summary: makeSummary({ Created: recentCreated }) } });
    expect(screen.getByText('just now')).toBeTruthy();
  });

  it('renders "(no subject)" for empty subject', () => {
    render(MessageRow, { props: { summary: makeSummary({ Subject: '' }) } });
    expect(screen.getByText('(no subject)')).toBeTruthy();
  });
});
