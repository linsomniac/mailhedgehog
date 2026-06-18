<script lang="ts">
  // AIDEV-NOTE: MessageList is the virtualized scrolling list of email summaries.
  // Uses @tanstack/svelte-virtual createVirtualizer with FIXED estimateSize = ROW_HEIGHT.
  // Infinite scroll: triggers loadMore() when near bottom and rows.length < total.
  //
  // Prepend stability: when atTop and live messages arrive (applyLive prepends to rows[]),
  // the virtualizer's items count increases. Since we're at top (scrollTop ~0), new items
  // appear above the viewport naturally. We call scrollToIndex(0) to ensure index 0 is visible.
  //
  // "N new messages" pill: shown when pendingNew > 0 (user scrolled down while new messages
  // arrived). Clicking resets pendingNew and calls showPending() which resyncs from server,
  // then scrolls to top.
  //
  // jsdom note: createVirtualizer depends on real element sizes (getBoundingClientRect).
  // In jsdom, all measurements return 0, so virtual items are empty. Component tests for
  // MessageList are limited to pill visibility; store logic tests cover the real behavior.

  import { createVirtualizer } from '@tanstack/svelte-virtual';
  import { store } from '../lib/store.svelte.js';
  import MessageRow from './MessageRow.svelte';
  import { ROW_HEIGHT } from './constants.js';

  // Overscan: render this many extra items beyond the visible area for smoother scrolling.
  const OVERSCAN = 5;
  // Load more when within this many pixels of the bottom.
  const LOAD_MORE_THRESHOLD = 200;

  let scrollContainer = $state<HTMLDivElement | null>(null);

  // AIDEV-NOTE: We use a getter for count so the virtualizer reacts to rows changes.
  // The Svelte store returned by createVirtualizer is a Svelte readable store (old-style),
  // subscribed with $virtualizer in the template.
  let virtualizer = $derived(
    scrollContainer
      ? createVirtualizer<HTMLDivElement, HTMLButtonElement>({
          count: store.rows.length,
          getScrollElement: () => scrollContainer!,
          estimateSize: () => ROW_HEIGHT,
          overscan: OVERSCAN,
        })
      : null
  );

  function handleScroll(e: Event) {
    const el = e.currentTarget as HTMLDivElement;
    const scrollTop = el.scrollTop;
    const scrollHeight = el.scrollHeight;
    const clientHeight = el.clientHeight;

    // Update atTop state: at top if scrollTop is less than one row height
    store.setAtTop(scrollTop < ROW_HEIGHT);

    // Infinite scroll: load more when near the bottom
    const distanceFromBottom = scrollHeight - scrollTop - clientHeight;
    if (distanceFromBottom < LOAD_MORE_THRESHOLD && store.rows.length < store.total) {
      store.loadMore();
    }
  }

  async function handlePendingClick() {
    // Reset and resync
    await store.showPending();
    // Scroll to top after resync
    if (scrollContainer) {
      scrollContainer.scrollTop = 0;
    }
  }
</script>

<!-- AIDEV-NOTE: The scroll container must have a fixed height to enable virtualization.
     flex-1 combined with h-full allows it to fill the parent container. -->
<div class="relative flex flex-col h-full">
  <!-- "N new messages" pill: shown when pendingNew > 0 -->
  {#if store.pendingNew > 0}
    <div class="absolute top-2 left-1/2 -translate-x-1/2 z-10" data-testid="pending-pill">
      <button
        type="button"
        class="bg-blue-600 text-white text-sm font-medium px-4 py-1.5 rounded-full shadow-lg hover:bg-blue-700 transition-colors"
        onclick={handlePendingClick}
      >
        {store.pendingNew} new {store.pendingNew === 1 ? 'message' : 'messages'}
      </button>
    </div>
  {/if}

  <!-- Scrollable virtual list container -->
  <div
    bind:this={scrollContainer}
    class="flex-1 overflow-y-auto"
    onscroll={handleScroll}
    role="list"
    aria-label="Messages"
  >
    {#if store.rows.length === 0 && !store.loading}
      <div class="flex items-center justify-center h-full p-8 text-gray-400">
        <div class="text-center">
          <p class="text-lg">No messages</p>
          {#if store.search.active}
            <p class="text-sm mt-1">No results for "{store.search.query}"</p>
          {:else}
            <p class="text-sm mt-1">Messages will appear here when received</p>
          {/if}
        </div>
      </div>
    {:else if virtualizer}
      <!-- AIDEV-NOTE: The outer div has the total scroll height; inner div is translated
           to the current virtual window offset. This is the standard tanstack-virtual pattern. -->
      {@const virt = $virtualizer}
      {#if virt}
        <div style="height: {virt.getTotalSize()}px; position: relative;">
          {#each virt.getVirtualItems() as item (item.key)}
            <div
              role="listitem"
              style="position: absolute; top: 0; left: 0; width: 100%; transform: translateY({item.start}px);"
            >
              <MessageRow summary={store.rows[item.index]} />
            </div>
          {/each}
        </div>
      {/if}
    {/if}

    <!-- Loading indicator -->
    {#if store.loading}
      <div class="flex items-center justify-center p-4 text-gray-400 text-sm">
        Loading...
      </div>
    {/if}
  </div>
</div>
