// AIDEV-NOTE: MessageDetail theme-reactivity tests. These use the REAL store (not a
// mock) because the behavior under test is reactive: toggling store.isDark must
//   (a) rebuild the HTML srcdoc so the iframe's color-scheme matches the theme, and
//   (b) NOT change the active tab — the reason MessageDetail splits tab-selection (an
//       effect keyed on `message`, wrapped in untrack) from theme-driven rebuild (an
//       effect keyed on store.isDark). A non-reactive mock store cannot exercise this.
// Only api.js (pure URL builders + unused network fns) is mocked.

import { render, screen, fireEvent, waitFor } from '@testing-library/svelte';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { tick } from 'svelte';
import type { FullMessage } from '../lib/types.js';

vi.mock('../lib/api.js', () => ({
  emlUrl: (id: string) => `/api/v1/messages/${id}/download`,
  partUrl: (id: string, n: number) => `/api/v1/messages/${id}/mime/part/${n}/download`,
  cidUrl: (id: string, cid: string) =>
    `/api/v1/messages/${id}/mime/cid/${encodeURIComponent(cid)}/download`,
  proxyUrl: (url: string) => `/api/v2/proxy?url=${encodeURIComponent(url)}`,
  getMessage: vi.fn(),
  listMessages: vi.fn(),
  searchMessages: vi.fn(),
  getConfig: vi.fn().mockResolvedValue({ proxyRemoteImages: false }),
  deleteAll: vi.fn(),
  deleteMessage: vi.fn(),
}));

import { store } from '../lib/store.svelte.js';
import MessageDetail from './MessageDetail.svelte';

function makeHtmlMessage(): FullMessage {
  const htmlBody = btoa('<html><body><h1>Hello HTML</h1><p>World</p></body></html>');
  return {
    ID: 'theme-msg-1',
    From: { Mailbox: 'sender', Domain: 'example.com', Params: '', Relays: null },
    To: [{ Mailbox: 'rcpt', Domain: 'example.com', Params: '', Relays: null }],
    Content: { Headers: { 'Content-Type': ['multipart/alternative'] }, Body: '', Size: 0, MIME: null },
    MIME: {
      Parts: [
        {
          Headers: {
            'Content-Type': ['text/html; charset=utf-8'],
            'Content-Transfer-Encoding': ['base64'],
          },
          Body: htmlBody,
          Size: htmlBody.length,
          MIME: null,
        },
      ],
    },
    Created: new Date().toISOString(),
    Raw: { From: 'sender@example.com', To: ['rcpt@example.com'], Helo: 'localhost', Data: 'raw' },
  };
}

function iframeSrcdoc(): string {
  const ifr = document.querySelector('iframe[data-testid="html-iframe"]') as HTMLIFrameElement | null;
  return ifr?.getAttribute('srcdoc') ?? '';
}

beforeEach(() => {
  store.resetForTest(); // isDark back to false (light)
});

describe('MessageDetail: theme reactivity', () => {
  it('rebuilds the HTML srcdoc color-scheme when the theme toggles', async () => {
    render(MessageDetail, { props: { message: makeHtmlMessage() } });

    await waitFor(() => {
      expect(iframeSrcdoc()).toContain('<meta name="color-scheme" content="light">');
    });

    store.setTheme(true);
    await waitFor(() => {
      expect(iframeSrcdoc()).toContain('<meta name="color-scheme" content="dark">');
    });
    // Still on the HTML tab after the toggle.
    expect(screen.getByTestId('panel-html')).toBeTruthy();

    store.setTheme(false);
    await waitFor(() => {
      expect(iframeSrcdoc()).toContain('<meta name="color-scheme" content="light">');
    });
  });

  it('does NOT change the active tab when the theme toggles', async () => {
    render(MessageDetail, { props: { message: makeHtmlMessage() } });

    // Move off the default HTML tab.
    await waitFor(() => expect(screen.getByTestId('panel-html')).toBeTruthy());
    await fireEvent.click(screen.getByTestId('tab-source'));
    expect(screen.getByTestId('panel-source')).toBeTruthy();

    // Toggle the theme; the rebuild effect runs, but the active tab must stay on Source.
    store.setTheme(true);
    await tick();
    await tick();

    expect(screen.getByTestId('panel-source')).toBeTruthy();
    expect(screen.queryByTestId('panel-html')).toBeNull();
  });
});
