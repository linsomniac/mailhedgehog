<script lang="ts">
  // AIDEV-NOTE: SearchBar provides a text input + field selector for searching messages.
  // Search kinds and debounce behavior:
  //   - Metadata/Subject/From/To: debounced at ~250ms (live as you type)
  //   - Body (containing): Enter-to-search only (no live debounce — body search is expensive)
  // Switching the field kind while a query is present re-runs the search appropriately.
  // Empty query always clears the search regardless of kind.
  //
  // Accessible: label + combobox pattern, keyboard navigable.

  import { store } from '../lib/store.svelte.js';

  // Search field options mapping label → kind
  const FIELDS = [
    { label: 'Metadata', kind: 'metadata' },
    { label: 'Subject', kind: 'subject' },
    { label: 'From', kind: 'from' },
    { label: 'To', kind: 'to' },
    { label: 'Body', kind: 'containing' },
  ] as const;

  type FieldKind = (typeof FIELDS)[number]['kind'];

  let selectedKind = $state<FieldKind>('metadata');
  let query = $state('');
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  // AIDEV-NOTE: isBodyKind determines whether we should use Enter-to-search or debounced search.
  const isBodyKind = $derived(selectedKind === 'containing');

  function cancelDebounce(): void {
    if (debounceTimer !== null) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
  }

  function runSearch(): void {
    if (query.trim() === '') {
      store.clearSearch();
    } else {
      store.setSearch(selectedKind, query.trim());
    }
  }

  // AIDEV-NOTE: handleInput is called on every keystroke for non-body fields.
  // For body kind, we do NOT fire here — only on submit/Enter.
  function handleInput(): void {
    if (isBodyKind) return;
    cancelDebounce();
    if (query.trim() === '') {
      store.clearSearch();
      return;
    }
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      runSearch();
    }, 250);
  }

  // AIDEV-NOTE: handleKeydown handles Enter for Body kind (and all kinds for convenience).
  function handleKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter') {
      cancelDebounce();
      runSearch();
    }
  }

  // AIDEV-NOTE: handleKindChange fires when the user switches the field selector.
  // If a query is active, re-run the search with the new kind (unless switching to body kind,
  // where we wait for Enter).
  function handleKindChange(): void {
    cancelDebounce();
    if (query.trim() === '') {
      store.clearSearch();
    } else if (!isBodyKind) {
      // Re-run debounced search for non-body kinds
      debounceTimer = setTimeout(() => {
        debounceTimer = null;
        runSearch();
      }, 250);
    }
    // For body kind with existing query: wait for Enter
  }

  function handleClear(): void {
    cancelDebounce();
    query = '';
    store.clearSearch();
  }
</script>

<div class="flex items-center gap-2 flex-1 min-w-0" role="search">
  <!-- Field selector -->
  <label for="search-kind" class="sr-only">Search field</label>
  <select
    id="search-kind"
    class="shrink-0 text-sm border border-gray-300 dark:border-gray-600 rounded-md px-2 py-1.5
           bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-200
           focus:outline-none focus:ring-2 focus:ring-indigo-500 dark:focus:ring-indigo-400
           cursor-pointer"
    bind:value={selectedKind}
    onchange={handleKindChange}
    aria-label="Search field"
    data-testid="search-kind"
  >
    {#each FIELDS as field}
      <option value={field.kind}>{field.label}</option>
    {/each}
  </select>

  <!-- Search input -->
  <div class="relative flex-1 min-w-0">
    <label for="search-input" class="sr-only">
      Search messages{isBodyKind ? ' (press Enter to search)' : ''}
    </label>
    <input
      id="search-input"
      type="search"
      class="w-full text-sm border border-gray-300 dark:border-gray-600 rounded-md pl-3 pr-8 py-1.5
             bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100
             placeholder-gray-400 dark:placeholder-gray-500
             focus:outline-none focus:ring-2 focus:ring-indigo-500 dark:focus:ring-indigo-400
             transition-colors"
      placeholder={isBodyKind ? 'Body search — press Enter' : 'Search…'}
      bind:value={query}
      oninput={handleInput}
      onkeydown={handleKeydown}
      aria-label="Search messages"
      data-testid="search-input"
      autocomplete="off"
      spellcheck={false}
    />
    {#if query}
      <button
        type="button"
        class="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600
               dark:hover:text-gray-300 focus:outline-none"
        onclick={handleClear}
        aria-label="Clear search"
        data-testid="search-clear"
      >
        <!-- × symbol -->
        <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
          <path fill-rule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clip-rule="evenodd" />
        </svg>
      </button>
    {/if}
  </div>
</div>
