// AIDEV-NOTE: SearchBar tests verify the critical behavioral contract:
// - Body kind (containing): fires search ONLY on Enter, NOT on keystroke
// - Other kinds (metadata/subject/from/to): debounce 250ms then call setSearch
// - Empty query → clearSearch regardless of kind
// - Field selector maps labels → correct kind values
// Uses fake timers to control debounce without real waiting.
//
// AIDEV-NOTE: vi.mock factory is hoisted to the top of the file by vitest.
// The factory CANNOT reference variables declared in module scope (TDZ error).
// We import the mocked store module AFTER mocking so we get the vi.fn() refs.

import { render, screen, fireEvent } from '@testing-library/svelte';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../lib/store.svelte.js', () => ({
  store: {
    setSearch: vi.fn(),
    clearSearch: vi.fn(),
  },
}));

vi.mock('../lib/api.js', () => ({
  listMessages: vi.fn(),
  searchMessages: vi.fn(),
  getMessage: vi.fn(),
  deleteAll: vi.fn(),
  deleteMessage: vi.fn(),
}));

// Import after mocking so we get the vi.fn() instances
import { store } from '../lib/store.svelte.js';
import SearchBar from './SearchBar.svelte';

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
});

function getInput(): HTMLInputElement {
  return screen.getByTestId('search-input') as HTMLInputElement;
}

function getKindSelect(): HTMLSelectElement {
  return screen.getByTestId('search-kind') as HTMLSelectElement;
}

describe('SearchBar — Body kind (Enter-to-search only)', () => {
  it('does NOT call setSearch on input keystrokes for Body kind', async () => {
    render(SearchBar);

    // Switch to Body (may call clearSearch on field switch with empty query — that's fine)
    const select = getKindSelect();
    await fireEvent.change(select, { target: { value: 'containing' } });
    vi.clearAllMocks(); // reset counters after field switch side-effects

    const input = getInput();
    await fireEvent.input(input, { target: { value: 'hello' } });

    // Advance timers past debounce — setSearch must NOT fire for Body
    vi.advanceTimersByTime(500);

    expect(store.setSearch).not.toHaveBeenCalled();
    // clearSearch must not be called for a non-empty query on keystroke
    expect(store.clearSearch).not.toHaveBeenCalled();
  });

  it('calls setSearch on Enter for Body kind', async () => {
    render(SearchBar);

    const select = getKindSelect();
    await fireEvent.change(select, { target: { value: 'containing' } });

    const input = getInput();
    await fireEvent.input(input, { target: { value: 'hello world' } });

    await fireEvent.keyDown(input, { key: 'Enter' });

    expect(store.setSearch).toHaveBeenCalledWith('containing', 'hello world');
  });

  it('calls clearSearch on Enter with empty query for Body kind', async () => {
    render(SearchBar);

    const select = getKindSelect();
    await fireEvent.change(select, { target: { value: 'containing' } });

    const input = getInput();
    await fireEvent.input(input, { target: { value: '' } });
    await fireEvent.keyDown(input, { key: 'Enter' });

    expect(store.clearSearch).toHaveBeenCalled();
    expect(store.setSearch).not.toHaveBeenCalled();
  });
});

describe('SearchBar — Debounced kinds (metadata/subject/from/to)', () => {
  it('does NOT call setSearch immediately on input', async () => {
    render(SearchBar);

    const input = getInput();
    await fireEvent.input(input, { target: { value: 'test' } });

    // Before debounce fires
    vi.advanceTimersByTime(100);
    expect(store.setSearch).not.toHaveBeenCalled();
  });

  it('calls setSearch after 250ms debounce for metadata kind', async () => {
    render(SearchBar);

    const input = getInput();
    await fireEvent.input(input, { target: { value: 'foo' } });

    vi.advanceTimersByTime(250);

    expect(store.setSearch).toHaveBeenCalledWith('metadata', 'foo');
  });

  it('calls setSearch with "subject" kind when Subject is selected', async () => {
    render(SearchBar);

    const select = getKindSelect();
    await fireEvent.change(select, { target: { value: 'subject' } });

    const input = getInput();
    await fireEvent.input(input, { target: { value: 'hello' } });

    vi.advanceTimersByTime(250);

    expect(store.setSearch).toHaveBeenCalledWith('subject', 'hello');
  });

  it('calls setSearch with "from" kind when From is selected', async () => {
    render(SearchBar);

    const select = getKindSelect();
    await fireEvent.change(select, { target: { value: 'from' } });

    const input = getInput();
    await fireEvent.input(input, { target: { value: 'alice' } });

    vi.advanceTimersByTime(250);

    expect(store.setSearch).toHaveBeenCalledWith('from', 'alice');
  });

  it('calls setSearch with "to" kind when To is selected', async () => {
    render(SearchBar);

    const select = getKindSelect();
    await fireEvent.change(select, { target: { value: 'to' } });

    const input = getInput();
    await fireEvent.input(input, { target: { value: 'bob' } });

    vi.advanceTimersByTime(250);

    expect(store.setSearch).toHaveBeenCalledWith('to', 'bob');
  });

  it('debounces multiple keystrokes: only fires once after 250ms idle', async () => {
    render(SearchBar);

    const input = getInput();

    await fireEvent.input(input, { target: { value: 'a' } });
    vi.advanceTimersByTime(100);
    await fireEvent.input(input, { target: { value: 'ab' } });
    vi.advanceTimersByTime(100);
    await fireEvent.input(input, { target: { value: 'abc' } });

    // Only the final debounce fires
    vi.advanceTimersByTime(250);

    expect(store.setSearch).toHaveBeenCalledTimes(1);
    expect(store.setSearch).toHaveBeenCalledWith('metadata', 'abc');
  });

  it('calls clearSearch when input is emptied', async () => {
    render(SearchBar);

    const input = getInput();

    // First search
    await fireEvent.input(input, { target: { value: 'test' } });
    vi.advanceTimersByTime(250);
    expect(store.setSearch).toHaveBeenCalledTimes(1);

    // Clear input
    await fireEvent.input(input, { target: { value: '' } });

    expect(store.clearSearch).toHaveBeenCalled();
  });

  it('also calls setSearch on Enter for non-body kinds (for UX)', async () => {
    render(SearchBar);

    const input = getInput();
    await fireEvent.input(input, { target: { value: 'test' } });

    // Enter before debounce fires
    await fireEvent.keyDown(input, { key: 'Enter' });

    // Should fire immediately on Enter
    expect(store.setSearch).toHaveBeenCalledWith('metadata', 'test');
  });
});

describe('SearchBar — Field selector labels to kinds', () => {
  it('has Metadata option with value "metadata"', () => {
    render(SearchBar);
    const select = getKindSelect();
    const options = Array.from(select.options);
    const metadata = options.find((o) => o.text === 'Metadata');
    expect(metadata).toBeTruthy();
    expect(metadata!.value).toBe('metadata');
  });

  it('has Subject option with value "subject"', () => {
    render(SearchBar);
    const select = getKindSelect();
    const options = Array.from(select.options);
    const subj = options.find((o) => o.text === 'Subject');
    expect(subj).toBeTruthy();
    expect(subj!.value).toBe('subject');
  });

  it('has From option with value "from"', () => {
    render(SearchBar);
    const select = getKindSelect();
    const options = Array.from(select.options);
    const from = options.find((o) => o.text === 'From');
    expect(from).toBeTruthy();
    expect(from!.value).toBe('from');
  });

  it('has To option with value "to"', () => {
    render(SearchBar);
    const select = getKindSelect();
    const options = Array.from(select.options);
    const to = options.find((o) => o.text === 'To');
    expect(to).toBeTruthy();
    expect(to!.value).toBe('to');
  });

  it('has Body option with value "containing"', () => {
    render(SearchBar);
    const select = getKindSelect();
    const options = Array.from(select.options);
    const body = options.find((o) => o.text === 'Body');
    expect(body).toBeTruthy();
    expect(body!.value).toBe('containing');
  });

  it('defaults to Metadata as the selected kind', () => {
    render(SearchBar);
    const select = getKindSelect();
    expect(select.value).toBe('metadata');
  });
});
