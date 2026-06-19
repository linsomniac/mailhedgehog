// AIDEV-NOTE: MessageDetail tab-stability test. Uses the REAL store (not a mock) because
// the behavior under test is reactive: the message-keyed $effect that picks the initial tab
// wraps its body in untrack() so that reading store.proxyImages inside buildHtmlTab does NOT
// register proxyImages as a dependency. Otherwise, when the proxy-images config resolves
// AFTER a message is already open (store.loadConfig flips proxyImages), the effect would
// re-run and wrongly reset the active tab back to HTML. A non-reactive mock store cannot
// exercise this. Only api.js (pure URL builders + unused network fns) is mocked.
//
// This replaces the tab-stability coverage previously carried by the (now-removed)
// theme-reactivity test: the email body no longer tracks the UI theme (it always renders
// on a light canvas), so proxyImages is the only remaining store read inside the effect.

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

import { getConfig } from '../lib/api.js';
import { store } from '../lib/store.svelte.js';
import MessageDetail from './MessageDetail.svelte';

function makeHtmlMessage(): FullMessage {
  const htmlBody = btoa('<html><body><h1>Hello HTML</h1><p>World</p></body></html>');
  return {
    ID: 'stability-msg-1',
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

beforeEach(() => {
  store.resetForTest(); // proxyImages back to false
  vi.mocked(getConfig).mockResolvedValue({ proxyRemoteImages: false });
});

describe('MessageDetail: tab stability', () => {
  it('always renders the HTML body on a light canvas', async () => {
    render(MessageDetail, { props: { message: makeHtmlMessage() } });
    await waitFor(() => {
      const ifr = document.querySelector(
        'iframe[data-testid="html-iframe"]',
      ) as HTMLIFrameElement | null;
      expect(ifr?.getAttribute('srcdoc') ?? '').toContain(
        '<meta name="color-scheme" content="light">',
      );
    });
  });

  it('does NOT change the active tab when proxyImages config resolves after open', async () => {
    render(MessageDetail, { props: { message: makeHtmlMessage() } });

    // Move off the default HTML tab.
    await waitFor(() => expect(screen.getByTestId('panel-html')).toBeTruthy());
    await fireEvent.click(screen.getByTestId('tab-source'));
    expect(screen.getByTestId('panel-source')).toBeTruthy();

    // Simulate the proxy-images config resolving AFTER the message is already open: this
    // flips store.proxyImages reactively. The untrack() guard means the tab-selection
    // effect must NOT re-run, so the active tab stays on Source.
    vi.mocked(getConfig).mockResolvedValue({ proxyRemoteImages: true });
    await store.loadConfig();
    expect(store.proxyImages).toBe(true);
    await tick();
    await tick();

    expect(screen.getByTestId('panel-source')).toBeTruthy();
    expect(screen.queryByTestId('panel-html')).toBeNull();
  });
});
