// AIDEV-NOTE: jsdom does not implement PointerEvent (it has MouseEvent but not the
// PointerEvent subclass). We install a minimal polyfill so fireEvent.pointerDown/Move
// can build real PointerEvents that carry clientX. Without this, @testing-library falls
// back to window.Event which silently drops clientX.
import { beforeAll } from 'vitest';
beforeAll(() => {
  if (typeof globalThis.PointerEvent === 'undefined') {
    class PointerEvent extends MouseEvent {
      pointerId: number;
      constructor(type: string, init: PointerEventInit = {}) {
        super(type, init);
        this.pointerId = init.pointerId ?? 0;
      }
    }
    // @ts-expect-error polyfill for jsdom
    globalThis.PointerEvent = PointerEvent;
  }
});

import { render, screen, fireEvent } from '@testing-library/svelte';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Splitter from './Splitter.svelte';

let onDrag: ReturnType<typeof vi.fn>;
let onNudge: ReturnType<typeof vi.fn>;

beforeEach(() => {
  onDrag = vi.fn();
  onNudge = vi.fn();
});

function renderSplitter() {
  return render(Splitter, { props: { onDrag, onNudge, ariaValueNow: 400, ariaValueMin: 320, ariaValueMax: 600 } });
}

describe('Splitter', () => {
  it('renders an accessible vertical separator', () => {
    renderSplitter();
    const el = screen.getByTestId('splitter');
    expect(el.getAttribute('role')).toBe('separator');
    expect(el.getAttribute('aria-orientation')).toBe('vertical');
    expect(el.getAttribute('tabindex')).toBe('0');
    expect(el.getAttribute('aria-valuenow')).toBe('400');
  });

  it('ArrowLeft/ArrowRight nudge by ∓16', async () => {
    renderSplitter();
    const el = screen.getByTestId('splitter');
    await fireEvent.keyDown(el, { key: 'ArrowLeft' });
    expect(onNudge).toHaveBeenCalledWith(-16);
    await fireEvent.keyDown(el, { key: 'ArrowRight' });
    expect(onNudge).toHaveBeenCalledWith(16);
  });

  it('Home/End nudge to the extremes', async () => {
    renderSplitter();
    const el = screen.getByTestId('splitter');
    await fireEvent.keyDown(el, { key: 'Home' });
    expect(onNudge).toHaveBeenCalledWith(-1e7);
    await fireEvent.keyDown(el, { key: 'End' });
    expect(onNudge).toHaveBeenCalledWith(1e7);
  });

  it('drags: pointermove after pointerdown reports clientX', async () => {
    renderSplitter();
    const el = screen.getByTestId('splitter');
    await fireEvent.pointerDown(el, { pointerId: 1, clientX: 400 });
    await fireEvent.pointerMove(el, { clientX: 520 });
    expect(onDrag).toHaveBeenCalledWith(520);
  });

  it('does not report drag before pointerdown', async () => {
    renderSplitter();
    const el = screen.getByTestId('splitter');
    await fireEvent.pointerMove(el, { clientX: 520 });
    expect(onDrag).not.toHaveBeenCalled();
  });
});
