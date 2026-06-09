<script lang="ts">
  import { _ } from 'svelte-i18n';
  import PosterTile from './PosterTile.svelte';
  import type { DiscoverItem } from '$lib/server/consumer/types';
  let { title, items, onSelect, seeMoreUrl }: {
    title: string;
    items: DiscoverItem[];
    onSelect: (i: DiscoverItem) => void;
    seeMoreUrl?: string | null;
  } = $props();

  let strip = $state<HTMLDivElement | null>(null);
  // Whether the strip currently overflows enough to scroll, plus which ends we're at.
  let atStart = $state(true);
  let atEnd = $state(true);

  // Recompute the arrow visibility from the strip's scroll position. A 2px slop
  // absorbs sub-pixel rounding so the end arrows actually hide at the extremes.
  function updateEdges() {
    if (!strip) return;
    const max = strip.scrollWidth - strip.clientWidth;
    atStart = strip.scrollLeft <= 2;
    atEnd = strip.scrollLeft >= max - 2;
  }

  $effect(() => {
    // Re-evaluate edges whenever the item set changes (new content can add overflow).
    void items.length;
    queueMicrotask(updateEdges);
  });

  function page(dir: 1 | -1) {
    if (!strip) return;
    strip.scrollBy({ left: dir * strip.clientWidth, behavior: 'smooth' });
  }

  // Translate a vertical wheel gesture (trackpad / mouse) into horizontal scroll
  // when the pointer is over the row, so a desktop mouse can browse the strip.
  // Horizontal-intent wheels are left to the browser's native handling.
  function onWheel(e: WheelEvent) {
    if (!strip) return;
    if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
    const max = strip.scrollWidth - strip.clientWidth;
    if (max <= 0) return;
    e.preventDefault();
    strip.scrollLeft += e.deltaY;
  }
</script>

{#if items.length}
  <section class="row">
    <div class="row-head">
      <h2>{title}</h2>
      {#if seeMoreUrl}
        <a class="see-more" href={seeMoreUrl} target="_blank" rel="noopener noreferrer">{$_('app.seeMore')} ▸</a>
      {/if}
    </div>
    <div class="strip-wrap">
      <button
        class="arrow arrow-l"
        class:hidden={atStart}
        type="button"
        aria-label={$_('app.scrollLeft')}
        tabindex="-1"
        onclick={() => page(-1)}
      >‹</button>
      <div
        class="strip"
        bind:this={strip}
        onscroll={updateEdges}
        onwheel={onWheel}
      >
        {#each items as item (item.tmdbId ?? `${item.title}-${item.year ?? ''}`)}
          <PosterTile {item} {onSelect} />
        {/each}
      </div>
      <button
        class="arrow arrow-r"
        class:hidden={atEnd}
        type="button"
        aria-label={$_('app.scrollRight')}
        tabindex="-1"
        onclick={() => page(1)}
      >›</button>
    </div>
  </section>
{/if}

<style>
  .row { margin: 1.4rem 0; }
  .row-head {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    gap: 0.6rem;
    margin: 0 0 0.7rem;
  }
  h2 {
    font-size: 1rem;
    font-weight: 700;
    margin: 0;
  }
  .see-more {
    font-size: 0.8rem;
    font-weight: 600;
    color: var(--accent, #28e0a0);
    text-decoration: none;
    white-space: nowrap;
    flex: 0 0 auto;
  }
  .see-more:hover { text-decoration: underline; }
  .strip-wrap { position: relative; }
  .strip {
    display: flex;
    gap: 0.8rem;
    overflow-x: auto;
    padding-bottom: 0.5rem;
    scroll-snap-type: x mandatory;
    -webkit-overflow-scrolling: touch;
    scrollbar-width: none;
  }
  .strip::-webkit-scrollbar { display: none; }

  .arrow {
    position: absolute;
    top: calc(50% - 0.5rem);
    transform: translateY(-50%);
    z-index: 5;
    width: 40px;
    height: 40px;
    display: grid;
    place-items: center;
    border-radius: 999px;
    border: 1px solid var(--card-brd, rgba(255, 255, 255, 0.12));
    background: color-mix(in srgb, var(--surface, #1b1b1b) 86%, transparent);
    color: inherit;
    font-size: 1.5rem;
    line-height: 1;
    cursor: pointer;
    box-shadow: 0 4px 14px rgba(0, 0, 0, 0.35);
    opacity: 0;
    pointer-events: none;
    transition: opacity 0.15s ease, background 0.15s ease;
    backdrop-filter: blur(6px);
  }
  .arrow-l { left: -4px; }
  .arrow-r { right: -4px; }
  .arrow:hover { background: var(--surface, #1b1b1b); }
  /* Reveal arrows on hover/focus only when the row can scroll that direction. */
  .strip-wrap:hover .arrow:not(.hidden),
  .arrow:not(.hidden):focus-visible {
    opacity: 1;
    pointer-events: auto;
  }
  /* Hide arrows entirely on touch / coarse pointers and narrow screens — native
     swipe + scroll-snap handles those. */
  @media (hover: none), (pointer: coarse), (max-width: 640px) {
    .arrow { display: none; }
  }
  @media (prefers-reduced-motion: reduce) {
    .arrow { transition: none; }
  }
</style>
