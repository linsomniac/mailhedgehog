// AIDEV-NOTE: Unit tests for time.ts utility functions.
// relativeTime uses Intl.RelativeTimeFormat; tests mock Date.now() for determinism.
// formatSize uses Intl.NumberFormat with en-US-like output (locale-independent thresholds).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { relativeTime, formatSize } from './time.js';

describe('relativeTime', () => {
  const BASE_TIME = new Date('2025-06-01T12:00:00.000Z').getTime();

  beforeEach(() => {
    vi.spyOn(Date, 'now').mockReturnValue(BASE_TIME);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function isoAgo(ms: number): string {
    return new Date(BASE_TIME - ms).toISOString();
  }

  it('returns "just now" for very recent messages (< 45s)', () => {
    expect(relativeTime(isoAgo(5_000))).toBe('just now');
    expect(relativeTime(isoAgo(44_000))).toBe('just now');
  });

  it('returns a relative minutes string for 1–44 minutes ago', () => {
    // 5 minutes ago
    const result = relativeTime(isoAgo(5 * 60 * 1000));
    expect(result).toMatch(/minute/);
  });

  it('returns a relative hours string for 1–21 hours ago', () => {
    const result = relativeTime(isoAgo(3 * 60 * 60 * 1000));
    expect(result).toMatch(/hour/);
  });

  it('returns a relative days string for 1–29 days ago', () => {
    const result = relativeTime(isoAgo(7 * 24 * 60 * 60 * 1000));
    expect(result).toMatch(/day/);
  });

  it('falls back to toLocaleDateString for messages older than 30 days', () => {
    const thirtyOneDaysAgo = isoAgo(31 * 24 * 60 * 60 * 1000);
    const result = relativeTime(thirtyOneDaysAgo);
    // Should NOT contain "day" from Intl.RelativeTimeFormat
    expect(result).not.toMatch(/\d+ days? ago/i);
    // Should look like a date (contains digits)
    expect(result).toMatch(/\d/);
  });

  it('handles a timestamp in the future gracefully (near-zero diff)', () => {
    // A future timestamp (e.g. clock skew) should not throw
    const future = new Date(BASE_TIME + 1000).toISOString();
    expect(() => relativeTime(future)).not.toThrow();
  });
});

describe('formatSize', () => {
  it('formats 0 bytes as "0 B"', () => {
    expect(formatSize(0)).toBe('0 B');
  });

  it('formats small byte values without decimal', () => {
    expect(formatSize(512)).toBe('512 B');
    expect(formatSize(1023)).toBe('1,023 B');
  });

  it('formats exactly 1024 bytes as "1.0 KB"', () => {
    expect(formatSize(1024)).toBe('1.0 KB');
  });

  it('formats 2048 bytes as "2.0 KB"', () => {
    expect(formatSize(2048)).toBe('2.0 KB');
  });

  it('formats values just under 1 MB as KB', () => {
    const result = formatSize(1024 * 1024 - 1);
    expect(result).toMatch(/KB$/);
  });

  it('formats exactly 1 MB as "1.0 MB"', () => {
    expect(formatSize(1024 * 1024)).toBe('1.0 MB');
  });

  it('formats 1.5 MB correctly', () => {
    expect(formatSize(Math.round(1.5 * 1024 * 1024))).toBe('1.5 MB');
  });
});
