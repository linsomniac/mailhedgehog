import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { listMessages, searchMessages, getMessage, deleteAll, deleteMessage, emlUrl, partUrl, cidUrl } from './api.js';

// AIDEV-NOTE: Tests for the typed API client.
// We mock globalThis.fetch to intercept outgoing requests and assert URL shape + method.

function makeFetchMock(status: number, body: unknown) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    json: () => Promise.resolve(body),
  });
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('searchMessages', () => {
  it('percent-encodes special chars in query params', async () => {
    const mockFetch = makeFetchMock(200, { total: 0, count: 0, start: 0, items: [] });
    vi.stubGlobal('fetch', mockFetch);

    await searchMessages('containing', 'hello & world # test+value', 0, 25);

    expect(mockFetch).toHaveBeenCalledOnce();
    const url: string = mockFetch.mock.calls[0][0] as string;

    // URLSearchParams encodes & as %26, # as %23, + as %2B, space as +
    expect(url).toContain('hello+%26+world+%23+test%2Bvalue');
    expect(url).toContain('summary=1');
    expect(url).toContain('kind=containing');
    expect(url).toContain('start=0');
    expect(url).toContain('limit=25');
    expect(url.startsWith('/api/v2/search?')).toBe(true);
  });

  it('preserves kind and query ordering in URL', async () => {
    const mockFetch = makeFetchMock(200, { total: 0, count: 0, start: 0, items: [] });
    vi.stubGlobal('fetch', mockFetch);

    await searchMessages('from', 'test@example.com', 10, 50);

    const url: string = mockFetch.mock.calls[0][0] as string;
    expect(url).toContain('kind=from');
    expect(url).toContain('query=test%40example.com');
    expect(url).toContain('start=10');
    expect(url).toContain('limit=50');
  });
});

describe('listMessages', () => {
  it('calls the correct endpoint with params', async () => {
    const mockFetch = makeFetchMock(200, { total: 5, count: 5, start: 0, items: [] });
    vi.stubGlobal('fetch', mockFetch);

    const result = await listMessages(0, 10);

    const url: string = mockFetch.mock.calls[0][0] as string;
    expect(url.startsWith('/api/v2/messages?')).toBe(true);
    expect(url).toContain('summary=1');
    expect(url).toContain('start=0');
    expect(url).toContain('limit=10');
    expect(result.total).toBe(5);
  });
});

describe('getMessage', () => {
  it('percent-encodes the id in the path', async () => {
    const mockFetch = makeFetchMock(200, { ID: 'abc/123', From: {}, To: [], Content: {}, Created: '', Size: 0, Raw: {} });
    vi.stubGlobal('fetch', mockFetch);

    await getMessage('abc/123');

    const url: string = mockFetch.mock.calls[0][0] as string;
    expect(url).toBe('/api/v1/messages/abc%2F123');
  });
});

describe('deleteAll', () => {
  it('sends DELETE to /api/v1/messages', async () => {
    const mockFetch = makeFetchMock(200, null);
    vi.stubGlobal('fetch', mockFetch);

    await deleteAll();

    expect(mockFetch).toHaveBeenCalledWith('/api/v1/messages', { method: 'DELETE' });
  });
});

describe('deleteMessage', () => {
  it('sends DELETE to correct URL with encoded id', async () => {
    const mockFetch = makeFetchMock(200, null);
    vi.stubGlobal('fetch', mockFetch);

    await deleteMessage('msg id/1');

    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/v1/messages/msg%20id%2F1');
    expect(init.method).toBe('DELETE');
  });
});

describe('URL builders', () => {
  it('emlUrl encodes the id', () => {
    expect(emlUrl('a/b c')).toBe('/api/v1/messages/a%2Fb%20c/download');
  });

  it('partUrl encodes the id and includes part index', () => {
    expect(partUrl('a/b', 3)).toBe('/api/v1/messages/a%2Fb/mime/part/3/download');
  });

  it('cidUrl encodes both id and cid', () => {
    expect(cidUrl('id/1', 'cid@foo')).toBe('/api/v1/messages/id%2F1/mime/cid/cid%40foo/download');
  });
});

describe('non-2xx handling', () => {
  it('throws an Error with the HTTP status on 404', async () => {
    const mockFetch = makeFetchMock(404, null);
    vi.stubGlobal('fetch', mockFetch);

    await expect(getMessage('missing')).rejects.toThrow('HTTP 404');
  });

  it('throws an Error with the HTTP status on 500', async () => {
    const mockFetch = makeFetchMock(500, null);
    vi.stubGlobal('fetch', mockFetch);

    await expect(listMessages(0, 10)).rejects.toThrow('HTTP 500');
  });
});
