// AIDEV-NOTE: Typed HTTP client for the mailhedgehog backend REST API.
// All query params are encoded via URLSearchParams; path segments use encodeURIComponent.
// Throws an Error with the HTTP status text on non-2xx responses.
// URL builders return plain strings (no fetch side-effects) so they can be used in <a href>.
//
// Two fetch helpers:
//   request<T>  — for JSON-returning endpoints (GET); calls res.json().
//   requestVoid — for DELETE endpoints that return plain-text "OK"; never calls res.json().

import type { FullMessage, Page, Summary } from './types.js';

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText}`);
  }
  return res.json() as Promise<T>;
}

// AIDEV-NOTE: Use requestVoid for DELETE calls whose backend returns plain-text "OK" (not JSON).
// Calling res.json() on a plain-text body throws SyntaxError in real browsers.
async function requestVoid(url: string, init?: RequestInit): Promise<void> {
  const res = await fetch(url, init);
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText}`);
  }
  // Intentionally do NOT read or parse the body — backend returns plain-text "OK".
}

/** Fetch a paginated list of message summaries. */
export function listMessages(start: number, limit: number): Promise<Page<Summary>> {
  const params = new URLSearchParams({
    summary: '1',
    start: String(start),
    limit: String(limit),
  });
  return request<Page<Summary>>(`/api/v2/messages?${params.toString()}`);
}

/**
 * Search messages.
 * @param kind - One of: from, to, containing, subject, metadata
 */
export function searchMessages(
  kind: string,
  query: string,
  start: number,
  limit: number,
): Promise<Page<Summary>> {
  const params = new URLSearchParams({
    summary: '1',
    kind,
    query,
    start: String(start),
    limit: String(limit),
  });
  return request<Page<Summary>>(`/api/v2/search?${params.toString()}`);
}

/** Fetch a full message by ID. */
export function getMessage(id: string): Promise<FullMessage> {
  return request<FullMessage>(`/api/v1/messages/${encodeURIComponent(id)}`);
}

/** Delete ALL stored messages. */
export function deleteAll(): Promise<void> {
  return requestVoid('/api/v1/messages', { method: 'DELETE' });
}

/** Delete a single message by ID. */
export function deleteMessage(id: string): Promise<void> {
  return requestVoid(`/api/v1/messages/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

// --- URL builders (no fetch) ---

/** URL to download the raw .eml file for a message. */
export function emlUrl(id: string): string {
  return `/api/v1/messages/${encodeURIComponent(id)}/download`;
}

/** URL to download a MIME part by index. */
export function partUrl(id: string, n: number): string {
  return `/api/v1/messages/${encodeURIComponent(id)}/mime/part/${n}/download`;
}

/** URL to download a MIME part by Content-ID. */
export function cidUrl(id: string, cid: string): string {
  return `/api/v1/messages/${encodeURIComponent(id)}/mime/cid/${encodeURIComponent(cid)}/download`;
}
