<script lang="ts">
  // AIDEV-NOTE: App.svelte is the root Svelte 5 component for mailhedgehog.
  // It mounts the full application shell:
  //   - Header: logo, SearchBar, actions (theme toggle, delete-all, notifications), StatusDot
  //   - Body: MessageList (left/top) + MessageDetail (right/bottom) in a split layout
  //   - EmptyState: shown when rows.length === 0 after initial load
  //
  // Theme: light/dark via Tailwind v4 class strategy.
  //   - Default: prefers-color-scheme media query
  //   - Persisted in localStorage under key 'mhg-theme'
  //   - Toggle adds/removes 'dark' on document.documentElement
  //
  // Notifications: opt-in via Notification.requestPermission().
  //   - Throttled: at most 1 per NOTIFICATION_THROTTLE_MS (coalesces bursts).
  //   - Guarded for browsers without the Notification API.
  //
  // WebSocket: connected in onMount, cleaned up in onDestroy.

  import { onMount, onDestroy } from 'svelte';
  import { store } from './lib/store.svelte.js';
  import * as ws from './lib/ws.js';
  import type { FullMessage } from './lib/types.js';

  import MessageList from './components/MessageList.svelte';
  import MessageDetail from './components/MessageDetail.svelte';
  import SearchBar from './components/SearchBar.svelte';
  import StatusDot from './components/StatusDot.svelte';
  import ConfirmDialog from './components/ConfirmDialog.svelte';
  import EmptyState from './components/EmptyState.svelte';

  // --- Theme ---
  // AIDEV-NOTE: Tailwind v4 class-based dark mode: add/remove 'dark' on <html>.
  // We read the stored preference first, then fall back to OS preference.
  const THEME_KEY = 'mhg-theme';

  function getInitialDark(): boolean {
    if (typeof window === 'undefined') return false;
    const stored = localStorage.getItem(THEME_KEY);
    if (stored === 'dark') return true;
    if (stored === 'light') return false;
    return window.matchMedia('(prefers-color-scheme: dark)').matches;
  }

  let isDark = $state(getInitialDark());

  $effect(() => {
    if (isDark) {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
  });

  function toggleTheme(): void {
    isDark = !isDark;
    localStorage.setItem(THEME_KEY, isDark ? 'dark' : 'light');
  }

  // --- Notifications ---
  const NOTIFICATION_THROTTLE_MS = 3000;
  let notificationsEnabled = $state(false);
  let lastNotificationTime = 0;

  async function toggleNotifications(): Promise<void> {
    if (!('Notification' in window)) return;
    if (notificationsEnabled) {
      notificationsEnabled = false;
      return;
    }
    const perm = await Notification.requestPermission();
    notificationsEnabled = perm === 'granted';
  }

  // AIDEV-NOTE: showNotification is called per live message when notifications are enabled.
  // Throttled to at most once per NOTIFICATION_THROTTLE_MS to prevent burst spam.
  function showNotification(subject: string, from: string): void {
    if (!notificationsEnabled) return;
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    const now = Date.now();
    if (now - lastNotificationTime < NOTIFICATION_THROTTLE_MS) return;
    lastNotificationTime = now;
    new Notification('New mail — mailhedgehog', {
      body: `From: ${from}\n${subject}`,
      icon: '/static/app/images/icon.svg',
    });
  }

  // --- Selected message ---
  let selectedMessage = $state<FullMessage | null>(null);

  async function handleSelect(id: string): Promise<void> {
    const msg = await store.select(id);
    // Only update if the selection hasn't changed while we were awaiting
    if (store.selectedId === id) {
      selectedMessage = msg;
    }
  }

  // --- Delete All ---
  let showDeleteAllDialog = $state(false);

  function handleDeleteAllClick(): void {
    showDeleteAllDialog = true;
  }

  async function handleDeleteAllConfirm(): Promise<void> {
    showDeleteAllDialog = false;
    await store.deleteAllMessages();
    selectedMessage = null;
  }

  function handleDeleteAllCancel(): void {
    showDeleteAllDialog = false;
  }

  // --- Initial load & WebSocket ---
  let connection: ws.Connection | null = null;
  let initialLoadDone = $state(false);

  onMount(async () => {
    await store.loadFirst();
    initialLoadDone = true;

    connection = ws.connect({
      onMessage(summary) {
        store.applyLive(summary);
        showNotification(summary.Subject ?? '(no subject)', summary.From
          ? `${summary.From.Mailbox}@${summary.From.Domain}`
          : 'Unknown sender');
      },
      onStatus: store.setWsStatus,
      onOpen: store.resync,
    });
  });

  onDestroy(() => {
    connection?.close();
  });

  // --- Row click handler (passed to MessageList) ---
  // MessageList calls store.select directly; we need to wire selectedMessage.
  // We watch store.selectedId changes in the effect above and call handleSelect.
  // But MessageList doesn't have a callback prop; it uses store.select() directly.
  // AIDEV-NOTE: We use a $effect to watch selectedId changes and trigger the full fetch.
  // This avoids prop-drilling a callback through MessageList → MessageRow.
  let lastSelectedId = $state<string | null>(null);

  $effect(() => {
    const id = store.selectedId;
    if (id !== null && id !== lastSelectedId) {
      lastSelectedId = id;
      handleSelect(id);
    } else if (id === null) {
      lastSelectedId = null;
      selectedMessage = null;
    }
  });
</script>

<!-- AIDEV-NOTE: Apply @custom-variant dark in app.css; here we just add the class to <html> via $effect. -->
<div class="min-h-screen flex flex-col bg-gray-50 dark:bg-gray-900 text-gray-900 dark:text-gray-100 transition-colors">

  <!-- ===== Header ===== -->
  <header class="flex items-center gap-3 px-4 py-2.5 bg-white dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700 shadow-sm shrink-0">

    <!-- Logo + app name -->
    <a href="/" class="flex items-center gap-2 shrink-0 no-underline" aria-label="mailhedgehog home">
      <img
        src="/static/app/images/icon.svg"
        alt="mailhedgehog"
        class="w-7 h-7"
        aria-hidden="true"
      />
      <span class="text-base font-semibold text-gray-900 dark:text-gray-100 leading-none hidden sm:inline">
        mailhedgehog
      </span>
    </a>

    <!-- Search bar (flex-1) -->
    <div class="flex-1 min-w-0">
      <SearchBar />
    </div>

    <!-- Actions -->
    <div class="flex items-center gap-2 shrink-0">

      <!-- Notifications toggle -->
      {#if typeof window !== 'undefined' && 'Notification' in window}
        <button
          type="button"
          class="p-1.5 rounded-md text-gray-500 dark:text-gray-400
                 hover:bg-gray-100 dark:hover:bg-gray-700
                 focus:outline-none focus:ring-2 focus:ring-indigo-500
                 transition-colors"
          onclick={toggleNotifications}
          aria-label={notificationsEnabled ? 'Disable notifications' : 'Enable notifications'}
          title={notificationsEnabled ? 'Disable notifications' : 'Enable notifications'}
          data-testid="notifications-toggle"
        >
          {#if notificationsEnabled}
            <!-- Bell on (active/indigo): standard bell shape -->
            <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5 text-indigo-500" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
              <path d="M10 2a6 6 0 00-6 6v3.586l-.707.707A1 1 0 004 14h12a1 1 0 00.707-1.707L16 11.586V8a6 6 0 00-6-6zM10 18a3 3 0 01-2.83-2h5.66A3 3 0 0110 18z" />
            </svg>
          {:else}
            <!-- Bell off (muted): bell outline with a diagonal slash line through it -->
            <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
              <path d="M10 2a6 6 0 00-6 6v3.586l-.707.707A1 1 0 004 14h12a1 1 0 00.707-1.707L16 11.586V8a6 6 0 00-6-6zM10 18a3 3 0 01-2.83-2h5.66A3 3 0 0110 18z" />
              <!-- Slash line from bottom-left to top-right -->
              <line x1="3" y1="17" x2="17" y2="3" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
            </svg>
          {/if}
        </button>
      {/if}

      <!-- Delete All button -->
      <button
        type="button"
        class="px-3 py-1.5 text-sm font-medium rounded-md border border-red-300 dark:border-red-700
               text-red-600 dark:text-red-400 bg-white dark:bg-gray-800
               hover:bg-red-50 dark:hover:bg-red-900/20
               focus:outline-none focus:ring-2 focus:ring-red-500 transition-colors"
        onclick={handleDeleteAllClick}
        aria-label="Delete all messages"
        data-testid="delete-all-btn"
      >
        Delete All
      </button>

      <!-- Theme toggle -->
      <button
        type="button"
        class="p-1.5 rounded-md text-gray-500 dark:text-gray-400
               hover:bg-gray-100 dark:hover:bg-gray-700
               focus:outline-none focus:ring-2 focus:ring-indigo-500
               transition-colors"
        onclick={toggleTheme}
        aria-label={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
        title={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
        data-testid="theme-toggle"
      >
        {#if isDark}
          <!-- Sun icon -->
          <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
            <path fill-rule="evenodd" d="M10 2a1 1 0 011 1v1a1 1 0 11-2 0V3a1 1 0 011-1zm4 8a4 4 0 11-8 0 4 4 0 018 0zm-.464 4.95l.707.707a1 1 0 001.414-1.414l-.707-.707a1 1 0 00-1.414 1.414zm2.12-10.607a1 1 0 010 1.414l-.706.707a1 1 0 11-1.414-1.414l.707-.707a1 1 0 011.414 0zM17 11a1 1 0 100-2h-1a1 1 0 100 2h1zm-7 4a1 1 0 011 1v1a1 1 0 11-2 0v-1a1 1 0 011-1zM5.05 6.464A1 1 0 106.465 5.05l-.708-.707a1 1 0 00-1.414 1.414l.707.707zm1.414 8.486l-.707.707a1 1 0 01-1.414-1.414l.707-.707a1 1 0 011.414 1.414zM4 11a1 1 0 100-2H3a1 1 0 000 2h1z" clip-rule="evenodd" />
          </svg>
        {:else}
          <!-- Moon icon -->
          <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
            <path d="M17.293 13.293A8 8 0 016.707 2.707a8.001 8.001 0 1010.586 10.586z" />
          </svg>
        {/if}
      </button>

      <!-- Connection status -->
      <StatusDot status={store.wsStatus} />
    </div>
  </header>

  <!-- ===== Main body ===== -->
  <main class="flex-1 flex overflow-hidden" aria-label="Main content">

    <!-- Message List panel (left / top) -->
    <section
      class="flex flex-col border-r border-gray-200 dark:border-gray-700 overflow-hidden
             {selectedMessage || store.selectError ? 'w-80 shrink-0 hidden md:flex' : 'flex-1'}"
      aria-label="Message list"
    >
      {#if initialLoadDone && store.rows.length === 0 && !store.loading}
        <EmptyState
          isSearchActive={store.search.active}
          searchQuery={store.search.query}
        />
      {:else}
        <MessageList />
      {/if}
    </section>

    <!-- Message Detail panel (right / bottom) -->
    {#if store.selectError}
      <section
        class="flex-1 flex items-center justify-center p-8 bg-white dark:bg-gray-900"
        aria-label="Message detail"
        data-testid="select-error"
      >
        <div class="text-center">
          <p class="text-gray-500 dark:text-gray-400">{store.selectError}</p>
          <button
            type="button"
            class="mt-3 text-sm text-indigo-600 dark:text-indigo-400 underline"
            onclick={() => { store.clearSelect(); }}
          >
            Go back
          </button>
        </div>
      </section>
    {:else if selectedMessage}
      <section
        class="flex-1 flex flex-col overflow-hidden bg-white dark:bg-gray-900"
        aria-label="Message detail"
      >
        <MessageDetail message={selectedMessage} />
      </section>
    {:else}
      <!-- No selection placeholder — shown on wide viewports -->
      <section
        class="flex-1 hidden md:flex items-center justify-center bg-white dark:bg-gray-900 text-gray-400 dark:text-gray-600"
        aria-label="Message detail"
        data-testid="no-selection"
      >
        <div class="text-center">
          <svg xmlns="http://www.w3.org/2000/svg" class="w-12 h-12 mx-auto mb-3 opacity-40" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1" aria-hidden="true">
            <path stroke-linecap="round" stroke-linejoin="round" d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
          </svg>
          <p class="text-sm">Select a message to read it</p>
        </div>
      </section>
    {/if}
  </main>
</div>

<!-- Confirm dialog (portal-like, rendered outside the layout flow) -->
{#if showDeleteAllDialog}
  <ConfirmDialog
    title="Delete all messages?"
    message="This will permanently delete all {store.total} stored message{store.total === 1 ? '' : 's'}. This action cannot be undone."
    confirmLabel="Delete All"
    onConfirm={handleDeleteAllConfirm}
    onCancel={handleDeleteAllCancel}
  />
{/if}
