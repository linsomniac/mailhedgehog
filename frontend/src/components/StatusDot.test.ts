// AIDEV-NOTE: StatusDot tests verify that the correct color indicator and accessible label
// are rendered for each WebSocket connection status.

import { render, screen } from '@testing-library/svelte';
import { describe, it, expect } from 'vitest';
import StatusDot from './StatusDot.svelte';

describe('StatusDot', () => {
  it('renders green indicator for "connected" status', () => {
    render(StatusDot, { props: { status: 'connected' } });

    const dot = screen.getByTestId('status-dot-indicator');
    expect(dot.className).toContain('bg-green-500');
    expect(dot.getAttribute('data-status')).toBe('connected');
  });

  it('renders amber indicator for "reconnecting" status', () => {
    render(StatusDot, { props: { status: 'reconnecting' } });

    const dot = screen.getByTestId('status-dot-indicator');
    expect(dot.className).toContain('bg-amber-400');
    expect(dot.getAttribute('data-status')).toBe('reconnecting');
  });

  it('renders red indicator for "offline" status', () => {
    render(StatusDot, { props: { status: 'offline' } });

    const dot = screen.getByTestId('status-dot-indicator');
    expect(dot.className).toContain('bg-red-500');
    expect(dot.getAttribute('data-status')).toBe('offline');
  });

  it('has an accessible aria-label for "connected"', () => {
    render(StatusDot, { props: { status: 'connected' } });

    const container = screen.getByTestId('status-dot');
    expect(container.getAttribute('aria-label')).toContain('Connected');
  });

  it('has an accessible aria-label for "reconnecting"', () => {
    render(StatusDot, { props: { status: 'reconnecting' } });

    const container = screen.getByTestId('status-dot');
    expect(container.getAttribute('aria-label')).toContain('Reconnecting');
  });

  it('has an accessible aria-label for "offline"', () => {
    render(StatusDot, { props: { status: 'offline' } });

    const container = screen.getByTestId('status-dot');
    expect(container.getAttribute('aria-label')).toContain('Offline');
  });
});
