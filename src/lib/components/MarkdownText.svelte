<script lang="ts">
  import { renderMarkdown } from '$lib/markdown';

  // Renders assistant chat text as sanitized Markdown. Re-parses on every `text`
  // change so the bubble updates live while streaming. User messages stay plain text.
  let { text }: { text: string } = $props();
  const html = $derived(renderMarkdown(text));
</script>

<div class="md">{@html html}</div>

<style>
  /* Compact, mobile-first Markdown styling tuned for the narrow chat column. */
  .md {
    font-size: inherit;
    line-height: 1.5;
    word-break: break-word;
    overflow-wrap: anywhere;
  }
  /* Tight vertical rhythm so a reply stays compact. */
  .md :global(> *) {
    margin: 0;
  }
  .md :global(> * + *) {
    margin-top: 0.5em;
  }
  .md :global(p) {
    margin: 0;
  }
  .md :global(h1),
  .md :global(h2),
  .md :global(h3),
  .md :global(h4) {
    font-size: 1.05em;
    font-weight: 700;
    line-height: 1.3;
  }
  .md :global(ul),
  .md :global(ol) {
    margin: 0;
    padding-left: 1.25em;
  }
  .md :global(li + li) {
    margin-top: 0.15em;
  }
  .md :global(a) {
    color: var(--accent, #3b82f6);
    text-decoration: underline;
    text-underline-offset: 2px;
    /* Long URLs break instead of widening the bubble. */
    word-break: break-word;
    overflow-wrap: anywhere;
  }
  /* Inline code + code blocks: mono font on a subtle surface. */
  .md :global(code) {
    font-family: ui-monospace, 'Cascadia Code', 'SF Mono', monospace;
    font-size: 0.85em;
    background: var(--surface-2, rgba(255, 255, 255, 0.08));
    padding: 0.1em 0.35em;
    border-radius: 5px;
  }
  .md :global(pre) {
    background: var(--surface-2, rgba(255, 255, 255, 0.08));
    border: 1px solid var(--card-brd, rgba(255, 255, 255, 0.1));
    border-radius: 8px;
    padding: 0.6em 0.7em;
    max-width: 100%;
    overflow-x: auto;
  }
  .md :global(pre code) {
    background: none;
    padding: 0;
    border-radius: 0;
    font-size: 0.82em;
    line-height: 1.45;
  }
  /* Blockquote: left accent border + muted text. */
  .md :global(blockquote) {
    border-left: 3px solid color-mix(in srgb, var(--accent, #3b82f6) 55%, transparent);
    padding: 0.05em 0 0.05em 0.7em;
    color: var(--sub, rgba(255, 255, 255, 0.65));
  }
  /* Tables: compact font + padding so typical (few-column) tables fit the bubble
     width without a scrollbar. `display:block` + overflow-x stays as a fallback for
     genuinely wide tables; cells wrap rather than forcing nowrap overflow. */
  .md :global(table) {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.78em;
    display: block;
    max-width: 100%;
    overflow-x: auto;
  }
  .md :global(th),
  .md :global(td) {
    border: 1px solid var(--card-brd, rgba(255, 255, 255, 0.12));
    padding: 0.22em 0.45em;
    text-align: left;
    overflow-wrap: break-word;
  }
  .md :global(thead th) {
    background: var(--surface-2, rgba(255, 255, 255, 0.06));
    font-weight: 700;
  }
  .md :global(tbody tr:nth-child(even)) {
    background: color-mix(in srgb, currentColor 5%, transparent);
  }
  .md :global(hr) {
    border: none;
    border-top: 1px solid var(--card-brd, rgba(255, 255, 255, 0.12));
  }
  .md :global(img) {
    max-width: 100%;
    height: auto;
    border-radius: 6px;
  }
</style>
