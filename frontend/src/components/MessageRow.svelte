<script lang="ts">
  // AIDEV-NOTE: MessageRow renders a single fixed-height (ROW_HEIGHT=64px) row.
  // Layout = Candidate B (two-line, subject-forward), responsive via a scoped @container query:
  //   - container <480px (narrow sidebar): compact — line1 From + time, line2 Subject.
  //   - container >=480px (wide list):     rich — line1 From + →To+N + time, line2 Subject + size.
  // The list <section> in App.svelte sets `container-type: inline-size` to drive this.
  // CRITICAL: height is locked at ROW_HEIGHT with overflow:hidden so a 5000-char subject
  // cannot change row height — the virtualizer offset math depends on it.
  // Truncating spans keep inline overflow/ellipsis/nowrap (asserted by tests).

  import type { Summary } from '../lib/types.js';
  import { store } from '../lib/store.svelte.js';
  import { relativeTime, formatSize } from '../lib/time.js';
  import { ROW_HEIGHT } from './constants.js';

  interface Props {
    summary: Summary;
  }

  let { summary }: Props = $props();

  const ELL = 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';

  const fromDisplay = $derived(
    summary.From ? `${summary.From.Mailbox}@${summary.From.Domain}` : 'Unknown sender',
  );

  // AIDEV-NOTE: first recipient + count. ToCount is the true total (To[] is truncated to 3).
  const recipientDisplay = $derived.by(() => {
    const to = summary.To ?? [];
    if (to.length === 0) return '';
    const first = `${to[0].Mailbox}@${to[0].Domain}`;
    const total = summary.ToCount ?? to.length;
    const extra = total - 1;
    return extra > 0 ? `${first} +${extra}` : first;
  });

  const isSelected = $derived(store.selectedId === summary.ID);

  function handleClick() {
    store.select(summary.ID);
  }
</script>

<button
  type="button"
  class="message-row w-full text-left px-4 flex items-center border-b border-gray-100 dark:border-gray-700 cursor-pointer transition-colors {isSelected
    ? 'bg-blue-50 dark:bg-blue-900/30'
    : 'bg-white dark:bg-gray-800 hover:bg-gray-50 dark:hover:bg-gray-700/40'}"
  style="height: {ROW_HEIGHT}px; min-height: {ROW_HEIGHT}px; max-height: {ROW_HEIGHT}px; overflow: hidden;"
  onclick={handleClick}
  aria-pressed={isSelected}
  aria-label="Message from {fromDisplay}: {summary.Subject}"
>
  <div class="row-col">
    <div class="row-line1">
      <span class="row-sender text-sm font-medium text-gray-900 dark:text-gray-100" style={ELL}>
        {fromDisplay}
      </span>
      {#if recipientDisplay}
        <span
          class="row-recip text-xs text-gray-500 dark:text-gray-400"
          style={ELL}
          data-testid="row-recipient"
        >
          → {recipientDisplay}
        </span>
      {/if}
      <span class="row-time text-xs text-gray-400 dark:text-gray-500">
        {relativeTime(summary.Created)}
      </span>
    </div>
    <div class="row-line2">
      <span class="row-subject text-sm text-gray-700 dark:text-gray-300" style={ELL}>
        {summary.Subject || '(no subject)'}
      </span>
      <span class="row-size text-xs text-gray-400 dark:text-gray-500">
        {formatSize(summary.Size)}
      </span>
    </div>
  </div>
</button>

<style>
  /* AIDEV-NOTE: structural + responsive layout. Colors/typography live in Tailwind
     classes above; this block only does flex sizing and the container-query show/hide.
     The @container query resolves to the nearest ancestor with container-type
     (the list <section> in App.svelte). */
  .row-col {
    display: flex;
    flex-direction: column;
    justify-content: center;
    flex: 1 1 auto;
    min-width: 0;
    gap: 2px;
  }
  .row-line1,
  .row-line2 {
    display: flex;
    align-items: baseline;
    gap: 8px;
    min-width: 0;
  }
  /* Compact (narrow) defaults: sender grows, recipient + size hidden. */
  .row-sender { flex: 1 1 auto; min-width: 0; }
  .row-recip { display: none; flex: 1 1 auto; min-width: 0; }
  .row-time { flex: 0 0 auto; }
  .row-subject { flex: 1 1 auto; min-width: 0; }
  .row-size { display: none; flex: 0 0 auto; }

  /* Rich (wide) layout. */
  @container (min-width: 480px) {
    .row-sender { flex: 0 0 auto; max-width: 45%; }
    .row-recip { display: block; }
    .row-size { display: block; }
  }
</style>
