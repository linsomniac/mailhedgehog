<script lang="ts">
  // AIDEV-NOTE: EmptyState renders a friendly placeholder when there are no messages.
  // Distinct copy for "inbox is empty" vs "no search results" to guide the user.

  interface Props {
    isSearchActive?: boolean;
    searchQuery?: string;
  }

  let { isSearchActive = false, searchQuery = '' }: Props = $props();
</script>

<div class="flex flex-col items-center justify-center h-full p-8 text-center" data-testid="empty-state">
  <!-- Hedgehog / mail icon placeholder -->
  <div class="mb-4 text-gray-300 dark:text-gray-600" aria-hidden="true">
    <svg xmlns="http://www.w3.org/2000/svg" class="w-16 h-16 mx-auto" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1">
      <path stroke-linecap="round" stroke-linejoin="round" d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
    </svg>
  </div>

  {#if isSearchActive}
    <p class="text-base font-medium text-gray-600 dark:text-gray-400" data-testid="empty-state-title">
      No results found
    </p>
    {#if searchQuery}
      <p class="text-sm text-gray-400 dark:text-gray-500 mt-1">
        No messages matching <span class="font-medium">"{searchQuery}"</span>
      </p>
    {:else}
      <p class="text-sm text-gray-400 dark:text-gray-500 mt-1">Try a different search term</p>
    {/if}
  {:else}
    <p class="text-base font-medium text-gray-600 dark:text-gray-400" data-testid="empty-state-title">
      Inbox is empty
    </p>
    <p class="text-sm text-gray-400 dark:text-gray-500 mt-1">
      Messages will appear here when received via SMTP
    </p>
  {/if}
</div>
