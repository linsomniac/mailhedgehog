// AIDEV-NOTE: Tests for mime.ts — SECURITY-CRITICAL module.
// Covers: base64/QP/charset decoding, PartTooLargeError, buildSrcdoc sanitization,
// cid: rewriting, CSP injection, linkify safety.
//
// TextDecoder in Node supports many charsets (shift_jis, iso-2022-jp, etc.) via ICU.
// DOMParser is provided by jsdom in the test environment.

import { describe, it, expect } from 'vitest';
import {
  decodePart,
  PartTooLargeError,
  findPart,
  getPlain,
  buildSrcdoc,
  linkify,
} from './mime.js';
import type { FullMessage, MIMEPart } from './types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMessage(overrides: Partial<FullMessage> = {}): FullMessage {
  return {
    ID: 'test-id',
    From: { Mailbox: 'sender', Domain: 'example.com', Params: '', Relays: null },
    To: [{ Mailbox: 'rcpt', Domain: 'example.com', Params: '', Relays: null }],
    Content: {
      Headers: { 'Content-Type': ['text/plain; charset=utf-8'] },
      Body: 'Hello',
      Size: 5,
      MIME: null,
    },
    MIME: null,
    Created: new Date().toISOString(),
    Raw: { From: '', To: [], Helo: '', Data: '' },
    ...overrides,
  };
}

function makePart(
  contentType: string,
  body: string,
  encoding?: string,
  subParts?: MIMEPart[],
): MIMEPart {
  const headers: { [key: string]: string[] } = {
    'Content-Type': [contentType],
  };
  if (encoding) {
    headers['Content-Transfer-Encoding'] = [encoding];
  }
  return {
    Headers: headers,
    Body: body,
    Size: body.length,
    MIME: subParts ? { Parts: subParts } : null,
  };
}

// ---------------------------------------------------------------------------
// decodePart — base64
// ---------------------------------------------------------------------------

describe('decodePart: base64', () => {
  it('decodes a simple base64 utf-8 string', () => {
    // "Hello, World!" base64 encoded
    const encoded = btoa('Hello, World!');
    expect(decodePart(encoded, 'base64', 'utf-8')).toBe('Hello, World!');
  });

  it('handles base64 with line breaks (RFC 2045 style)', () => {
    const raw = 'Hello, World!';
    // Add line breaks as email would have
    const encoded = btoa(raw).replace(/.{10}/g, '$&\r\n');
    expect(decodePart(encoded, 'base64', 'utf-8')).toBe(raw);
  });

  it('decodes base64 with utf-8 multi-byte characters', () => {
    const text = 'Héllo Wörld';
    const encoded = btoa(
      Array.from(new TextEncoder().encode(text))
        .map((b) => String.fromCharCode(b))
        .join(''),
    );
    expect(decodePart(encoded, 'base64', 'utf-8')).toBe(text);
  });

  it('returns fallback text on malformed base64 (does not throw)', () => {
    const result = decodePart('!!!not-base64!!!', 'base64', 'utf-8');
    expect(result).toContain('[base64 decode error');
    expect(result).toContain('!!!not-base64!!!');
  });

  it('throws PartTooLargeError when decoded size exceeds maxBytes', () => {
    // Create base64 of 100 bytes; set maxBytes to 50
    const bytes = new Uint8Array(100).fill(65); // 100 'A' bytes
    const binStr = Array.from(bytes, (b) => String.fromCharCode(b)).join('');
    const encoded = btoa(binStr);
    expect(() => decodePart(encoded, 'base64', 'utf-8', 50)).toThrow(PartTooLargeError);
  });

  it('PartTooLargeError carries correct byte counts', () => {
    const bytes = new Uint8Array(200).fill(65);
    const binStr = Array.from(bytes, (b) => String.fromCharCode(b)).join('');
    const encoded = btoa(binStr);
    try {
      decodePart(encoded, 'base64', 'utf-8', 50);
      expect.fail('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(PartTooLargeError);
      const e = err as PartTooLargeError;
      expect(e.byteLength).toBeGreaterThan(50);
      expect(e.maxBytes).toBe(50);
    }
  });

  // AIDEV-NOTE: F5 — the malformed-base64 fallback must still honor the size cap. The
  // pre-decode estimate is on the whitespace-stripped length, so a body that fails atob()
  // could otherwise return a raw fallback far larger than maxBytes.
  it('throws PartTooLargeError when a malformed base64 body exceeds maxBytes', () => {
    // estimate (stripped*0.75 ≈ 4MB) passes the cap, atob() throws on '!', and the raw
    // fallback body (>4MB chars) must be rejected rather than returned.
    const body = 'A'.repeat(5_333_332) + '!';
    expect(() => decodePart(body, 'base64', 'utf-8', 4_000_000)).toThrow(PartTooLargeError);
  });

  it('throws PartTooLargeError for whitespace-padded malformed base64 over the cap', () => {
    // stripped length is tiny (estimate trivially passes), but the raw body is huge.
    const body = '!!!' + ' '.repeat(5_000_000);
    expect(() => decodePart(body, 'base64', 'utf-8', 4_000_000)).toThrow(PartTooLargeError);
  });

  it('still returns the raw fallback for a SMALL malformed base64 body', () => {
    const result = decodePart('!!!not-base64!!!', 'base64', 'utf-8', 4_000_000);
    expect(result).toContain('[base64 decode error');
    expect(result).toContain('!!!not-base64!!!');
  });
});

// ---------------------------------------------------------------------------
// decodePart — quoted-printable
// ---------------------------------------------------------------------------

describe('decodePart: quoted-printable', () => {
  it('decodes simple QP with =XX hex sequences', () => {
    // "Héllo" where é = 0xC3 0xA9 in utf-8
    // H=C3=A9llo
    const result = decodePart('H=C3=A9llo', 'quoted-printable', 'utf-8');
    expect(result).toBe('Héllo');
  });

  it('removes soft line breaks (=\\r\\n)', () => {
    const qp = 'Hello,=\r\n World!';
    expect(decodePart(qp, 'quoted-printable', 'utf-8')).toBe('Hello, World!');
  });

  it('removes soft line breaks (=\\n without CR)', () => {
    const qp = 'Hello,=\n World!';
    expect(decodePart(qp, 'quoted-printable', 'utf-8')).toBe('Hello, World!');
  });

  it('does NOT replace literal underscores with spaces (body QP, not RFC2047)', () => {
    const qp = 'hello_world';
    expect(decodePart(qp, 'quoted-printable', 'utf-8')).toBe('hello_world');
  });

  it('throws PartTooLargeError when input exceeds maxBytes', () => {
    const longBody = 'A'.repeat(200);
    expect(() => decodePart(longBody, 'quoted-printable', 'utf-8', 100)).toThrow(PartTooLargeError);
  });
});

// ---------------------------------------------------------------------------
// decodePart — charset handling
// ---------------------------------------------------------------------------

describe('decodePart: charset handling', () => {
  it('decodes shift_jis encoded base64', () => {
    // "テスト" in Shift-JIS
    const shiftJisBytes = new Uint8Array([0x83, 0x65, 0x83, 0x58, 0x83, 0x67]);
    const binStr = Array.from(shiftJisBytes, (b) => String.fromCharCode(b)).join('');
    const encoded = btoa(binStr);
    const result = decodePart(encoded, 'base64', 'shift_jis');
    // Should decode to Japanese katakana テスト
    expect(result).toBe('テスト');
  });

  it('decodes iso-2022-jp encoded base64', () => {
    // "テスト" in ISO-2022-JP: ESC $ B + JIS codes + ESC ( B
    // テ = 0x25 0x46, ス = 0x25 0x39, ト = 0x25 0x48 in JIS X 0208
    const iso2022Bytes = new Uint8Array([
      0x1b, 0x24, 0x42, // ESC $ B
      0x25, 0x46,       // テ
      0x25, 0x39,       // ス
      0x25, 0x48,       // ト
      0x1b, 0x28, 0x42, // ESC ( B
    ]);
    const binStr = Array.from(iso2022Bytes, (b) => String.fromCharCode(b)).join('');
    const encoded = btoa(binStr);
    const result = decodePart(encoded, 'base64', 'iso-2022-jp');
    expect(result).toBe('テスト');
  });

  it('falls back to utf-8 for unknown charset without throwing', () => {
    const encoded = btoa('Hello');
    // Should not throw even with an unknown charset
    expect(() => decodePart(encoded, 'base64', 'x-totally-unknown-charset-42')).not.toThrow();
  });

  it('returns body as-is for 7bit encoding', () => {
    expect(decodePart('Hello World', '7bit', 'utf-8')).toBe('Hello World');
  });

  it('returns body as-is for 8bit encoding', () => {
    expect(decodePart('Hello World', '8bit', 'utf-8')).toBe('Hello World');
  });

  it('returns body as-is for binary encoding', () => {
    expect(decodePart('Hello World', 'binary', 'utf-8')).toBe('Hello World');
  });

  it('returns body as-is for undefined encoding', () => {
    expect(decodePart('Hello World', undefined, undefined)).toBe('Hello World');
  });
});

// ---------------------------------------------------------------------------
// findPart / getHtml / getPlain
// ---------------------------------------------------------------------------

describe('findPart', () => {
  it('finds text/plain in Content for a simple message', () => {
    const msg = makeMessage();
    const part = findPart(msg, 'text/plain');
    expect(part).not.toBeNull();
    expect(part!.Body).toBe('Hello');
  });

  it('returns null when no matching part exists', () => {
    const msg = makeMessage();
    expect(findPart(msg, 'text/html')).toBeNull();
  });

  it('finds text/html in a multipart MIME tree', () => {
    const htmlPart = makePart('text/html; charset=utf-8', '<h1>Hi</h1>');
    const plainPart = makePart('text/plain; charset=utf-8', 'Hi');
    const msg = makeMessage({
      Content: {
        Headers: { 'Content-Type': ['multipart/alternative'] },
        Body: '',
        Size: 0,
        MIME: { Parts: [plainPart, htmlPart] },
      },
      MIME: { Parts: [plainPart, htmlPart] },
    });
    const found = findPart(msg, 'text/html');
    expect(found).not.toBeNull();
    expect(found!.Body).toBe('<h1>Hi</h1>');
  });

  it('finds nested text/plain in deeply nested MIME', () => {
    const inner = makePart('text/plain', 'Deep plain');
    const middle: MIMEPart = {
      Headers: { 'Content-Type': ['multipart/mixed'] },
      Body: '',
      Size: 0,
      MIME: { Parts: [inner] },
    };
    const msg = makeMessage({
      Content: {
        Headers: { 'Content-Type': ['multipart/mixed'] },
        Body: '',
        Size: 0,
        MIME: null,
      },
      MIME: { Parts: [middle] },
    });
    const found = findPart(msg, 'text/plain');
    expect(found).not.toBeNull();
    expect(found!.Body).toBe('Deep plain');
  });
});

describe('getPlain / getHtml', () => {
  it('getPlain decodes a base64 plain part', () => {
    const encoded = btoa('Plain text body');
    const part = makePart('text/plain; charset=utf-8', encoded, 'base64');
    const msg = makeMessage({ MIME: { Parts: [part] }, Content: { Headers: { 'Content-Type': ['multipart/mixed'] }, Body: '', Size: 0, MIME: null } });
    // findPart will fall through to MIME tree
    expect(getPlain(msg)).toBe('Plain text body');
  });
});

// ---------------------------------------------------------------------------
// buildSrcdoc — sanitization
// ---------------------------------------------------------------------------

describe('buildSrcdoc', () => {
  const mockCidUrl = (id: string, cid: string) =>
    `/api/v1/messages/${id}/mime/cid/${encodeURIComponent(cid)}/download`;
  const mockProxyUrl = (url: string) => `/api/v2/proxy?url=${encodeURIComponent(url)}`;
  const cidOpts = { cidUrl: mockCidUrl };

  it('removes all <script> elements', () => {
    const html = '<html><body><script>alert("xss")<\/script><p>Hello</p></body></html>';
    const result = buildSrcdoc(html, 'msg1', cidOpts);
    expect(result).not.toContain('<script');
    expect(result).not.toContain('alert("xss")');
    expect(result).toContain('<p>Hello</p>');
  });

  it('removes all <base> elements', () => {
    const html = '<html><head><base href="https://evil.com/"></head><body>Hi</body></html>';
    const result = buildSrcdoc(html, 'msg1', cidOpts);
    expect(result).not.toContain('<base');
  });

  it('injects CSP meta tag in <head>', () => {
    const html = '<html><head><title>Test</title></head><body>Hi</body></html>';
    const result = buildSrcdoc(html, 'msg1', cidOpts);
    expect(result).toContain('http-equiv');
    expect(result).toContain('Content-Security-Policy');
    expect(result).toContain("script-src 'none'");
    expect(result).toContain("form-action 'none'");
  });

  it('CSP meta is first child of <head>', () => {
    const html = '<html><head><title>Test</title></head><body>Hi</body></html>';
    const result = buildSrcdoc(html, 'msg1', cidOpts);
    // The CSP meta should come before the title
    const cspPos = result.indexOf('Content-Security-Policy');
    const titlePos = result.indexOf('<title>');
    expect(cspPos).toBeLessThan(titlePos);
  });

  it('rewrites cid: img src to API URL', () => {
    const html = '<html><body><img src="cid:logo@example.com"></body></html>';
    const result = buildSrcdoc(html, 'msg-abc', cidOpts);
    expect(result).toContain('/api/v1/messages/msg-abc/mime/cid/');
    expect(result).not.toContain('cid:logo');
  });

  it('rewrites cid: case-insensitively (CID:)', () => {
    const html = '<html><body><img src="CID:logo@example.com"></body></html>';
    const result = buildSrcdoc(html, 'msg-abc', cidOpts);
    expect(result).toContain('/api/v1/messages/msg-abc/mime/cid/');
    expect(result).not.toContain('CID:logo');
  });

  it('does NOT rewrite non-cid URLs', () => {
    const html = '<html><body><img src="https://example.com/img.png"></body></html>';
    const result = buildSrcdoc(html, 'msg1', cidOpts);
    expect(result).toContain('https://example.com/img.png');
  });

  it('returns a string starting with <!doctype html>', () => {
    const html = '<html><body>Hi</body></html>';
    const result = buildSrcdoc(html, 'msg1', cidOpts);
    expect(result.startsWith('<!doctype html>')).toBe(true);
  });

  it('removes multiple scripts', () => {
    const html =
      '<html><head><script>a()<\/script></head><body><script>b()<\/script></body></html>';
    const result = buildSrcdoc(html, 'msg1', cidOpts);
    expect(result).not.toContain('<script');
    expect(result).not.toContain('a()');
    expect(result).not.toContain('b()');
  });

  it('strips angle brackets from cid values', () => {
    // Some emails encode cid as cid:<content-id@host>
    const html = '<html><body><img src="cid:&lt;logo@example.com&gt;"></body></html>';
    const result = buildSrcdoc(html, 'msg-xyz', cidOpts);
    // Should resolve to a URL, not have cid: in src
    expect(result).not.toContain('cid:');
  });

  // M9: CSP meta must be injected even when input HTML has no <head> or <html> element.
  // DOMParser synthesizes a full document (including head) when parsing partial HTML,
  // so buildSrcdoc should still find a <head> to prepend the CSP meta into.
  it('injects CSP meta even when input HTML has no <head> or <html>', () => {
    const html = '<p>hi</p>';
    const result = buildSrcdoc(html, 'msg1', cidOpts);
    expect(result).toContain('Content-Security-Policy');
    expect(result).toContain("script-src 'none'");
    // The output should still be a full document
    expect(result.startsWith('<!doctype html>')).toBe(true);
    // The paragraph content should be preserved
    expect(result).toContain('<p>hi</p>');
  });

  it('rewrites remote http(s) img src to the proxy when proxyImages is on', () => {
    const html = '<html><body><img src="https://h.example/a.png"></body></html>';
    const result = buildSrcdoc(html, 'm', {
      cidUrl: mockCidUrl,
      proxyImages: true,
      proxyUrl: mockProxyUrl,
    });
    expect(result).toContain('/api/v2/proxy?url=https%3A%2F%2Fh.example%2Fa.png');
    expect(result).not.toContain('src="https://h.example/a.png"');
  });

  it('rewrites http img src too (not only https) when proxying', () => {
    const html = '<html><body><img src="http://h.example/a.png"></body></html>';
    const result = buildSrcdoc(html, 'm', {
      cidUrl: mockCidUrl,
      proxyImages: true,
      proxyUrl: mockProxyUrl,
    });
    expect(result).toContain('/api/v2/proxy?url=http%3A%2F%2Fh.example%2Fa.png');
  });

  it('does NOT proxy data: or blob: URLs', () => {
    const html =
      '<html><body><img src="data:image/png;base64,AAAA"><img src="blob:abc"></body></html>';
    const result = buildSrcdoc(html, 'm', {
      cidUrl: mockCidUrl,
      proxyImages: true,
      proxyUrl: mockProxyUrl,
    });
    expect(result).toContain('data:image/png;base64,AAAA');
    expect(result).toContain('blob:abc');
    expect(result).not.toContain('/api/v2/proxy');
  });

  it('proxies cid AND remote together: cid still goes to the cid endpoint', () => {
    const html =
      '<html><body><img src="cid:logo@x"><img src="https://h.example/a.png"></body></html>';
    const result = buildSrcdoc(html, 'm', {
      cidUrl: mockCidUrl,
      proxyImages: true,
      proxyUrl: mockProxyUrl,
    });
    expect(result).toContain('/api/v1/messages/m/mime/cid/');
    expect(result).toContain('/api/v2/proxy?url=https%3A%2F%2Fh.example%2Fa.png');
    expect(result).not.toContain('cid:logo');
  });

  it('proxies srcset entries and inline style url() when proxying', () => {
    const html =
      '<html><body>' +
      '<img srcset="https://h.example/a.png 1x, https://h.example/b.png 2x">' +
      '<div style="background:url(https://h.example/c.png)"></div>' +
      '</body></html>';
    const result = buildSrcdoc(html, 'm', {
      cidUrl: mockCidUrl,
      proxyImages: true,
      proxyUrl: mockProxyUrl,
    });
    expect(result).toContain('/api/v2/proxy?url=https%3A%2F%2Fh.example%2Fa.png');
    expect(result).toContain('/api/v2/proxy?url=https%3A%2F%2Fh.example%2Fb.png');
    expect(result).toContain('/api/v2/proxy?url=https%3A%2F%2Fh.example%2Fc.png');
  });

  it('leaves remote img direct when proxyImages is off', () => {
    const html = '<html><body><img src="https://h.example/a.png"></body></html>';
    const result = buildSrcdoc(html, 'm', { cidUrl: mockCidUrl, proxyImages: false });
    expect(result).toContain('https://h.example/a.png');
    expect(result).not.toContain('/api/v2/proxy');
  });

  // --- srcset with data: URLs (F6) ---
  // AIDEV-NOTE: data: URLs contain commas, so the srcset handler must not split on ','.
  // The cid path runs on EVERY preview (not gated behind proxy), so these protect the
  // common case.
  it('preserves a data: URL srcset candidate with a descriptor (no proxy)', () => {
    const html =
      '<html><body><img srcset="data:image/png;base64,iVBORw0KGgoAAAANS= 1x"></body></html>';
    const result = buildSrcdoc(html, 'm', cidOpts);
    expect(result).toContain('data:image/png;base64,iVBORw0KGgoAAAANS= 1x');
  });

  it('preserves a single data: URL srcset candidate with no descriptor', () => {
    const html =
      '<html><body><img srcset="data:image/png;base64,iVBORw0KGgoAAAANS="></body></html>';
    const result = buildSrcdoc(html, 'm', cidOpts);
    expect(result).toContain('data:image/png;base64,iVBORw0KGgoAAAANS=');
  });

  it('rewrites a remote srcset candidate while keeping a data: candidate intact (proxy on)', () => {
    const html =
      '<html><body><img srcset="https://h.example/a.png 1x, data:image/png;base64,ABCD 2x"></body></html>';
    const result = buildSrcdoc(html, 'm', {
      cidUrl: mockCidUrl,
      proxyImages: true,
      proxyUrl: mockProxyUrl,
    });
    expect(result).toContain('/api/v2/proxy?url=https%3A%2F%2Fh.example%2Fa.png');
    expect(result).toContain('data:image/png;base64,ABCD 2x');
  });

  // AIDEV-NOTE: a comma inside a (...) descriptor is NOT a candidate separator (WHATWG).
  // If the tokenizer split on it, the next candidate's URL would be mis-tokenized and
  // escape rewriting — a remote URL emitted un-proxied (privacy leak) or a cid left broken.
  it('proxies a remote candidate that follows a parenthesized descriptor (no leak)', () => {
    const html =
      '<html><body><img srcset="https://cdn.example/a.jpg 1x(x,y), https://evil.example/track.gif 2x"></body></html>';
    const result = buildSrcdoc(html, 'm', {
      cidUrl: mockCidUrl,
      proxyImages: true,
      proxyUrl: mockProxyUrl,
    });
    expect(result).toContain('/api/v2/proxy?url=https%3A%2F%2Fevil.example%2Ftrack.gif');
    // The remote URL must NOT survive un-proxied (would let the browser fetch it directly).
    expect(result).not.toContain('https://evil.example/track.gif 2x');
  });

  it('rewrites a cid candidate that follows a parenthesized descriptor', () => {
    const html = '<html><body><img srcset="cid:logo@x 1x(a,b), cid:hero@x 2x"></body></html>';
    const result = buildSrcdoc(html, 'm', cidOpts);
    expect(result).toContain('/api/v1/messages/m/mime/cid/' + encodeURIComponent('hero@x'));
    expect(result).not.toContain('cid:hero@x');
  });

  // AIDEV-NOTE: the browser leaves "in parens" on the FIRST ')', so a NESTED/multiple-paren
  // descriptor like "1x(a(b)c" makes the following comma a real separator and the next
  // candidate IS loaded. A depth counter would diverge here and re-open the leak; the
  // boolean in-parens state must match the browser so the next URL is still rewritten.
  it('proxies a remote candidate after a NESTED-paren descriptor (no leak)', () => {
    const html =
      '<html><body><img srcset="https://cdn.example/a.jpg 1x(a(b)c, https://evil.example/track.gif 2x"></body></html>';
    const result = buildSrcdoc(html, 'm', {
      cidUrl: mockCidUrl,
      proxyImages: true,
      proxyUrl: mockProxyUrl,
    });
    expect(result).toContain('/api/v2/proxy?url=https%3A%2F%2Fevil.example%2Ftrack.gif');
    expect(result).not.toContain('https://evil.example/track.gif 2x');
  });

  it('rewrites a cid candidate after a NESTED-paren descriptor', () => {
    const html = '<html><body><img srcset="cid:logo@x 1x(a(b)c, cid:hero@x 2x"></body></html>';
    const result = buildSrcdoc(html, 'm', cidOpts);
    expect(result).toContain('/api/v1/messages/m/mime/cid/' + encodeURIComponent('hero@x'));
    expect(result).not.toContain('cid:hero@x');
  });

  // --- color-scheme: always light (untrusted email renders on a light canvas) ---
  // AIDEV-NOTE: buildSrcdoc ALWAYS injects `<meta name="color-scheme" content="light">`,
  // independent of any option, so email renders like Gmail/Outlook/Apple Mail (a light
  // canvas regardless of the app's dark mode). A <meta> (not a <style>) is used because the
  // srcdoc inherits the app's CSP, which blocks email CSS but not <meta>. It only sets UA
  // defaults — any color the email declares itself still wins.

  it('always injects a color-scheme=light meta', () => {
    const html = '<html><body><p>Hi</p></body></html>';
    const result = buildSrcdoc(html, 'm', cidOpts);
    expect(result).toContain('<meta name="color-scheme" content="light">');
  });

  it('renders light even when proxying images', () => {
    const html = '<html><body><p>Hi</p></body></html>';
    const result = buildSrcdoc(html, 'm', {
      cidUrl: mockCidUrl,
      proxyImages: true,
      proxyUrl: mockProxyUrl,
    });
    expect(result).toContain('<meta name="color-scheme" content="light">');
  });

  it('never forces a dark color-scheme', () => {
    const html = '<html><body><p>Hi</p></body></html>';
    const result = buildSrcdoc(html, 'm', cidOpts);
    expect(result).not.toContain('content="dark"');
  });

  it('uses a <meta> tag, not a <style> rule (survives the inherited CSP)', () => {
    const html = '<html><body><p>Hi</p></body></html>';
    const result = buildSrcdoc(html, 'm', cidOpts);
    expect(result).toContain('<meta name="color-scheme" content="light">');
    expect(result).not.toContain('color-scheme:light'); // not injected as CSS
  });

  it('preserves author-declared colors (overrides are honored)', () => {
    const html =
      '<html><head><style>a{color:#0a0}</style></head>' +
      '<body><p style="color:#c00">Hi</p></body></html>';
    const result = buildSrcdoc(html, 'm', cidOpts);
    // The email's own colors are never stripped — color-scheme only sets defaults.
    expect(result).toContain('a{color:#0a0}');
    expect(result).toContain('color:#c00');
  });
});

// ---------------------------------------------------------------------------
// linkify — safety and token structure
// ---------------------------------------------------------------------------

describe('linkify', () => {
  it('produces a link token for an http URL', () => {
    const tokens = linkify('Visit http://example.com today');
    const link = tokens.find((t) => t.type === 'link');
    expect(link).toBeTruthy();
    expect(link!.href).toBe('http://example.com');
  });

  it('produces a link token for an https URL', () => {
    const tokens = linkify('See https://example.com/path?q=1');
    const link = tokens.find((t) => t.type === 'link');
    expect(link).toBeTruthy();
    expect(link!.href).toContain('https://example.com');
  });

  it('produces a link token for a mailto: URL', () => {
    const tokens = linkify('Email mailto:user@example.com now');
    const link = tokens.find((t) => t.type === 'link');
    expect(link).toBeTruthy();
    expect(link!.href).toBe('mailto:user@example.com');
  });

  it('does NOT produce a link token for javascript: (security)', () => {
    const tokens = linkify('Click javascript:alert(1)');
    expect(tokens.every((t) => t.type === 'text')).toBe(true);
  });

  it('does NOT produce a link token for data: (security)', () => {
    const tokens = linkify('See data:text/html,<script>alert(1)<\/script>');
    expect(tokens.every((t) => t.type === 'text')).toBe(true);
  });

  it('preserves surrounding text as text tokens', () => {
    const tokens = linkify('Hello http://example.com world');
    expect(tokens[0]).toEqual({ type: 'text', value: 'Hello ' });
    expect(tokens[1]).toMatchObject({ type: 'link', href: 'http://example.com' });
    expect(tokens[2]).toEqual({ type: 'text', value: ' world' });
  });

  it('handles text with no URLs as a single text token', () => {
    const tokens = linkify('No links here!');
    expect(tokens).toHaveLength(1);
    expect(tokens[0]).toEqual({ type: 'text', value: 'No links here!' });
  });

  it('handles empty string', () => {
    const tokens = linkify('');
    expect(tokens).toHaveLength(0);
  });

  it('handles multiple URLs', () => {
    const tokens = linkify('http://a.com and https://b.com');
    const links = tokens.filter((t) => t.type === 'link');
    expect(links).toHaveLength(2);
  });

  it('text tokens preserve original content — no HTML injection', () => {
    const text = 'Hello <script>alert("xss")</script>';
    const tokens = linkify(text);
    // All tokens are text type; NO link was generated
    expect(tokens.every((t) => t.type === 'text')).toBe(true);
    // The literal angle brackets are preserved (component renders as text, not HTML)
    const combined = tokens.map((t) => t.value).join('');
    expect(combined).toBe(text);
  });
});
