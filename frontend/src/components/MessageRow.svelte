<script lang="ts">
  // AIDEV-NOTE: MessageRow renders a single fixed-height row in the virtual message list.
  // CRITICAL: height is locked at ROW_HEIGHT (64px) with overflow:hidden + text-overflow:ellipsis.
  // A 5000-char subject MUST NOT change the rendered height — this protects virtualizer offset math.
  // Click calls store.select(id) to load the full message.

  import type { Summary } from '../lib/types.js';
  import { store } from '../lib/store.svelte.js';
  import { relativeTime, formatSize } from '../lib/time.js';

  // AIDEV-NOTE: ROW_HEIGHT is imported from constants.ts to keep it in sync with MessageList.
  import { ROW_HEIGHT } from './constants.js';

  interface Props {
    summary: Summary;
  }

  let { summary }: Props = $props();

  // Derive display name: prefer a display name from From, else Mailbox@Domain.
  // AIDEV-NOTE: The backend Addr type does not have a Name field; we use Mailbox@Domain.
  const fromDisplay = $derived(
    summary.From
      ? `${summary.From.Mailbox}@${summary.From.Domain}`
      : 'Unknown sender'
  );

  const isSelected = $derived(store.selectedId === summary.ID);

  function handleClick() {
    store.select(summary.ID);
  }
</script>

<!-- AIDEV-NOTE: Fixed height enforced via inline style AND class. Both height and max-height
     are set, plus overflow:hidden so no content can expand the row. The virtualizer
     DEPENDS on every row being exactly ROW_HEIGHT px tall. -->
<button
  type="button"
  class="message-row w-full text-left px-4 flex items-center gap-3 border-b border-gray-100 cursor-pointer transition-colors"
  class:bg-blue-50={isSelected}
  class:bg-white={!isSelected}
  style="height: {ROW_HEIGHT}px; min-height: {ROW_HEIGHT}px; max-height: {ROW_HEIGHT}px; overflow: hidden;"
  onclick={handleClick}
  aria-pressed={isSelected}
  aria-label="Message from {fromDisplay}: {summary.Subject}"
>
  <!-- Sender column -->
  <div class="flex-shrink-0 w-40 min-w-0">
    <span
      class="block text-sm font-medium text-gray-900 overflow-hidden text-ellipsis whitespace-nowrap"
      style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap;"
    >
      {fromDisplay}
    </span>
  </div>

  <!-- Subject column (flex-grow to fill remaining space) -->
  <div class="flex-1 min-w-0">
    <span
      class="block text-sm text-gray-700 overflow-hidden text-ellipsis whitespace-nowrap"
      style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap;"
    >
      {summary.Subject || '(no subject)'}
    </span>
  </div>

  <!-- Meta column: time + size -->
  <div class="flex-shrink-0 text-right space-y-0.5 ml-2">
    <div class="text-xs text-gray-400 whitespace-nowrap">
      {relativeTime(summary.Created)}
    </div>
    <div class="text-xs text-gray-400 whitespace-nowrap">
      {formatSize(summary.Size)}
    </div>
  </div>
</button>
