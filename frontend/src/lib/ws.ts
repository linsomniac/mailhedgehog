// AIDEV-NOTE: Reconnecting WebSocket client for the mailhedgehog live-message stream.
// Connects to /api/v2/websocket?summary=1 and emits one Summary per frame.
//
// Backoff strategy: capped exponential with jitter.
//   delay = min(base * 2^attempt, cap) + jitter(0..1) * base
// The delay resets ONLY when a connection successfully opens.
// A single in-flight reconnect timer is kept; scheduling a second one cancels the first.
// Calling close() sets an intentional-close flag that suppresses all reconnects.
//
// Testability seams:
//   - Injectable WebSocket constructor (default globalThis.WebSocket)
//   - Injectable RNG (default Math.random) so tests can control jitter
//   - Uses globalThis.setTimeout/clearTimeout, controlled by vitest fake timers

import type { Summary } from './types.js';

export type Status = 'connected' | 'reconnecting' | 'offline';

export interface ConnectOpts {
  onMessage: (summary: Summary) => void;
  onStatus: (status: Status) => void;
  /** Called on every successful open so the caller can resync state. */
  onOpen: () => void;
  /** Injectable WebSocket constructor; defaults to globalThis.WebSocket. */
  WebSocketImpl?: typeof WebSocket;
  /** Injectable RNG; defaults to Math.random. Receives current attempt count. */
  rng?: () => number;
}

export interface Connection {
  close(): void;
}

const BASE_MS = 1000;
const CAP_MS = 30_000;

export function connect(opts: ConnectOpts): Connection {
  const WS = opts.WebSocketImpl ?? globalThis.WebSocket;
  const rng = opts.rng ?? Math.random;

  let closed = false;
  let attempt = 0;
  let timerId: ReturnType<typeof setTimeout> | null = null;
  let ws: WebSocket | null = null;

  function computeDelay(): number {
    // Exponential component, capped.
    const exp = Math.min(BASE_MS * Math.pow(2, attempt), CAP_MS);
    // Jitter: 0..BASE_MS so it's bounded and testable.
    const jitter = rng() * BASE_MS;
    return exp + jitter;
  }

  function scheduleReconnect(): void {
    // Cancel any existing pending reconnect before scheduling a new one.
    if (timerId !== null) {
      clearTimeout(timerId);
      timerId = null;
    }
    if (closed) return;

    const delay = computeDelay();
    attempt += 1;
    opts.onStatus('reconnecting');

    timerId = setTimeout(() => {
      timerId = null;
      if (!closed) {
        openSocket();
      }
    }, delay);
  }

  function buildWsUrl(): string {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${location.host}/api/v2/websocket?summary=1`;
  }

  function openSocket(): void {
    if (closed) return;

    ws = new WS(buildWsUrl());

    ws.addEventListener('open', () => {
      if (closed) {
        ws?.close();
        return;
      }
      // Reset backoff on confirmed open.
      attempt = 0;
      opts.onStatus('connected');
      opts.onOpen();
    });

    ws.addEventListener('message', (ev: MessageEvent) => {
      if (closed) return;
      try {
        const summary = JSON.parse(ev.data as string) as Summary;
        opts.onMessage(summary);
      } catch {
        // Malformed frame — ignore.
      }
    });

    ws.addEventListener('close', () => {
      ws = null;
      if (!closed) {
        scheduleReconnect();
      }
    });

    ws.addEventListener('error', () => {
      // The 'close' event always follows an error, so reconnect logic lives there.
      // Emit offline status immediately on error so the UI can react quickly.
      if (!closed) {
        opts.onStatus('offline');
      }
    });
  }

  // Start the initial connection.
  openSocket();

  return {
    close(): void {
      closed = true;
      if (timerId !== null) {
        clearTimeout(timerId);
        timerId = null;
      }
      if (ws !== null) {
        ws.close();
        ws = null;
      }
    },
  };
}
