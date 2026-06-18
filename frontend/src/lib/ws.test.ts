import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { connect } from './ws.js';
import type { ConnectOpts, Status } from './ws.js';

// AIDEV-NOTE: Tests for the reconnecting WebSocket client using fake timers and a mock WS.
// We use vitest fake timers to control setTimeout/clearTimeout deterministically.
// The injectable WebSocket constructor and rng seam make backoff assertions exact.

// Minimal mock WebSocket that tracks state and lets tests fire events manually.
class MockWebSocket {
  static instances: MockWebSocket[] = [];

  url: string;
  readyState: number = 0; // CONNECTING
  private listeners: Map<string, ((ev: Event | MessageEvent | CloseEvent) => void)[]> = new Map();

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }

  addEventListener(type: string, handler: (ev: Event | MessageEvent | CloseEvent) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(handler);
    this.listeners.set(type, list);
  }

  removeEventListener(): void {}

  close(): void {
    this.readyState = 3; // CLOSED
    this.fireEvent('close', new CloseEvent('close'));
  }

  // Helpers to simulate server events in tests.
  fireOpen(): void {
    this.readyState = 1; // OPEN
    this.fireEvent('open', new Event('open'));
  }

  fireMessage(data: string): void {
    const ev = new MessageEvent('message', { data });
    this.fireEvent('message', ev);
  }

  fireError(): void {
    this.fireEvent('error', new Event('error'));
  }

  fireClose(): void {
    this.readyState = 3;
    this.fireEvent('close', new CloseEvent('close'));
  }

  private fireEvent(type: string, ev: Event | MessageEvent | CloseEvent): void {
    (this.listeners.get(type) ?? []).forEach(h => h(ev));
  }
}

function makeOpts(overrides: Partial<ConnectOpts> = {}): ConnectOpts & {
  statuses: Status[];
  messages: unknown[];
  opens: number;
} {
  const statuses: Status[] = [];
  const messages: unknown[] = [];
  let opens = 0;
  return {
    onMessage: (s) => messages.push(s),
    onStatus: (s) => statuses.push(s),
    onOpen: () => { opens++; },
    WebSocketImpl: MockWebSocket as unknown as typeof WebSocket,
    rng: () => 0, // deterministic: jitter = 0
    ...overrides,
    get statuses() { return statuses; },
    get messages() { return messages; },
    get opens() { return opens; },
  };
}

beforeEach(() => {
  MockWebSocket.instances = [];
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('connect() — initial connection', () => {
  it('creates a WebSocket immediately', () => {
    const opts = makeOpts();
    connect(opts);
    expect(MockWebSocket.instances).toHaveLength(1);
    expect(MockWebSocket.instances[0].url).toContain('/api/v2/websocket?summary=1');
  });

  it('emits connected status and calls onOpen on open', () => {
    const opts = makeOpts();
    connect(opts);

    MockWebSocket.instances[0].fireOpen();

    expect(opts.statuses).toContain('connected');
    expect(opts.opens).toBe(1);
  });

  it('dispatches onMessage for valid JSON frames', () => {
    const opts = makeOpts();
    connect(opts);
    MockWebSocket.instances[0].fireOpen();

    const summary = { ID: '1', From: {}, To: [], Subject: 'Hi', Created: '', Size: 100 };
    MockWebSocket.instances[0].fireMessage(JSON.stringify(summary));

    expect(opts.messages).toHaveLength(1);
    expect((opts.messages[0] as { ID: string }).ID).toBe('1');
  });
});

describe('reconnect backoff', () => {
  it('backoff delay grows base→cap with ×2 (rng=0, no jitter)', () => {
    const opts = makeOpts({ rng: () => 0 });
    connect(opts);

    // Attempt 0: delay = min(1000 * 2^0, 30000) + 0 = 1000ms
    MockWebSocket.instances[0].fireClose();
    expect(opts.statuses).toContain('reconnecting');

    // advance 999ms → should NOT reconnect yet
    vi.advanceTimersByTime(999);
    expect(MockWebSocket.instances).toHaveLength(1);

    // advance 1ms → reconnects
    vi.advanceTimersByTime(1);
    expect(MockWebSocket.instances).toHaveLength(2);

    // Attempt 1: delay = min(1000 * 2^1, 30000) = 2000ms
    MockWebSocket.instances[1].fireClose();
    vi.advanceTimersByTime(1999);
    expect(MockWebSocket.instances).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(MockWebSocket.instances).toHaveLength(3);

    // Attempt 2: 4000ms
    MockWebSocket.instances[2].fireClose();
    vi.advanceTimersByTime(3999);
    expect(MockWebSocket.instances).toHaveLength(3);
    vi.advanceTimersByTime(1);
    expect(MockWebSocket.instances).toHaveLength(4);
  });

  it('backoff is capped at 30000ms', () => {
    const opts = makeOpts({ rng: () => 0 });
    connect(opts);

    // Force through enough attempts to exceed cap: 2^n * 1000 > 30000 at n=5 (32000)
    for (let i = 0; i < 5; i++) {
      const ws = MockWebSocket.instances[MockWebSocket.instances.length - 1];
      ws.fireClose();
      vi.advanceTimersByTime(60_000); // jump past any possible delay
    }

    const countBefore = MockWebSocket.instances.length;

    // Next close should schedule at exactly 30000ms (cap), rng=0
    MockWebSocket.instances[MockWebSocket.instances.length - 1].fireClose();
    vi.advanceTimersByTime(29_999);
    expect(MockWebSocket.instances).toHaveLength(countBefore);
    vi.advanceTimersByTime(1);
    expect(MockWebSocket.instances).toHaveLength(countBefore + 1);
  });

  it('jitter stays within 0..BASE_MS bounds', () => {
    // rng returns 0.5 → jitter = 0.5 * 1000 = 500ms; total = 1000 + 500 = 1500ms
    const opts = makeOpts({ rng: () => 0.5 });
    connect(opts);

    MockWebSocket.instances[0].fireClose();

    // 1499ms → not yet
    vi.advanceTimersByTime(1499);
    expect(MockWebSocket.instances).toHaveLength(1);

    // 1ms more → reconnects
    vi.advanceTimersByTime(1);
    expect(MockWebSocket.instances).toHaveLength(2);
  });

  it('resets attempt to 0 after a confirmed open', () => {
    const opts = makeOpts({ rng: () => 0 });
    connect(opts);

    // 2 failed attempts → attempt=2 → next delay would be 4000ms
    MockWebSocket.instances[0].fireClose();
    vi.advanceTimersByTime(1000);
    MockWebSocket.instances[1].fireClose();
    vi.advanceTimersByTime(2000);

    // Now open successfully
    MockWebSocket.instances[2].fireOpen();

    // Close → attempt should be 0 → delay = 1000ms again
    MockWebSocket.instances[2].fireClose();
    vi.advanceTimersByTime(999);
    expect(MockWebSocket.instances).toHaveLength(3);
    vi.advanceTimersByTime(1);
    expect(MockWebSocket.instances).toHaveLength(4);
  });

  it('schedules only one reconnect timer at a time (error + close)', () => {
    const opts = makeOpts({ rng: () => 0 });
    connect(opts);

    // Fire error then close; only ONE reconnect should be pending.
    MockWebSocket.instances[0].fireError();
    MockWebSocket.instances[0].fireClose();

    // At 1000ms exactly, exactly one new socket should exist.
    vi.advanceTimersByTime(1000);
    expect(MockWebSocket.instances).toHaveLength(2);
  });
});

describe('close()', () => {
  it('suppresses reconnect after intentional close', () => {
    const opts = makeOpts({ rng: () => 0 });
    const conn = connect(opts);

    conn.close();

    // Advance well past any backoff — no new socket should appear.
    vi.advanceTimersByTime(60_000);
    expect(MockWebSocket.instances).toHaveLength(1);
  });

  it('suppresses reconnect even if close() called after a drop', () => {
    const opts = makeOpts({ rng: () => 0 });
    const conn = connect(opts);

    MockWebSocket.instances[0].fireOpen();
    MockWebSocket.instances[0].fireClose(); // triggers scheduleReconnect
    conn.close();                           // should cancel the timer

    vi.advanceTimersByTime(60_000);
    expect(MockWebSocket.instances).toHaveLength(1);
  });

  it('cancels an already-pending reconnect timer', () => {
    const opts = makeOpts({ rng: () => 0 });
    const conn = connect(opts);

    MockWebSocket.instances[0].fireClose(); // schedules reconnect at 1000ms
    conn.close();

    vi.advanceTimersByTime(1000);
    expect(MockWebSocket.instances).toHaveLength(1); // no new socket
  });
});

describe('onStatus transitions', () => {
  it('emits connected when socket opens', () => {
    const opts = makeOpts();
    connect(opts);
    MockWebSocket.instances[0].fireOpen();
    expect(opts.statuses).toEqual(['connected']);
  });

  it('emits reconnecting on close', () => {
    const opts = makeOpts({ rng: () => 0 });
    connect(opts);
    MockWebSocket.instances[0].fireOpen();
    MockWebSocket.instances[0].fireClose();
    expect(opts.statuses).toContain('reconnecting');
  });

  it('emits offline on error', () => {
    const opts = makeOpts({ rng: () => 0 });
    connect(opts);
    MockWebSocket.instances[0].fireError();
    expect(opts.statuses).toContain('offline');
  });

  it('emits connected again after successful reconnect', () => {
    const opts = makeOpts({ rng: () => 0 });
    connect(opts);

    MockWebSocket.instances[0].fireClose();
    vi.advanceTimersByTime(1000);
    MockWebSocket.instances[1].fireOpen();

    expect(opts.statuses.filter(s => s === 'connected')).toHaveLength(1);
  });
});

describe('onOpen called on every open', () => {
  it('calls onOpen on initial open and on reconnect open', () => {
    const opts = makeOpts({ rng: () => 0 });
    connect(opts);

    MockWebSocket.instances[0].fireOpen();
    expect(opts.opens).toBe(1);

    MockWebSocket.instances[0].fireClose();
    vi.advanceTimersByTime(1000);
    MockWebSocket.instances[1].fireOpen();
    expect(opts.opens).toBe(2);
  });
});
