<script lang="ts">
  // AIDEV-NOTE: StatusDot shows the WebSocket connection status as a colored dot.
  // Connected = green, Reconnecting = amber, Offline = red.
  // Accessible via aria-label and title attributes.

  import type { Status } from '../lib/ws.js';

  interface Props {
    status: Status;
  }

  let { status }: Props = $props();

  const config = $derived(
    status === 'connected'
      ? { color: 'bg-green-500', label: 'Connected' }
      : status === 'reconnecting'
        ? { color: 'bg-amber-400', label: 'Reconnecting…' }
        : { color: 'bg-red-500', label: 'Offline' }
  );
</script>

<div
  class="flex items-center gap-1.5"
  title={config.label}
  aria-label="Connection status: {config.label}"
  data-testid="status-dot"
>
  <span
    class="inline-block w-2.5 h-2.5 rounded-full {config.color}"
    aria-hidden="true"
    data-testid="status-dot-indicator"
    data-status={status}
  ></span>
  <span class="text-xs text-gray-500 dark:text-gray-400 hidden sm:inline select-none" aria-hidden="true">
    {config.label}
  </span>
</div>
