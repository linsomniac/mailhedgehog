<script lang="ts">
  // AIDEV-NOTE: SECURITY-CRITICAL component — renders untrusted email content.
  //
  // Security invariants that MUST NOT be broken:
  // 1. The ONLY untrusted-HTML injection is the iframe srcdoc attribute binding, and that
  //    iframe MUST have sandbox="" WITHOUT allow-scripts or allow-same-origin.
  //    (There is no {@html} directive anywhere in this component.)
  // 2. Plain text, Source, and Headers tabs MUST use Svelte text interpolation ({}) only.
  // 3. buildSrcdoc() handles all HTML sanitization (script removal, cid rewriting, CSP injection).
  // 4. The srcdoc is built EAGERLY on message load (not lazily on tab open) so the HTML
  //    preview is ready when the default HTML tab is shown.
  //
  // Tab order: HTML | Plain | Source | Headers | MIME parts

  import type { FullMessage } from '../lib/types.js';
  import { store } from '../lib/store.svelte.js';
  import { emlUrl, partUrl, cidUrl } from '../lib/api.js';
  import {
    buildSrcdoc,
    getHtml,
    getPlain,
    linkify,
    PartTooLargeError,
  } from '../lib/mime.js';

  interface Props {
    message: FullMessage;
  }

  let { message }: Props = $props();

  // --- Tab state ---
  type Tab = 'html' | 'plain' | 'source' | 'headers' | 'parts';
  let activeTab = $state<Tab>('html');

  // AIDEV-NOTE: srcdoc is built eagerly on message load (in the $effect below) so the
  // HTML preview is ready when the default tab is shown. Once built, it's cached for
  // the lifetime of this message prop and re-computed when message changes.
  let srcdocCache = $state<string | null>(null);
  let srcdocError = $state<string | null>(null);

  // Plain tab state
  let plainError = $state<string | null>(null);

  // Source tab: cap display to 256 KB
  const SOURCE_CAP = 256 * 1024;

  // --- Derived values ---
  const msgId = $derived(message.ID);

  // Top-level MIME parts for the "MIME parts" tab (download indices match backend)
  const mimeParts = $derived(topLevelParts(message));

  // Header entries for the "Headers" tab
  const headerEntries = $derived(
    Object.entries(message.Content?.Headers ?? {}).sort(([a], [b]) => a.localeCompare(b)),
  );

  // Source data (capped)
  const sourceData = $derived(message.Raw?.Data ?? '');
  const sourceCapped = $derived(sourceData.slice(0, SOURCE_CAP));
  const sourceTruncated = $derived(sourceData.length > SOURCE_CAP);

  // --- Helpers ---

  // AIDEV-NOTE: Only top-level parts get a downloadable index. The backend
  // get_mime_part(raw, index) addresses msg.get_payload()[index] — top-level only.
  // Recursing into nested sub-parts would produce indices that the backend cannot
  // address, causing wrong-part downloads or 404s.
  // cid-based image links are unaffected (they use a separate endpoint that walks
  // the full MIME tree by Content-ID).
  function topLevelParts(msg: FullMessage): Array<{ index: number; contentType: string; size: number }> {
    const parts =
      msg.MIME?.Parts ?? msg.Content?.MIME?.Parts ?? [];
    return parts.map((part, index) => ({
      index,
      contentType: part.Headers['Content-Type']?.[0] ?? '(unknown)',
      size: part.Size,
    }));
  }

  // --- Tab handlers ---

  function openTab(tab: Tab): void {
    activeTab = tab;

    // srcdoc is built eagerly in the $effect on message load; no rebuild needed here.
    // But guard against the rare case where it hasn't been set yet (e.g. error path).
    if (tab === 'html' && srcdocCache === null && srcdocError === null) {
      buildHtmlTab();
    }

    if (tab === 'plain') {
      buildPlainTab();
    }
  }

  function buildHtmlTab(): void {
    srcdocError = null;
    try {
      const html = getHtml(message);
      if (!html) {
        srcdocError = 'no-html-part';
      } else {
        srcdocCache = buildSrcdoc(html, msgId, cidUrl);
      }
    } catch (err) {
      if (err instanceof PartTooLargeError) {
        srcdocError = 'too-large';
      } else {
        srcdocError = 'error';
      }
    }
  }

  // Plain text tokenized output
  let plainTokens = $state<import('../lib/mime.js').LinkToken[]>([]);

  function buildPlainTab(): void {
    plainError = null;
    try {
      const text = getPlain(message);
      plainTokens = linkify(text);
    } catch (err) {
      if (err instanceof PartTooLargeError) {
        plainError = 'too-large';
      } else {
        plainError = 'error';
      }
    }
  }

  // --- Actions ---

  async function handleDelete(): Promise<void> {
    await store.deleteOne(message.ID);
  }

  // Initialize: build HTML tab content on first render if HTML is the default tab
  $effect(() => {
    // Reset state when message changes
    srcdocCache = null;
    srcdocError = null;
    plainTokens = [];
    plainError = null;
    activeTab = 'html';
    // Build HTML tab immediately since it's the default
    buildHtmlTab();
  });
</script>

<!-- AIDEV-NOTE: MessageDetail renders the full message content in 5 tabs.
     Security invariants: no {@html} except srcdoc binding; iframe has sandbox=""
     without allow-scripts or allow-same-origin. -->
<div class="flex flex-col h-full bg-white border-l border-gray-200" data-testid="message-detail">
  <!-- Header bar: From, Subject, actions -->
  <div class="px-4 py-3 border-b border-gray-200 bg-gray-50 flex items-start justify-between gap-4">
    <div class="min-w-0">
      <div class="text-sm font-medium text-gray-900 truncate">
        {message.From?.Mailbox ?? ''}@{message.From?.Domain ?? ''}
      </div>
      <div class="text-sm text-gray-700 truncate mt-0.5">
        {message.Content?.Headers?.['Subject']?.[0] ?? '(no subject)'}
      </div>
    </div>
    <div class="flex-shrink-0 flex gap-2">
      <a
        href={emlUrl(message.ID)}
        download
        class="text-xs px-3 py-1.5 rounded border border-gray-300 text-gray-700 hover:bg-gray-100 transition-colors"
        aria-label="Download .eml file"
      >
        Download .eml
      </a>
      <button
        type="button"
        onclick={handleDelete}
        class="text-xs px-3 py-1.5 rounded border border-red-300 text-red-700 hover:bg-red-50 transition-colors"
        aria-label="Delete message"
      >
        Delete
      </button>
    </div>
  </div>

  <!-- Tab bar -->
  <div class="flex border-b border-gray-200 bg-white" role="tablist" aria-label="Message view tabs">
    {#each ([['html', 'HTML'], ['plain', 'Plain'], ['source', 'Source'], ['headers', 'Headers'], ['parts', 'MIME Parts']] as const) as [tab, label]}
      <button
        type="button"
        role="tab"
        aria-selected={activeTab === tab}
        aria-controls="tab-panel-{tab}"
        class="px-4 py-2 text-sm font-medium border-b-2 transition-colors"
        class:border-blue-500={activeTab === tab}
        class:text-blue-600={activeTab === tab}
        class:border-transparent={activeTab !== tab}
        class:text-gray-500={activeTab !== tab}
        class:hover:text-gray-700={activeTab !== tab}
        onclick={() => openTab(tab)}
        data-testid="tab-{tab}"
      >
        {label}
      </button>
    {/each}
  </div>

  <!-- Tab panels -->
  <div class="flex-1 overflow-hidden">

    <!-- HTML tab -->
    {#if activeTab === 'html'}
      <div
        id="tab-panel-html"
        role="tabpanel"
        class="h-full flex flex-col"
        data-testid="panel-html"
      >
        {#if srcdocError === 'too-large'}
          <div class="p-4 text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded m-4">
            This HTML email is too large to preview.
            <a href={emlUrl(message.ID)} download class="underline ml-1">Download the .eml instead</a>.
          </div>
        {:else if srcdocError === 'no-html-part'}
          <div class="p-4 text-sm text-gray-500">
            No HTML part found. Switch to the Plain tab.
          </div>
        {:else if srcdocError === 'error'}
          <div class="p-4 text-sm text-red-700 bg-red-50 border border-red-200 rounded m-4">
            Failed to render HTML content.
          </div>
        {:else if srcdocCache !== null}
          <!-- AIDEV-NOTE: SECURITY-CRITICAL iframe:
               - sandbox="" with NO allow-scripts, NO allow-same-origin
               - referrerpolicy="no-referrer" prevents Referer header on outbound requests
               - srcdoc is an attribute binding (NOT a {@html} directive) containing
                 sanitized HTML with CSP meta injected by buildSrcdoc()
               - This is the ONLY point where untrusted HTML reaches the DOM -->
          <iframe
            sandbox=""
            referrerpolicy="no-referrer"
            srcdoc={srcdocCache}
            class="w-full flex-1 border-0"
            style="min-height: 400px; max-height: 100%;"
            title="Email HTML content"
            data-testid="html-iframe"
          ></iframe>
        {:else}
          <div class="p-4 text-sm text-gray-400">Loading HTML preview...</div>
        {/if}
      </div>

    <!-- Plain tab -->
    {:else if activeTab === 'plain'}
      <div
        id="tab-panel-plain"
        role="tabpanel"
        class="h-full overflow-y-auto p-4"
        data-testid="panel-plain"
      >
        {#if plainError === 'too-large'}
          <div class="text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded p-3">
            This plain text is too large to preview.
            <a href={emlUrl(message.ID)} download class="underline ml-1">Download the .eml instead</a>.
          </div>
        {:else if plainError === 'error'}
          <div class="text-sm text-red-700 bg-red-50 border border-red-200 rounded p-3">
            Failed to render plain text content.
          </div>
        {:else if plainTokens.length === 0}
          <p class="text-sm text-gray-400">No plain text part found.</p>
        {:else}
          <!-- AIDEV-NOTE: Plain text rendered as text interpolation only — NEVER {@html}.
               Link tokens are rendered as <a> elements with safe rel/target attributes.
               text tokens are rendered via Svelte text interpolation (auto-escaped). -->
          <pre class="text-sm text-gray-800 whitespace-pre-wrap break-words font-sans">{#each plainTokens as token}{#if token.type === 'link'}<a
                href={token.href}
                target="_blank"
                rel="noopener noreferrer nofollow"
                class="text-blue-600 underline hover:text-blue-800"
                data-testid="plain-link"
              >{token.value}</a>{:else}{token.value}{/if}{/each}</pre>
        {/if}
      </div>

    <!-- Source tab -->
    {:else if activeTab === 'source'}
      <div
        id="tab-panel-source"
        role="tabpanel"
        class="h-full overflow-y-auto p-4"
        data-testid="panel-source"
      >
        {#if sourceTruncated}
          <div class="mb-3 text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded p-2 flex items-center justify-between">
            <span>Source truncated to first 256 KB.</span>
            <a href={emlUrl(message.ID)} download class="underline ml-2">Download full .eml</a>
          </div>
        {/if}
        <!-- AIDEV-NOTE: Source MUST use Svelte text interpolation, never {@html}.
             A <script> tag in Raw.Data MUST appear as literal text, not be parsed as HTML. -->
        <pre
          class="text-xs text-gray-700 whitespace-pre-wrap break-words"
          data-testid="source-pre"
        >{sourceCapped}</pre>
      </div>

    <!-- Headers tab -->
    {:else if activeTab === 'headers'}
      <div
        id="tab-panel-headers"
        role="tabpanel"
        class="h-full overflow-y-auto p-4"
        data-testid="panel-headers"
      >
        {#if headerEntries.length === 0}
          <p class="text-sm text-gray-400">No headers.</p>
        {:else}
          <dl class="space-y-2">
            {#each headerEntries as [name, values]}
              <div class="text-sm">
                <dt class="font-medium text-gray-700">{name}</dt>
                {#each values as value}
                  <!-- AIDEV-NOTE: Header values rendered as text interpolation — NEVER {@html} -->
                  <dd class="text-gray-600 ml-2 break-words">{value}</dd>
                {/each}
              </div>
            {/each}
          </dl>
        {/if}
      </div>

    <!-- MIME parts tab -->
    {:else if activeTab === 'parts'}
      <div
        id="tab-panel-parts"
        role="tabpanel"
        class="h-full overflow-y-auto p-4"
        data-testid="panel-parts"
      >
        {#if mimeParts.length === 0}
          <p class="text-sm text-gray-400">No MIME parts.</p>
        {:else}
          <ul class="space-y-2">
            {#each mimeParts as part}
              <li class="flex items-center justify-between text-sm border border-gray-200 rounded px-3 py-2">
                <div>
                  <span class="font-mono text-gray-700">{part.contentType}</span>
                  <span class="text-gray-400 ml-2">({part.size} bytes)</span>
                </div>
                <a
                  href={partUrl(message.ID, part.index)}
                  download
                  class="text-xs text-blue-600 underline hover:text-blue-800 ml-4"
                  data-testid="part-download-{part.index}"
                >
                  Download
                </a>
              </li>
            {/each}
          </ul>
        {/if}
      </div>
    {/if}
  </div>
</div>
