<script lang="ts">
  import { extractResultUrl } from '$lib/chat-actions';

  export type ToolActivityItem = {
    tool: string;
    args?: unknown;
    result?: unknown;
    hasResult?: boolean;
  };

  // A compact, muted, collapsible indicator for the read/tool activity inside one
  // assistant turn. Collapsed by default — it must NOT look like an assistant reply.
  // Expand to reveal args + results for debugging/transparency.
  let { items, busy = false }: { items: ToolActivityItem[]; busy?: boolean } = $props();

  let expanded = $state(false);

  const allDone = $derived(items.every((i) => i.hasResult));
  const running = $derived(busy && !allDone);

  // Collect all unique URLs from completed results so we can surface "Open ▸" links.
  const resultUrls = $derived(
    items
      .filter((i) => i.hasResult)
      .map((i) => extractResultUrl(i.result))
      .filter((u): u is string => u !== null)
      .filter((u, idx, arr) => arr.indexOf(u) === idx) // deduplicate
  );

  function pretty(v: unknown): string {
    if (v === undefined) return '';
    try {
      return JSON.stringify(v, null, 2);
    } catch {
      return String(v);
    }
  }
</script>

<div class="tool-activity" class:running>
  <button
    class="tool-activity-row"
    onclick={() => (expanded = !expanded)}
    aria-expanded={expanded}
    title={expanded ? 'Hide tool details' : 'Show tool details'}
  >
    <span class="tool-activity-status" aria-hidden="true">
      {#if running}<span class="tool-activity-spin"></span>{:else}✓{/if}
    </span>
    <span class="tool-activity-names">
      {#each items as it, i (i)}<span class="tool-activity-name">{it.tool}</span>{#if i < items.length - 1}<span class="tool-activity-sep"> · </span>{/if}{/each}
    </span>
    <span class="tool-activity-chev" aria-hidden="true">{expanded ? '▾' : '▸'}</span>
  </button>

  {#if resultUrls.length > 0}
    <div class="tool-activity-open-links">
      {#each resultUrls as url (url)}
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          class="tool-activity-open-link"
        >Open ▸</a>
      {/each}
    </div>
  {/if}

  {#if expanded}
    <div class="tool-activity-detail">
      {#each items as it, i (i)}
        <div class="tool-activity-entry">
          <div class="tool-activity-entry-head">
            <b>{it.tool}</b>
            {#if !it.hasResult}<span class="tool-activity-pending">…</span>{/if}
          </div>
          {#if it.args !== undefined && it.args !== null}
            <pre class="tool-activity-pre args">{pretty(it.args)}</pre>
          {/if}
          {#if it.hasResult}
            <pre class="tool-activity-pre result">{pretty(it.result)}</pre>
          {/if}
        </div>
      {/each}
    </div>
  {/if}
</div>

<style>
  .tool-activity {
    align-self: flex-start;
    max-width: 100%;
    font-size: 0.78rem;
  }
  .tool-activity-row {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    background: none;
    border: none;
    padding: 0.1rem 0.1rem;
    margin: 0;
    cursor: pointer;
    color: var(--sub, rgba(255, 255, 255, 0.55));
    font-size: inherit;
    line-height: 1.4;
    text-align: left;
    opacity: 0.85;
    max-width: 100%;
  }
  .tool-activity-row:hover {
    opacity: 1;
    color: var(--txt, inherit);
  }
  .tool-activity-status {
    font-size: 0.72rem;
    display: inline-grid;
    place-items: center;
    width: 0.9em;
  }
  .tool-activity-spin {
    width: 0.62em;
    height: 0.62em;
    border: 1.5px solid currentColor;
    border-top-color: transparent;
    border-radius: 50%;
    display: inline-block;
    animation: tool-activity-spin 0.7s linear infinite;
  }
  @keyframes tool-activity-spin {
    to {
      transform: rotate(360deg);
    }
  }
  .tool-activity-names {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .tool-activity-name {
    font-family: ui-monospace, 'Cascadia Code', monospace;
  }
  .tool-activity-sep {
    opacity: 0.5;
  }
  .tool-activity-chev {
    font-size: 0.62rem;
    opacity: 0.7;
  }
  .tool-activity-open-links {
    display: flex;
    flex-wrap: wrap;
    gap: 0.35rem;
    margin-top: 0.35rem;
  }
  .tool-activity-open-link {
    display: inline-flex;
    align-items: center;
    padding: 0.2rem 0.55rem;
    border-radius: 6px;
    font-size: 0.78rem;
    font-weight: 500;
    background: var(--accent, #3b82f6);
    color: #fff;
    text-decoration: none;
    line-height: 1.4;
    transition: opacity 0.15s;
  }
  .tool-activity-open-link:hover {
    opacity: 0.85;
    text-decoration: none;
  }
  .tool-activity-detail {
    margin-top: 0.3rem;
    border-left: 2px solid var(--card-brd, rgba(255, 255, 255, 0.12));
    padding-left: 0.6rem;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }
  .tool-activity-entry-head {
    font-size: 0.78rem;
    color: var(--sub, rgba(255, 255, 255, 0.7));
    display: flex;
    gap: 0.4rem;
    align-items: center;
  }
  .tool-activity-pending {
    opacity: 0.6;
  }
  .tool-activity-pre {
    margin: 0.2rem 0 0;
    padding: 0.4rem 0.5rem;
    background: var(--surface-2, rgba(255, 255, 255, 0.04));
    border: 1px solid var(--card-brd, rgba(255, 255, 255, 0.1));
    border-radius: 6px;
    font-family: ui-monospace, 'Cascadia Code', monospace;
    font-size: 0.72rem;
    line-height: 1.45;
    color: var(--sub, rgba(255, 255, 255, 0.65));
    max-height: 220px;
    overflow: auto;
    white-space: pre-wrap;
    word-break: break-word;
  }
  .tool-activity-pre.args {
    opacity: 0.85;
  }
</style>
