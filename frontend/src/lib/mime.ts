// AIDEV-NOTE: SECURITY-CRITICAL module — handles untrusted email content decoding and sanitization.
// All HTML rendering goes through buildSrcdoc() which:
//   1. Strips <script> and <base> elements
//   2. Rewrites cid: refs to same-origin API URLs
//   3. If opts.proxyImages, rewrites remaining http(s) image refs through opts.proxyUrl
//      (runs AFTER cid rewrite so /api/... cid URLs are NOT re-proxied)
//   4. Injects a Content-Security-Policy meta tag (scripts blocked, forms blocked)
//   5. Returns a string for use as iframe srcdoc (with sandbox="" — no allow-scripts/allow-same-origin)
//
// Plain text is NEVER inserted via {@html}; linkify() returns tokens the component renders as text.
// The only {@html} allowed in the entire frontend is the iframe srcdoc binding.

import type { FullMessage, MIMEPart } from './types.js';

// AIDEV-NOTE: PartTooLargeError is thrown when decoded content exceeds maxBytes.
// Components must catch this and show a "too large to preview — download instead" message.
export class PartTooLargeError extends Error {
  constructor(public readonly byteLength: number, public readonly maxBytes: number) {
    super(`Part too large: ${byteLength} bytes (max ${maxBytes})`);
    this.name = 'PartTooLargeError';
  }
}

/**
 * Decode a MIME part body to a string.
 *
 * @param body - The raw transfer-encoded body text from the MIME tree.
 * @param encoding - Content-Transfer-Encoding value (e.g. 'base64', 'quoted-printable').
 * @param charset - Character set for decoding (e.g. 'utf-8', 'iso-8859-1').
 * @param maxBytes - Size cap; throws PartTooLargeError if exceeded (default 4 MB).
 */
export function decodePart(
  body: string,
  encoding: string | undefined,
  charset: string | undefined,
  maxBytes = 4_000_000,
): string {
  const enc = (encoding ?? '').toLowerCase().trim();

  if (enc === 'base64') {
    // Strip all whitespace (base64 lines may have CRLF)
    const stripped = body.replace(/\s+/g, '');

    // Size estimate before decoding: base64 is ~75% efficient
    if (stripped.length * 0.75 > maxBytes) {
      throw new PartTooLargeError(Math.ceil(stripped.length * 0.75), maxBytes);
    }

    let binStr: string;
    try {
      binStr = atob(stripped);
    } catch {
      // AIDEV-NOTE: If atob fails (malformed base64), return the raw body as a fallback.
      // This is safer than throwing to the UI — the user sees garbled text rather than an error page.
      return `[base64 decode error — raw content follows]\n${body}`;
    }

    const bytes = Uint8Array.from(binStr, (c) => c.charCodeAt(0));

    if (bytes.length > maxBytes) {
      throw new PartTooLargeError(bytes.length, maxBytes);
    }

    return decodeBytes(bytes, charset);
  }

  if (enc === 'quoted-printable') {
    // Input length check before decoding
    if (body.length > maxBytes) {
      throw new PartTooLargeError(body.length, maxBytes);
    }

    // AIDEV-NOTE: QP body decoding (NOT RFC2047 header decoding).
    // Soft line breaks: =\r\n or =\n → removed.
    // Hex-encoded bytes: =XX → byte value.
    // Literal underscore (_) → SPACE only applies to RFC2047 'Q' header encoding,
    //   NOT to body QP. So we do NOT replace _ here.
    const decoded = body
      .replace(/=\r?\n/g, '') // soft line breaks
      .replace(/=([0-9A-Fa-f]{2})/g, (_, hex: string) =>
        String.fromCharCode(parseInt(hex, 16)),
      );

    // Convert decoded string to bytes for charset decoding
    const bytes = Uint8Array.from(decoded, (c) => c.charCodeAt(0));

    if (bytes.length > maxBytes) {
      throw new PartTooLargeError(bytes.length, maxBytes);
    }

    return decodeBytes(bytes, charset);
  }

  // 7bit / 8bit / binary / unknown — return as-is
  if (body.length > maxBytes) {
    throw new PartTooLargeError(body.length, maxBytes);
  }
  return body;
}

/**
 * Decode a Uint8Array to a string using the given charset.
 * Falls back to UTF-8 on unknown charset labels.
 */
function decodeBytes(bytes: Uint8Array, charset: string | undefined): string {
  const label = charset || 'utf-8';
  try {
    return new TextDecoder(label, { fatal: false }).decode(bytes);
  } catch {
    // AIDEV-NOTE: Unknown charset label → fall back to utf-8 (non-fatal, best-effort).
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  }
}

/**
 * Recursively search the MIME tree for the first leaf part whose Content-Type
 * starts with `contentType` (case-insensitive prefix match).
 */
export function findPart(message: FullMessage, contentType: string): MIMEPart | null {
  // AIDEV-NOTE: The MIME tree has two entry points: message.MIME (parsed tree) and
  // message.Content (the top-level content, which may itself be a leaf part).
  // Check message.Content first (for simple non-multipart messages), then recurse MIME.
  const lowerTarget = contentType.toLowerCase();

  // Check the top-level Content part (it's a leaf when MIME is null or has no sub-parts)
  if (message.Content) {
    const ctHeaders = message.Content.Headers['Content-Type'];
    const ct = (ctHeaders?.[0] ?? '').toLowerCase();
    if (ct.startsWith(lowerTarget)) {
      return message.Content as MIMEPart;
    }
  }

  // Recurse into the MIME tree
  if (message.MIME) {
    const found = searchParts(message.MIME.Parts, lowerTarget);
    if (found) return found;
  }

  return null;
}

function searchParts(parts: MIMEPart[], lowerTarget: string): MIMEPart | null {
  for (const part of parts) {
    const ctHeaders = part.Headers['Content-Type'];
    const ct = (ctHeaders?.[0] ?? '').toLowerCase();
    if (ct.startsWith(lowerTarget)) {
      return part;
    }
    // Recurse into sub-parts
    if (part.MIME?.Parts) {
      const found = searchParts(part.MIME.Parts, lowerTarget);
      if (found) return found;
    }
  }
  return null;
}

/** Find and decode the text/html part. Throws PartTooLargeError if too large. */
export function getHtml(message: FullMessage): string {
  const part = findPart(message, 'text/html');
  if (!part) return '';
  const encoding = part.Headers['Content-Transfer-Encoding']?.[0];
  const ctHeader = part.Headers['Content-Type']?.[0] ?? '';
  const charset = extractCharset(ctHeader);
  return decodePart(part.Body, encoding, charset);
}

/** Find and decode the text/plain part. Throws PartTooLargeError if too large. */
export function getPlain(message: FullMessage): string {
  const part = findPart(message, 'text/plain');
  if (!part) return '';
  const encoding = part.Headers['Content-Transfer-Encoding']?.[0];
  const ctHeader = part.Headers['Content-Type']?.[0] ?? '';
  const charset = extractCharset(ctHeader);
  return decodePart(part.Body, encoding, charset);
}

/** Extract charset from a Content-Type header value (e.g. "text/plain; charset=utf-8"). */
function extractCharset(contentType: string): string | undefined {
  const match = /charset\s*=\s*["']?([^"';\s]+)/i.exec(contentType);
  return match?.[1];
}

// AIDEV-NOTE: SECURITY-CRITICAL: The CSP meta tag injected into every HTML email.
// - remote content (img, style, font, media) LOADS by default per product decision
// - script-src 'none' — scripts ALWAYS blocked
// - form-action 'none' — forms ALWAYS blocked (prevents phishing via form submission)
// - frame-src 'none' — iframes inside the email blocked
// - object-src 'none' — Flash/plugins blocked
// - base-uri 'none' — prevents <base href> injection (we also remove <base> elements)
const EMAIL_CSP =
  "default-src 'none'; " +
  "img-src 'self' data: blob: https: http:; " +
  "style-src 'unsafe-inline' 'self' https: http:; " +
  "font-src 'self' data: https: http:; " +
  "media-src 'self' https: http:; " +
  "script-src 'none'; " +
  "object-src 'none'; " +
  "frame-src 'none'; " +
  "form-action 'none'; " +
  "base-uri 'none'";

export interface SrcdocOptions {
  cidUrl: (id: string, cid: string) => string;
  proxyImages?: boolean;
  proxyUrl?: (url: string) => string;
}

/**
 * Sanitize an HTML email body for use in a sandboxed iframe srcdoc.
 *
 * Security operations:
 * 1. Remove all <script> elements
 * 2. Remove all <base> elements
 * 3. Rewrite cid: references to same-origin API URLs
 * 4. If opts.proxyImages, rewrite remaining http(s) image refs to the proxy
 * 5. Inject the CSP meta tag as first child of <head>
 * 6. Inject a <meta name="color-scheme" content="light"> so untrusted email always
 *    renders on a light canvas (like Gmail/Outlook/Apple Mail), independent of the app
 *    UI's dark/light theme. Colors the email declares itself still win.
 */
export function buildSrcdoc(
  html: string,
  msgId: string,
  opts: SrcdocOptions,
): string {
  // AIDEV-NOTE: DOMParser is available in browsers and jsdom (provided by the test env).
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');

  // --- Step 1: Remove all <script> elements ---
  doc.querySelectorAll('script').forEach((el) => el.remove());

  // --- Step 2: Remove all <base> elements ---
  doc.querySelectorAll('base').forEach((el) => el.remove());

  // --- Step 3: Rewrite cid: references ---
  rewriteCidRefs(doc, msgId, opts.cidUrl);

  // --- Step 4: Proxy remaining remote images (opt-in) ---
  // AIDEV-NOTE: runs AFTER cid rewriting, so cid refs (now /api/...) are not
  // re-touched. Only http(s) values are proxied; data:/blob: are left alone.
  if (opts.proxyImages && opts.proxyUrl) {
    rewriteRemoteImages(doc, opts.proxyUrl);
  }

  // --- Step 5: Inject CSP meta tag as first child of <head> ---
  const cspMeta = doc.createElement('meta');
  cspMeta.setAttribute('http-equiv', 'Content-Security-Policy');
  cspMeta.setAttribute('content', EMAIL_CSP);
  const head = doc.head;
  head.insertBefore(cspMeta, head.firstChild);

  // --- Step 6: Force a light canvas so untrusted email is always readable ---
  // AIDEV-NOTE: We ALWAYS render the HTML email on a light canvas, independent of the app
  // UI's dark/light theme — exactly like Gmail/Outlook/Apple Mail, which render mail on
  // white regardless of OS dark mode. Author CSS is written assuming a light client, so a
  // forced-dark color-scheme breaks partially-styled mail (e.g. an email that sets a light
  // background but no text color renders white-on-light = unreadable). A
  // <meta name="color-scheme"> (NOT a <style>) is used so it applies even though the
  // inherited app CSP blocks email <style>/inline styles; it only sets UA defaults, so any
  // colors the email declares itself still win. The value is a constant (never email data).
  const schemeMeta = doc.createElement('meta');
  schemeMeta.setAttribute('name', 'color-scheme');
  schemeMeta.setAttribute('content', 'light');
  cspMeta.after(schemeMeta);

  return `<!doctype html>${doc.documentElement.outerHTML}`;
}

/**
 * Rewrite remote http(s) image references to the same-origin proxy.
 * Mirrors rewriteCidRefs' surfaces: src/poster, srcset, inline style url().
 * Leaves cid-rewritten (/api/...), data:, blob:, and relative URLs untouched.
 */
function rewriteRemoteImages(doc: Document, proxyUrl: (url: string) => string): void {
  const isRemote = (v: string): boolean => /^https?:\/\//i.test(v.trim());

  for (const attr of ['src', 'poster']) {
    doc.querySelectorAll(`[${attr}]`).forEach((el) => {
      const val = el.getAttribute(attr) ?? '';
      if (isRemote(val)) el.setAttribute(attr, proxyUrl(val.trim()));
    });
  }

  doc.querySelectorAll('[srcset]').forEach((el) => {
    const srcset = el.getAttribute('srcset') ?? '';
    const rewritten = srcset
      .split(',')
      .map((entry) => {
        const parts = entry.trim().split(/\s+/);
        if (parts.length > 0 && isRemote(parts[0])) {
          parts[0] = proxyUrl(parts[0]);
        }
        return parts.join(' ');
      })
      .join(', ');
    if (rewritten !== srcset) el.setAttribute('srcset', rewritten);
  });

  doc.querySelectorAll('[style]').forEach((el) => {
    const style = el.getAttribute('style') ?? '';
    const rewritten = style.replace(
      /url\(\s*(['"]?)(https?:\/\/[^'")\s]+)\1\s*\)/gi,
      (_, _q: string, u: string) => `url(${proxyUrl(u)})`,
    );
    if (rewritten !== style) el.setAttribute('style', rewritten);
  });
}

/**
 * Rewrite cid: URL references in a parsed document to same-origin API URLs.
 * Handles: src, href, poster attributes; srcset attribute; inline style url(cid:...).
 */
function rewriteCidRefs(
  doc: Document,
  msgId: string,
  cidUrlFn: (id: string, cid: string) => string,
): void {
  // AIDEV-NOTE: Attributes that can hold a single URL value
  const urlAttrs = ['src', 'href', 'poster'];

  // Process single-URL attributes
  for (const attr of urlAttrs) {
    doc.querySelectorAll(`[${attr}]`).forEach((el) => {
      const val = el.getAttribute(attr) ?? '';
      const rewritten = rewriteCidUrl(val, msgId, cidUrlFn);
      if (rewritten !== val) {
        el.setAttribute(attr, rewritten);
      }
    });
  }

  // Process srcset (comma-separated list of "url [descriptor]" entries)
  doc.querySelectorAll('[srcset]').forEach((el) => {
    const srcset = el.getAttribute('srcset') ?? '';
    const rewritten = srcset
      .split(',')
      .map((entry) => {
        const parts = entry.trim().split(/\s+/);
        if (parts.length > 0) {
          parts[0] = rewriteCidUrl(parts[0], msgId, cidUrlFn);
        }
        return parts.join(' ');
      })
      .join(', ');
    if (rewritten !== srcset) {
      el.setAttribute('srcset', rewritten);
    }
  });

  // Process inline style attributes: url(cid:...)
  doc.querySelectorAll('[style]').forEach((el) => {
    const style = el.getAttribute('style') ?? '';
    const rewritten = style.replace(
      /url\(\s*(['"]?)cid:([^'")\s]+)\1\s*\)/gi,
      (_, _quote: string, cidValue: string) => {
        const resolved = resolveCid(cidValue, msgId, cidUrlFn);
        return `url(${resolved})`;
      },
    );
    if (rewritten !== style) {
      el.setAttribute('style', rewritten);
    }
  });
}

/**
 * Rewrite a single URL string if it has a cid: scheme (case-insensitive).
 * Returns the original string unchanged for non-cid URLs.
 */
function rewriteCidUrl(
  url: string,
  msgId: string,
  cidUrlFn: (id: string, cid: string) => string,
): string {
  const trimmed = url.trim();
  if (trimmed.toLowerCase().startsWith('cid:')) {
    const cidValue = trimmed.slice(4); // everything after "cid:"
    return resolveCid(cidValue, msgId, cidUrlFn);
  }
  return url;
}

/**
 * Resolve a raw cid value (may be URL-encoded, may have angle brackets) to a URL.
 */
function resolveCid(
  cidValue: string,
  msgId: string,
  cidUrlFn: (id: string, cid: string) => string,
): string {
  // Strip surrounding angle brackets < > if present
  let cid = cidValue.replace(/^<|>$/g, '');
  // URL-decode
  try {
    cid = decodeURIComponent(cid);
  } catch {
    // If decoding fails, use the raw value
  }
  return cidUrlFn(msgId, cid);
}

// AIDEV-NOTE: URL_PATTERN matches http/https/mailto links in plain text.
// javascript: and data: are intentionally excluded — they must NEVER be treated as links.
// The pattern is conservative (no parens, quotes, angle brackets at end) to avoid
// capturing surrounding punctuation.
const URL_PATTERN =
  /(?:https?:\/\/|mailto:)[^\s<>"'()[\]{}|\\^`]+[^\s<>"'()[\]{}|\\^`.,:;!?]/g;

export type LinkToken = { type: 'text'; value: string } | { type: 'link'; value: string; href: string };

/**
 * Tokenize plain text into text and link tokens.
 *
 * SECURITY: Only http://, https://, and mailto: are recognized as links.
 * javascript: and data: are NEVER treated as links.
 * The component renders text tokens as text nodes and link tokens as <a> elements —
 * NO {@html} is needed or used.
 *
 * @param text - Plain text to tokenize.
 * @returns Array of tokens (text or link).
 */
export function linkify(text: string): LinkToken[] {
  const tokens: LinkToken[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  // Reset lastIndex before use
  URL_PATTERN.lastIndex = 0;

  while ((match = URL_PATTERN.exec(text)) !== null) {
    const matchStart = match.index;
    const matchEnd = matchStart + match[0].length;

    // Text before the link
    if (matchStart > lastIndex) {
      tokens.push({ type: 'text', value: text.slice(lastIndex, matchStart) });
    }

    const href = match[0];

    // AIDEV-NOTE: Extra safety check — pattern should already exclude these,
    // but double-check to ensure javascript: and data: are never emitted as links.
    if (href.toLowerCase().startsWith('javascript:') || href.toLowerCase().startsWith('data:')) {
      tokens.push({ type: 'text', value: href });
    } else {
      tokens.push({ type: 'link', value: href, href });
    }

    lastIndex = matchEnd;
  }

  // Remaining text after last link
  if (lastIndex < text.length) {
    tokens.push({ type: 'text', value: text.slice(lastIndex) });
  }

  return tokens;
}
