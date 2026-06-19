<script lang="ts">
  // AIDEV-NOTE: Presentational vertical divider for the list/reader split. It translates
  // pointer drags and keyboard nudges into callback calls; it owns NO width state — App
  // clamps + persists via store.setListWidth. Home/End pass ±1e7 sentinels that the
  // consumer's clamp resolves to min/max. Hidden on mobile (list is full-screen there).

  interface Props {
    onDrag: (clientX: number) => void;
    onNudge: (deltaPx: number) => void;
    ariaValueNow?: number;
    ariaValueMin?: number;
    ariaValueMax?: number;
  }

  let { onDrag, onNudge, ariaValueNow, ariaValueMin, ariaValueMax }: Props = $props();

  const STEP = 16;
  let dragging = $state(false);

  function onPointerDown(e: PointerEvent): void {
    dragging = true;
    e.preventDefault();
    const el = e.currentTarget as HTMLElement;
    try { el.setPointerCapture?.(e.pointerId); } catch { /* jsdom / unsupported */ }
    if (typeof document !== 'undefined') {
      document.body.style.userSelect = 'none';
      document.body.style.cursor = 'col-resize';
    }
  }

  function onPointerMove(e: PointerEvent): void {
    if (!dragging) return;
    onDrag(e.clientX);
  }

  function endDrag(e: PointerEvent): void {
    if (!dragging) return;
    dragging = false;
    const el = e.currentTarget as HTMLElement;
    try { el.releasePointerCapture?.(e.pointerId); } catch { /* ignore */ }
    if (typeof document !== 'undefined') {
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
    }
  }

  function onKeyDown(e: KeyboardEvent): void {
    switch (e.key) {
      case 'ArrowLeft': onNudge(-STEP); e.preventDefault(); break;
      case 'ArrowRight': onNudge(STEP); e.preventDefault(); break;
      case 'Home': onNudge(-1e7); e.preventDefault(); break;
      case 'End': onNudge(1e7); e.preventDefault(); break;
    }
  }
</script>

<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<div
  role="separator"
  aria-orientation="vertical"
  aria-label="Resize message list"
  aria-valuenow={ariaValueNow}
  aria-valuemin={ariaValueMin}
  aria-valuemax={ariaValueMax}
  tabindex="0"
  data-testid="splitter"
  class="hidden md:block shrink-0 w-1.5 cursor-col-resize self-stretch
         bg-gray-200 dark:bg-gray-700 hover:bg-indigo-400 dark:hover:bg-indigo-500
         focus:outline-none focus:bg-indigo-500 transition-colors {dragging ? 'bg-indigo-500' : ''}"
  onpointerdown={onPointerDown}
  onpointermove={onPointerMove}
  onpointerup={endDrag}
  onpointercancel={endDrag}
  onkeydown={onKeyDown}
></div>
