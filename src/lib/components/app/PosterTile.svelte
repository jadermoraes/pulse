<script lang="ts">
  import { _ } from 'svelte-i18n';
  import type { DiscoverItem } from '$lib/server/consumer/types';

  let { item, onSelect }: { item: DiscoverItem; onSelect: (i: DiscoverItem) => void } = $props();

  // Track whether the poster image failed to load so we can swap in a graceful
  // text placeholder instead of a collapsed broken-image icon.
  let broken = $state(false);
  $effect(() => {
    // Reset the broken flag whenever the item (and therefore the poster URL) changes.
    void item.poster;
    broken = false;
  });

  const typeLabel = $derived(item.mediaType === 'tv' ? $_('app.tagSeries') : $_('app.tagMovie'));
</script>

<button class="poster-tile" onclick={() => onSelect(item)} title={item.title}>
  <div class="art">
    {#if item.poster && !broken}
      <img src={item.poster} alt={item.title} loading="lazy" onerror={() => (broken = true)} />
    {:else}
      <div class="art-fallback"><span>{item.title}</span></div>
    {/if}
    <span class="type-tag" data-type={item.mediaType}>{typeLabel}</span>
    {#if item.rating}<span class="score-badge">⭐ {item.rating.toFixed(1)}</span>{/if}
  </div>
  <span class="ttl">{item.title}</span>
  {#if item.year}<span class="yr">{item.year}</span>{/if}
</button>

<style>
  .poster-tile {
    flex: 0 0 auto;
    width: 124px;
    background: none;
    border: 0;
    padding: 0;
    margin: 0;
    cursor: pointer;
    text-align: left;
    color: inherit;
    scroll-snap-align: start;
    transition: transform 0.16s ease;
  }
  .poster-tile:hover { transform: translateY(-3px); }
  @media (prefers-reduced-motion: reduce) {
    .poster-tile { transition: none; }
  }
  .art {
    position: relative;
    width: 100%;
    aspect-ratio: 2 / 3;
    border-radius: 12px;
    overflow: hidden;
    background: var(--card, rgba(255, 255, 255, 0.05));
    border: 1px solid var(--card-brd, rgba(255, 255, 255, 0.08));
    box-shadow: 0 6px 18px rgba(0, 0, 0, 0.3);
  }
  .art img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
  }
  .art-fallback {
    width: 100%;
    height: 100%;
    display: grid;
    place-items: center;
    padding: 0.6rem;
    text-align: center;
    background: linear-gradient(160deg, color-mix(in srgb, var(--accent2, #36c6ff) 14%, transparent), transparent);
  }
  .art-fallback span {
    font-size: 0.78rem;
    font-weight: 600;
    color: var(--sub, #8b95a7);
    display: -webkit-box;
    -webkit-line-clamp: 4;
    line-clamp: 4;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .type-tag {
    position: absolute;
    top: 6px;
    left: 6px;
    font-size: 9px;
    font-weight: 700;
    letter-spacing: 0.4px;
    text-transform: uppercase;
    padding: 3px 6px;
    border-radius: 6px;
    background: rgba(10, 13, 19, 0.78);
    color: #fff;
    backdrop-filter: blur(4px);
  }
  .type-tag[data-type='tv'] { color: var(--accent2, #36c6ff); }
  .type-tag[data-type='movie'] { color: var(--accent, #28e0a0); }
  .score-badge {
    position: absolute;
    top: 6px;
    right: 6px;
    font-size: 9px;
    font-weight: 700;
    letter-spacing: 0.2px;
    padding: 3px 6px;
    border-radius: 6px;
    background: rgba(10, 13, 19, 0.78);
    color: #ffd34d;
    backdrop-filter: blur(4px);
  }
  .ttl {
    display: block;
    font-size: 0.78rem;
    font-weight: 600;
    margin-top: 0.4rem;
    line-height: 1.25;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .yr {
    display: block;
    font-size: 0.72rem;
    color: var(--sub, #8b95a7);
    margin-top: 1px;
  }
</style>
