// AIDEV-NOTE: MessageDetail component tests — SECURITY-CRITICAL.
// Tests verify:
// 1. All five tabs render correctly
// 2. HTML tab yields an iframe whose sandbox attribute LACKS allow-scripts
// 3. Plain tab renders linkified anchors with correct rel attributes
// 4. Source tab renders as literal text (a <script> in Raw.Data is NOT executed/parsed as an element)
// 5. Headers tab renders header name/value pairs
// 6. MIME parts tab renders download links
//
// AIDEV-NOTE: We must mock store, api, and mime modules to control test behavior.
// The vi.hoisted pattern is required because vi.mock factories are hoisted above imports.

import { render, screen, fireEvent, waitFor } from '@testing-library/svelte';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FullMessage } from '../lib/types.js';

// --- Mock api module ---
vi.mock('../lib/api.js', () => ({
  emlUrl: vi.fn((id: string) => `/api/v1/messages/${id}/download`),
  partUrl: vi.fn((id: string, n: number) => `/api/v1/messages/${id}/mime/part/${n}/download`),
  cidUrl: vi.fn((id: string, cid: string) => `/api/v1/messages/${id}/mime/cid/${encodeURIComponent(cid)}/download`),
  proxyUrl: vi.fn((url: string) => `/api/v2/proxy?url=${encodeURIComponent(url)}`),
  getMessage: vi.fn(),
  listMessages: vi.fn(),
  searchMessages: vi.fn(),
  deleteAll: vi.fn(),
  deleteMessage: vi.fn(),
}));

// --- Mock store ---
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
    proxyImages: false,
    showPending: vi.fn().mockResolvedValue(undefined),
    setAtTop: vi.fn(),
    loadMore: vi.fn().mockResolvedValue(undefined),
    select: vi.fn().mockResolvedValue(null),
    deleteOne: vi.fn().mockResolvedValue(undefined),
    resetForTest: vi.fn(),
  };
  return { mockStore };
});

vi.mock('../lib/store.svelte.js', () => ({
  store: mockStore,
}));

// --- Helpers ---

function makeFullMessage(overrides: Partial<FullMessage> = {}): FullMessage {
  return {
    ID: 'test-msg-1',
    From: { Mailbox: 'sender', Domain: 'example.com', Params: '', Relays: null },
    To: [{ Mailbox: 'rcpt', Domain: 'example.com', Params: '', Relays: null }],
    Content: {
      Headers: {
        'Content-Type': ['text/plain; charset=utf-8'],
        'Subject': ['Test Subject'],
        'From': ['sender@example.com'],
      },
      Body: 'Hello, plain text world!',
      Size: 25,
      MIME: null,
    },
    MIME: null,
    Created: new Date().toISOString(),
    Raw: {
      From: 'sender@example.com',
      To: ['rcpt@example.com'],
      Helo: 'localhost',
      Data: 'From: sender@example.com\r\nTo: rcpt@example.com\r\nSubject: Test\r\n\r\nHello, plain text world!',
    },
    ...overrides,
  };
}

function makeHtmlMessage(): FullMessage {
  const htmlBody = btoa('<html><body><h1>Hello HTML</h1><p>World</p></body></html>');
  return makeFullMessage({
    Content: {
      Headers: { 'Content-Type': ['multipart/alternative'] },
      Body: '',
      Size: 0,
      MIME: null,
    },
    MIME: {
      Parts: [
        {
          Headers: { 'Content-Type': ['text/plain; charset=utf-8'] },
          Body: 'Hello plain',
          Size: 11,
          MIME: null,
        },
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
  });
}

// ---------------------------------------------------------------------------
// Import after mocks
// ---------------------------------------------------------------------------
import MessageDetail from './MessageDetail.svelte';

beforeEach(() => {
  vi.clearAllMocks();
  mockStore.deleteOne = vi.fn().mockResolvedValue(undefined);
});

// ---------------------------------------------------------------------------
// Tab rendering
// ---------------------------------------------------------------------------

describe('MessageDetail: tab rendering', () => {
  it('renders all five tab buttons', () => {
    const msg = makeFullMessage();
    render(MessageDetail, { props: { message: msg } });

    expect(screen.getByTestId('tab-html')).toBeTruthy();
    expect(screen.getByTestId('tab-plain')).toBeTruthy();
    expect(screen.getByTestId('tab-source')).toBeTruthy();
    expect(screen.getByTestId('tab-headers')).toBeTruthy();
    expect(screen.getByTestId('tab-parts')).toBeTruthy();
  });

  it('shows the HTML panel by default when an HTML part exists', () => {
    render(MessageDetail, { props: { message: makeHtmlMessage() } });
    expect(screen.getByTestId('panel-html')).toBeTruthy();
  });

  it('switches to Plain tab on click', async () => {
    const msg = makeFullMessage();
    render(MessageDetail, { props: { message: msg } });

    await fireEvent.click(screen.getByTestId('tab-plain'));
    expect(screen.getByTestId('panel-plain')).toBeTruthy();
  });

  it('switches to Source tab on click', async () => {
    const msg = makeFullMessage();
    render(MessageDetail, { props: { message: msg } });

    await fireEvent.click(screen.getByTestId('tab-source'));
    expect(screen.getByTestId('panel-source')).toBeTruthy();
  });

  it('switches to Headers tab on click', async () => {
    const msg = makeFullMessage();
    render(MessageDetail, { props: { message: msg } });

    await fireEvent.click(screen.getByTestId('tab-headers'));
    expect(screen.getByTestId('panel-headers')).toBeTruthy();
  });

  it('switches to MIME parts tab on click', async () => {
    const msg = makeFullMessage();
    render(MessageDetail, { props: { message: msg } });

    await fireEvent.click(screen.getByTestId('tab-parts'));
    expect(screen.getByTestId('panel-parts')).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// HTML tab — iframe security
// ---------------------------------------------------------------------------

describe('MessageDetail: HTML tab iframe security', () => {
  it('renders an iframe for an HTML email', async () => {
    const msg = makeHtmlMessage();
    render(MessageDetail, { props: { message: msg } });

    // Wait for srcdoc to be built
    await waitFor(() => {
      const iframe = document.querySelector('iframe[data-testid="html-iframe"]');
      expect(iframe).toBeTruthy();
    });
  });

  it('iframe sandbox attribute DOES NOT include allow-scripts', async () => {
    const msg = makeHtmlMessage();
    render(MessageDetail, { props: { message: msg } });

    await waitFor(() => {
      const iframe = document.querySelector('iframe[data-testid="html-iframe"]') as HTMLIFrameElement | null;
      expect(iframe).toBeTruthy();
      const sandbox = iframe!.getAttribute('sandbox') ?? '';
      expect(sandbox.toLowerCase()).not.toContain('allow-scripts');
    });
  });

  it('iframe sandbox attribute DOES NOT include allow-same-origin', async () => {
    const msg = makeHtmlMessage();
    render(MessageDetail, { props: { message: msg } });

    await waitFor(() => {
      const iframe = document.querySelector('iframe[data-testid="html-iframe"]') as HTMLIFrameElement | null;
      expect(iframe).toBeTruthy();
      const sandbox = iframe!.getAttribute('sandbox') ?? '';
      expect(sandbox.toLowerCase()).not.toContain('allow-same-origin');
    });
  });

  // AIDEV-NOTE: untrusted email always renders on a light canvas (like Gmail/Outlook),
  // independent of the app's dark/light theme. The iframe element itself also pins
  // color-scheme:light so its backdrop/scrollbars match.
  it('always builds the HTML iframe with color-scheme:light', async () => {
    render(MessageDetail, { props: { message: makeHtmlMessage() } });
    await waitFor(() => {
      const iframe = document.querySelector(
        'iframe[data-testid="html-iframe"]',
      ) as HTMLIFrameElement | null;
      expect(iframe).toBeTruthy();
      expect(iframe!.getAttribute('srcdoc') ?? '').toContain(
        '<meta name="color-scheme" content="light">',
      );
      expect(iframe!.getAttribute('style') ?? '').toContain('color-scheme: light');
    });
  });

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
});

// ---------------------------------------------------------------------------
// Plain tab — linkify and no {@html}
// ---------------------------------------------------------------------------

describe('MessageDetail: Plain tab', () => {
  it('renders plain text content', async () => {
    const msg = makeFullMessage();
    render(MessageDetail, { props: { message: msg } });
    await fireEvent.click(screen.getByTestId('tab-plain'));

    await waitFor(() => {
      expect(screen.getByText(/Hello, plain text world!/)).toBeTruthy();
    });
  });

  it('renders linkified anchors with rel="noopener noreferrer nofollow"', async () => {
    const msg = makeFullMessage({
      Content: {
        Headers: { 'Content-Type': ['text/plain; charset=utf-8'] },
        Body: 'Visit http://example.com for details',
        Size: 36,
        MIME: null,
      },
    });
    render(MessageDetail, { props: { message: msg } });
    await fireEvent.click(screen.getByTestId('tab-plain'));

    await waitFor(() => {
      const links = document.querySelectorAll('[data-testid="plain-link"]');
      expect(links.length).toBeGreaterThan(0);
      const link = links[0] as HTMLAnchorElement;
      expect(link.rel).toContain('noopener');
      expect(link.rel).toContain('noreferrer');
      expect(link.rel).toContain('nofollow');
      expect(link.getAttribute('target')).toBe('_blank');
    });
  });
});

// ---------------------------------------------------------------------------
// Source tab — text interpolation (not HTML)
// ---------------------------------------------------------------------------

describe('MessageDetail: Source tab', () => {
  it('renders raw email source in a <pre> element', async () => {
    const msg = makeFullMessage();
    render(MessageDetail, { props: { message: msg } });
    await fireEvent.click(screen.getByTestId('tab-source'));

    const pre = screen.getByTestId('source-pre');
    expect(pre).toBeTruthy();
    expect(pre.textContent).toContain('From: sender@example.com');
  });

  it('a <script> in Raw.Data appears as literal text, NOT as a parsed script element', async () => {
    const scriptPayload = '<script>alert("xss")<\/script>';
    const msg = makeFullMessage({
      Raw: {
        From: 'sender@example.com',
        To: ['rcpt@example.com'],
        Helo: 'localhost',
        Data: `Subject: Test\r\n\r\n${scriptPayload}`,
      },
    });
    render(MessageDetail, { props: { message: msg } });
    await fireEvent.click(screen.getByTestId('tab-source'));

    const pre = screen.getByTestId('source-pre');
    // The <script> tag should appear as literal text content
    expect(pre.textContent).toContain(scriptPayload);
    // There should be NO actual <script> elements inside the pre
    expect(pre.querySelectorAll('script').length).toBe(0);
  });

  it('shows truncation notice and download link when source exceeds 256 KB', async () => {
    const bigData = 'A'.repeat(260 * 1024); // >256 KB
    const msg = makeFullMessage({
      Raw: {
        From: '',
        To: [],
        Helo: '',
        Data: bigData,
      },
    });
    render(MessageDetail, { props: { message: msg } });
    await fireEvent.click(screen.getByTestId('tab-source'));

    await waitFor(() => {
      expect(screen.getByText(/Source truncated/)).toBeTruthy();
    });
  });
});

// ---------------------------------------------------------------------------
// Headers tab
// ---------------------------------------------------------------------------

describe('MessageDetail: Headers tab', () => {
  it('renders header names and values', async () => {
    const msg = makeFullMessage();
    render(MessageDetail, { props: { message: msg } });
    await fireEvent.click(screen.getByTestId('tab-headers'));

    // Content-Type header should be visible
    expect(screen.getByText('Content-Type')).toBeTruthy();
    expect(screen.getByText('text/plain; charset=utf-8')).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// MIME parts tab
// ---------------------------------------------------------------------------

describe('MessageDetail: MIME parts tab', () => {
  it('shows "No MIME parts" for a simple plain text message', async () => {
    const msg = makeFullMessage();
    render(MessageDetail, { props: { message: msg } });
    await fireEvent.click(screen.getByTestId('tab-parts'));

    expect(screen.getByText(/No MIME parts/)).toBeTruthy();
  });

  it('lists parts with download links for multipart messages', async () => {
    const msg = makeHtmlMessage();
    render(MessageDetail, { props: { message: msg } });
    await fireEvent.click(screen.getByTestId('tab-parts'));

    await waitFor(() => {
      const downloads = document.querySelectorAll('[data-testid^="part-download-"]');
      expect(downloads.length).toBeGreaterThan(0);
    });
  });

  // I2: nested multipart — download indices must match top-level parts only.
  // A message with multipart/mixed → [multipart/alternative, attachment] has two
  // top-level parts (index 0 and 1). The nested sub-parts inside the alternative
  // must NOT get their own download indices.
  it('download indices correspond to top-level parts only for nested multipart', async () => {
    const nestedMsg: FullMessage = makeFullMessage({
      MIME: {
        Parts: [
          // Top-level part 0: multipart/alternative with two sub-parts
          {
            Headers: { 'Content-Type': ['multipart/alternative'] },
            Body: '',
            Size: 0,
            MIME: {
              Parts: [
                {
                  Headers: { 'Content-Type': ['text/plain; charset=utf-8'] },
                  Body: 'plain',
                  Size: 5,
                  MIME: null,
                },
                {
                  Headers: { 'Content-Type': ['text/html; charset=utf-8'] },
                  Body: btoa('<p>html</p>'),
                  Size: 10,
                  MIME: null,
                },
              ],
            },
          },
          // Top-level part 1: an attachment
          {
            Headers: {
              'Content-Type': ['application/pdf'],
              'Content-Disposition': ['attachment; filename="doc.pdf"'],
            },
            Body: btoa('pdfdata'),
            Size: 7,
            MIME: null,
          },
        ],
      },
    });

    render(MessageDetail, { props: { message: nestedMsg } });
    await fireEvent.click(screen.getByTestId('tab-parts'));

    await waitFor(() => {
      // Exactly 2 download links: index 0 and index 1 (top-level only, not the 2 sub-parts)
      const dl0 = document.querySelector('[data-testid="part-download-0"]') as HTMLAnchorElement | null;
      const dl1 = document.querySelector('[data-testid="part-download-1"]') as HTMLAnchorElement | null;
      const dl2 = document.querySelector('[data-testid="part-download-2"]');

      expect(dl0).toBeTruthy();
      expect(dl1).toBeTruthy();
      // No index-2 download — nested sub-parts do not get their own download links
      expect(dl2).toBeNull();

      // Verify the URLs use the correct top-level indices
      expect(dl0!.getAttribute('href')).toContain('/mime/part/0/download');
      expect(dl1!.getAttribute('href')).toContain('/mime/part/1/download');
    });
  });
});

// ---------------------------------------------------------------------------
// I1 regression: PartTooLargeError from getHtml() in initial-tab $effect
// ---------------------------------------------------------------------------

describe('MessageDetail: large HTML email does not crash (I1 regression)', () => {
  // AIDEV-NOTE: This test guards against the I1 regression where getHtml() in the
  // initial-tab $effect was called outside any try/catch. For HTML parts > 4 MB
  // (no Content-Transfer-Encoding, so the raw body is decoded directly), decodePart()
  // throws PartTooLargeError. The fix wraps the detection in try/catch so the throw
  // routes to the HTML tab, where buildHtmlTab() shows the graceful too-large notice.
  it('shows the too-large notice instead of crashing for a >4MB HTML body', async () => {
    // Build a FullMessage with a text/html MIME part whose raw Body exceeds 4 MB.
    // No Content-Transfer-Encoding → decodePart() reads the body directly and throws
    // PartTooLargeError before returning. The component MUST NOT propagate this throw.
    const bigHtmlBody = 'x'.repeat(4_200_000);
    const largeHtmlMsg = makeFullMessage({
      Content: {
        Headers: { 'Content-Type': ['multipart/alternative'] },
        Body: '',
        Size: 0,
        MIME: null,
      },
      MIME: {
        Parts: [
          {
            Headers: { 'Content-Type': ['text/plain; charset=utf-8'] },
            Body: 'plain fallback',
            Size: 14,
            MIME: null,
          },
          {
            // No Content-Transfer-Encoding — raw body decode path triggers PartTooLargeError
            Headers: { 'Content-Type': ['text/html; charset=utf-8'] },
            Body: bigHtmlBody,
            Size: bigHtmlBody.length,
            MIME: null,
          },
        ],
      },
    });

    // Rendering must not throw even though getHtml() will throw PartTooLargeError
    render(MessageDetail, { props: { message: largeHtmlMsg } });

    // The HTML tab should be active and show the graceful too-large notice
    await waitFor(() => {
      expect(screen.getByText(/too large to preview/i)).toBeTruthy();
    });

    // Must not show plain tab panel (was not routed to plain)
    expect(screen.queryByTestId('panel-plain')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

describe('MessageDetail: actions', () => {
  it('renders Download .eml link with correct href', () => {
    const msg = makeFullMessage();
    render(MessageDetail, { props: { message: msg } });

    const link = screen.getByText('Download .eml') as HTMLAnchorElement;
    expect(link.getAttribute('href')).toContain('test-msg-1');
  });

  it('calls store.deleteOne when Delete is clicked', async () => {
    const msg = makeFullMessage();
    render(MessageDetail, { props: { message: msg } });

    await fireEvent.click(screen.getByText('Delete'));
    expect(mockStore.deleteOne).toHaveBeenCalledWith('test-msg-1');
  });
});

// ---------------------------------------------------------------------------
// Close button + dark mode
// ---------------------------------------------------------------------------

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
