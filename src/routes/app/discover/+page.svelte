<script lang="ts">
  import { onMount } from 'svelte';
  import { _ } from 'svelte-i18n';
  import { goto } from '$app/navigation';
  import DiscoverRow from '$lib/components/app/DiscoverRow.svelte';
  import MovieModal from '$lib/components/app/MovieModal.svelte';
  import { seeMoreUrl } from '$lib/consumer/seeMore';
  import type { DiscoverItem, DiscoverResult } from '$lib/server/consumer/types';

  let discover = $state<DiscoverResult | null>(null);
  let q = $state('');
  let results = $state<DiscoverItem[] | null>(null);
  let selected = $state<DiscoverItem | null>(null);
  let links = $state<{ jellyfin: string | null; seerr: string | null }>({ jellyfin: null, seerr: null });

  async function load() {
    const [d, l] = await Promise.all([fetch('/api/app/discover'), fetch('/api/app/links')]);
    if (d.status === 401) { await goto('/app/login'); return; }
    discover = await d.json();
    if (l.ok) links = await l.json();
  }
  async function search() {
    const term = q.trim();
    if (!term) { results = null; return; }
    const r = await fetch(`/api/app/search?q=${encodeURIComponent(term)}`);
    results = r.ok ? await r.json() : [];
  }

  const resultMovies = $derived(results?.filter((i) => i.mediaType === 'movie') ?? []);
  const resultSeries = $derived(results?.filter((i) => i.mediaType === 'tv') ?? []);
  const newMovies = $derived(discover?.newOnServer.filter((i) => i.mediaType === 'movie') ?? []);
  const newSeries = $derived(discover?.newOnServer.filter((i) => i.mediaType === 'tv') ?? []);
  const hotMovies = $derived(discover?.hot.filter((i) => i.mediaType === 'movie') ?? []);
  const hotSeries = $derived(discover?.hot.filter((i) => i.mediaType === 'tv') ?? []);

  onMount(load);
</script>

<svelte:head><title>Discover · Pulse</title></svelte:head>

<div class="page">
  <form class="search" onsubmit={(e) => { e.preventDefault(); search(); }}>
    <input bind:value={q} placeholder={$_('app.searchPlaceholder')} oninput={() => { if (!q.trim()) results = null; }} />
  </form>

  {#if results !== null}
    {#if results.length}
      <DiscoverRow title={`${$_('app.discoverTitle')} · ${$_('app.moviesRow')}`} items={resultMovies} onSelect={(i) => (selected = i)} />
      <DiscoverRow title={`${$_('app.discoverTitle')} · ${$_('app.seriesRow')}`} items={resultSeries} onSelect={(i) => (selected = i)} />
    {:else}
      <p class="empty">{$_('app.noResults')}</p>
    {/if}
  {:else if discover}
    <DiscoverRow title={`${$_('app.newOnServer')} · ${$_('app.moviesRow')}`} items={newMovies} onSelect={(i) => (selected = i)} seeMoreUrl={seeMoreUrl(links, 'jellyfin', 'movie')} />
    <DiscoverRow title={`${$_('app.newOnServer')} · ${$_('app.seriesRow')}`} items={newSeries} onSelect={(i) => (selected = i)} seeMoreUrl={seeMoreUrl(links, 'jellyfin', 'tv')} />
    <DiscoverRow title={`${$_('app.hot')} · ${$_('app.moviesRow')}`} items={hotMovies} onSelect={(i) => (selected = i)} seeMoreUrl={seeMoreUrl(links, 'seerr', 'movie')} />
    <DiscoverRow title={`${$_('app.hot')} · ${$_('app.seriesRow')}`} items={hotSeries} onSelect={(i) => (selected = i)} seeMoreUrl={seeMoreUrl(links, 'seerr', 'tv')} />
  {/if}

  <MovieModal item={selected} onClose={() => (selected = null)} onRequested={load} />
</div>

<style>
  .page { padding: 1.1rem 1rem 1.5rem; max-width: 760px; margin: 0 auto; width: 100%; }
  .search input {
    width: 100%;
    padding: 0.8rem 0.9rem;
    border-radius: 12px;
    border: 1px solid var(--card-brd, rgba(255, 255, 255, 0.08));
    background: rgba(255, 255, 255, 0.05);
    color: inherit;
    font-size: 0.95rem;
    margin-bottom: 0.5rem;
    outline: none;
  }
  .search input:focus { border-color: color-mix(in srgb, var(--accent, #28e0a0) 50%, transparent); }
  .empty { opacity: 0.7; text-align: center; padding: 2rem; }
</style>
