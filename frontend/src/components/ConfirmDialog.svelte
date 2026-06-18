<script lang="ts">
  // AIDEV-NOTE: ConfirmDialog is a lightweight accessible modal for dangerous actions.
  // Used for "Delete All" to prevent accidental data loss.
  // Uses the native <dialog> element for accessibility (focus trap, ESC to dismiss).
  // onConfirm fires when the user clicks the primary action button.
  // onCancel fires when clicking Cancel, the backdrop, or pressing ESC.

  interface Props {
    title: string;
    message: string;
    confirmLabel?: string;
    onConfirm: () => void;
    onCancel: () => void;
  }

  let { title, message, confirmLabel = 'Confirm', onConfirm, onCancel }: Props = $props();

  let dialog = $state<HTMLDialogElement | null>(null);

  // Open dialog via showModal() for focus trap + ESC handling
  $effect(() => {
    if (dialog) {
      dialog.showModal();
    }
  });

  function handleBackdropClick(event: MouseEvent): void {
    // Clicking the <dialog> element itself (the backdrop) — not a child
    if (event.target === dialog) {
      onCancel();
    }
  }

  function handleConfirm(): void {
    onConfirm();
  }

  function handleCancel(): void {
    onCancel();
  }
</script>

<!-- AIDEV-NOTE: svelte:window keydown listener is NOT used here because the native
     <dialog> element handles ESC automatically by firing the 'cancel' event. -->
<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<dialog
  bind:this={dialog}
  class="rounded-lg shadow-xl border-0 p-0 max-w-sm w-full bg-white dark:bg-gray-800
         backdrop:bg-black/40 backdrop:backdrop-blur-sm"
  onclick={handleBackdropClick}
  oncancel={handleCancel}
  aria-labelledby="confirm-dialog-title"
  aria-describedby="confirm-dialog-message"
  data-testid="confirm-dialog"
>
  <div class="p-6">
    <h2
      id="confirm-dialog-title"
      class="text-base font-semibold text-gray-900 dark:text-gray-100 mb-2"
    >
      {title}
    </h2>
    <p
      id="confirm-dialog-message"
      class="text-sm text-gray-600 dark:text-gray-400 mb-6"
    >
      {message}
    </p>
    <div class="flex justify-end gap-3">
      <button
        type="button"
        class="px-4 py-2 text-sm font-medium rounded-md border border-gray-300 dark:border-gray-600
               text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-800
               hover:bg-gray-50 dark:hover:bg-gray-700
               focus:outline-none focus:ring-2 focus:ring-indigo-500 transition-colors"
        onclick={handleCancel}
        data-testid="confirm-cancel"
      >
        Cancel
      </button>
      <button
        type="button"
        class="px-4 py-2 text-sm font-medium rounded-md border border-transparent
               text-white bg-red-600 hover:bg-red-700
               focus:outline-none focus:ring-2 focus:ring-red-500 transition-colors"
        onclick={handleConfirm}
        data-testid="confirm-ok"
      >
        {confirmLabel}
      </button>
    </div>
  </div>
</dialog>
