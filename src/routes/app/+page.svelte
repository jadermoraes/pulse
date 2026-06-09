<script lang="ts">
  import { onMount } from 'svelte';
  import { _ } from 'svelte-i18n';
  import { goto } from '$app/navigation';
  import DiscoverRow from '$lib/components/app/DiscoverRow.svelte';
  import PosterTile from '$lib/components/app/PosterTile.svelte';
  import MovieModal from '$lib/components/app/MovieModal.svelte';
  import { seeMoreUrl } from '$lib/consumer/seeMore';
  import type { DiscoverItem, DiscoverResult, ConsumerRequest } from '$lib/server/consumer/types';

  let displayName = $state<string | null>(null);
  let discover = $state<DiscoverResult | null>(null);
  let requests = $state<ConsumerRequest[]>([]);
  let selected = $state<DiscoverItem | null>(null);
  let links = $state<{ jellyfin: string | null; seerr: string | null }>({ jellyfin: null, seerr: null });

  // Search state — the top input is now a movie/show search box.
  let query = $state('');
  let searching = $state(false);
  let searched = $state(false); // a search (text or AI) has produced the current results
  let results = $state<DiscoverItem[]>([]);

  // AI vibe-search state.
  let aiOpen = $state(false);
  let aiQuery = $state('');
  let aiBusy = $state(false);
  let aiCapped = $state(false);
  let aiMode = $state(false); // current results came from the AI search (changes the header)

  async function load() {
    const [me, d, r, l] = await Promise.all([
      fetch('/api/app/me'),
      fetch('/api/app/discover'),
      fetch('/api/app/requests'),
      fetch('/api/app/links')
    ]);
    if (me.status === 401 || d.status === 401) { await goto('/app/login'); return; }
    if (me.ok) displayName = (await me.json()).displayName ?? null;
    discover = await d.json();
    if (r.ok) requests = await r.json();
    if (l.ok) links = await l.json();
  }

  function askAssistant() {
    goto(`/app/chat${query.trim() ? `?q=${encodeURIComponent(query.trim())}` : ''}`);
  }

  async function runSearch() {
    const q = query.trim();
    if (!q) { clearSearch(); return; }
    searching = true;
    aiMode = false;
    aiCapped = false;
    try {
      const res = await fetch(`/api/app/search?q=${encodeURIComponent(q)}`);
      results = res.ok ? await res.json() : [];
    } catch { results = []; }
    finally { searching = false; searched = true; }
  }

  async function runAiSearch() {
    const q = (aiQuery.trim() || query.trim());
    if (!q) return;
    aiBusy = true;
    aiCapped = false;
    try {
      const res = await fetch('/api/app/ai-search', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ q })
      });
      const data = res.ok ? await res.json() : { items: [] };
      if (data.blocked === 'cap') { aiCapped = true; results = []; }
      else { results = data.items ?? []; aiMode = true; }
    } catch { results = []; }
    finally { aiBusy = false; searched = true; }
  }

  function clearSearch() {
    query = '';
    results = [];
    searched = false;
    aiMode = false;
    aiCapped = false;
    aiOpen = false;
    aiQuery = '';
  }

  // Split search/AI results three ways by seerr-driven availability:
  //  • on-server (status 5) → Available now (Watch)
  //  • already requested / processing (status 1–4) → Requested (no "+ Request", not available)
  //  • everything else → requestable (+ Request)
  const availableResults = $derived(results.filter((i) => i.onServer));
  const requestedResults = $derived(results.filter((i) => !i.onServer && i.requested));
  const requestResults = $derived(results.filter((i) => !i.onServer && !i.requested));

  // Split a discover row into Movies / Series so the two are visually distinguishable.
  const newMovies = $derived(discover?.newOnServer.filter((i) => i.mediaType === 'movie') ?? []);
  const newSeries = $derived(discover?.newOnServer.filter((i) => i.mediaType === 'tv') ?? []);
  const hotMovies = $derived(discover?.hot.filter((i) => i.mediaType === 'movie') ?? []);
  const hotSeries = $derived(discover?.hot.filter((i) => i.mediaType === 'tv') ?? []);

  onMount(load);
</script>

<svelte:head><title>Pulse</title></svelte:head>

<div class="home">
  <header class="home-head">
    {#if displayName}
      <h1>{$_('app.hello', { values: { name: displayName } })}</h1>
    {/if}
    {#if links.jellyfin || links.seerr}
      <div class="hotlinks">
        {#if links.jellyfin}
          <a class="hotlink hotlink-watch" href={links.jellyfin} target="_blank" rel="noopener noreferrer">{$_('app.openJellyfin')} ▸</a>
        {/if}
        {#if links.seerr}
          <a class="hotlink" href={links.seerr} target="_blank" rel="noopener noreferrer">{$_('app.openSeerr')} ▸</a>
        {/if}
      </div>
    {/if}
  </header>

  <form class="search" onsubmit={(e) => { e.preventDefault(); runSearch(); }}>
    <div class="search-field">
      <span class="search-icon" aria-hidden="true">🔍</span>
      <input
        bind:value={query}
        placeholder={$_('app.searchPlaceholderHome')}
        aria-label={$_('app.searchSubmit')}
        autocomplete="off"
        oninput={() => { if (!query.trim()) clearSearch(); }}
      />
      {#if query.trim()}
        <button type="button" class="clear" aria-label={$_('app.searchClear')} onclick={clearSearch}>✕</button>
      {/if}
      <button type="submit" class="go" aria-label={$_('app.searchSubmit')} disabled={searching}>
        {#if searching}
          <span class="go-spin" aria-hidden="true"></span>
        {:else}
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14"/><path d="M13 6l6 6-6 6"/></svg>
        {/if}
      </button>
    </div>
    <div class="search-sub">
      <button type="button" class="ai-toggle" onclick={() => (aiOpen = !aiOpen)} aria-expanded={aiOpen}>
        {$_('app.aiSearchToggle')}
      </button>
      <button type="button" class="ask-btn" aria-label={$_('app.askCta')} onclick={askAssistant}>
        {$_('app.askCta')}
      </button>
    </div>
  </form>

  {#if aiOpen}
    <form class="ai-search" onsubmit={(e) => { e.preventDefault(); runAiSearch(); }}>
      <input
        bind:value={aiQuery}
        placeholder={$_('app.aiSearchPlaceholder')}
        aria-label={$_('app.aiSearchRun')}
        autocomplete="off"
      />
      <button type="submit" class="ai-run" disabled={aiBusy}>
        {aiBusy ? $_('app.aiSearching') : $_('app.aiSearchRun')}
      </button>
    </form>
  {/if}

  {#if searched || searching || aiBusy}
    <section class="results">
      {#if searching || aiBusy}
        <h2 class="results-head">{aiMode ? $_('app.aiPicks') : $_('app.resultsTitle')}</h2>
        <p class="results-empty">{aiBusy ? $_('app.aiSearching') : $_('app.loading')}</p>
      {:else if aiCapped}
        <p class="results-empty">{$_('app.aiCapReached')}</p>
      {:else if results.length}
        {#if availableResults.length}
          <h2 class="results-head accent">✓ {$_('app.availableNow')}</h2>
          <div class="results-grid">
            {#each availableResults as item (item.tmdbId ?? `${item.title}-${item.year ?? ''}`)}
              <PosterTile {item} onSelect={(i) => (selected = i)} />
            {/each}
          </div>
        {/if}
        {#if requestedResults.length}
          <h2 class="results-head">{$_('app.requestedProcessing')}</h2>
          <div class="results-grid">
            {#each requestedResults as item (item.tmdbId ?? `${item.title}-${item.year ?? ''}`)}
              <PosterTile {item} onSelect={(i) => (selected = i)} />
            {/each}
          </div>
        {/if}
        {#if requestResults.length}
          <h2 class="results-head">+ {$_('app.requestSection')}</h2>
          <div class="results-grid">
            {#each requestResults as item (item.tmdbId ?? `${item.title}-${item.year ?? ''}`)}
              <PosterTile {item} onSelect={(i) => (selected = i)} />
            {/each}
          </div>
        {/if}
      {:else}
        <h2 class="results-head">{aiMode ? $_('app.aiPicks') : $_('app.resultsTitle')}</h2>
        <p class="results-empty">{aiMode ? $_('app.aiNoPicks') : $_('app.noMatches')}</p>
      {/if}
    </section>
  {/if}

  {#if requests.length && !searched && !searching && !aiBusy}
    <section class="strip-head">
      <h2>{$_('app.requestStrip')}</h2>
      <a href="/app/requests">{$_('app.viewAllRequests')}</a>
    </section>
    <div class="req-strip">
      {#each requests.slice(0, 6) as r (r.id)}
        <span class="chip" data-status={r.status}>{r.title} · {r.status}</span>
      {/each}
    </div>
  {/if}

  {#if discover && !searched && !searching && !aiBusy}
    <DiscoverRow title={$_('app.continueWatching')} items={discover.continueWatching} onSelect={(i) => (selected = i)} />
    <DiscoverRow title={`${$_('app.newOnServer')} · ${$_('app.moviesRow')}`} items={newMovies} onSelect={(i) => (selected = i)} seeMoreUrl={seeMoreUrl(links, 'jellyfin', 'movie')} />
    <DiscoverRow title={`${$_('app.newOnServer')} · ${$_('app.seriesRow')}`} items={newSeries} onSelect={(i) => (selected = i)} seeMoreUrl={seeMoreUrl(links, 'jellyfin', 'tv')} />
    <DiscoverRow title={`${$_('app.hot')} · ${$_('app.moviesRow')}`} items={hotMovies} onSelect={(i) => (selected = i)} seeMoreUrl={seeMoreUrl(links, 'seerr', 'movie')} />
    <DiscoverRow title={`${$_('app.hot')} · ${$_('app.seriesRow')}`} items={hotSeries} onSelect={(i) => (selected = i)} seeMoreUrl={seeMoreUrl(links, 'seerr', 'tv')} />
  {/if}

  <MovieModal item={selected} onClose={() => (selected = null)} onRequested={load} />
</div>

<style>
  .home {
    padding: 1.1rem 1rem 1.5rem;
    max-width: 760px;
    margin: 0 auto;
    width: 100%;
  }
  .home-head {
    display: flex;
    justify-content: space-between;
    align-items: center;
    flex-wrap: wrap;
    gap: 0.6rem;
    margin-bottom: 1.1rem;
  }
  .home-head h1 {
    font-size: 1.4rem;
    font-weight: 700;
    letter-spacing: -0.3px;
    margin: 0;
  }
  .hotlinks { display: flex; gap: 0.5rem; flex-wrap: wrap; }
  .hotlink {
    font-size: 0.8rem;
    font-weight: 600;
    padding: 7px 14px;
    border-radius: 999px;
    color: var(--accent2, #36c6ff);
    background: color-mix(in srgb, var(--accent2, #36c6ff) 10%, transparent);
    border: 1px solid color-mix(in srgb, var(--accent2, #36c6ff) 24%, transparent);
    text-decoration: none;
    white-space: nowrap;
    transition: background 0.15s, transform 0.15s;
  }
  .hotlink:hover { background: color-mix(in srgb, var(--accent2, #36c6ff) 18%, transparent); transform: translateY(-1px); }
  .hotlink-watch {
    color: var(--accent, #28e0a0);
    background: color-mix(in srgb, var(--accent, #28e0a0) 11%, transparent);
    border-color: color-mix(in srgb, var(--accent, #28e0a0) 26%, transparent);
  }
  .hotlink-watch:hover { background: color-mix(in srgb, var(--accent, #28e0a0) 18%, transparent); }

  /* Search box: a prominent field with a leading icon and inline send button. */
  .search { margin-bottom: 1.3rem; }
  .search-field {
    position: relative;
    display: flex;
    align-items: center;
  }
  .search-icon {
    position: absolute;
    left: 1rem;
    font-size: 0.95rem;
    opacity: 0.6;
    pointer-events: none;
  }
  .search-field input {
    flex: 1;
    width: 100%;
    padding: 1rem 5.4rem 1rem 2.7rem;
    border-radius: 16px;
    border: 1px solid var(--card-brd, rgba(255, 255, 255, 0.08));
    background: rgba(255, 255, 255, 0.05);
    color: inherit;
    font-size: 1rem;
    outline: none;
    transition: border-color 0.15s, box-shadow 0.15s;
  }
  .search-field input:focus {
    border-color: color-mix(in srgb, var(--accent, #28e0a0) 55%, transparent);
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent, #28e0a0) 14%, transparent);
  }
  .search-field .clear {
    position: absolute;
    right: 3.1rem;
    width: 26px;
    height: 26px;
    border-radius: 999px;
    border: 0;
    background: rgba(255, 255, 255, 0.08);
    color: var(--sub, #8b95a7);
    font-size: 0.85rem;
    line-height: 1;
    cursor: pointer;
    display: grid;
    place-items: center;
  }
  .search-field .clear:hover { background: rgba(255, 255, 255, 0.14); }
  .search-field .go {
    position: absolute;
    right: 0.55rem;
    top: 50%;
    transform: translateY(-50%);
    width: 34px;
    height: 34px;
    border-radius: 10px;
    border: 1px solid color-mix(in srgb, var(--accent, #28e0a0) 30%, transparent);
    background: color-mix(in srgb, var(--accent, #28e0a0) 16%, transparent);
    color: var(--accent, #28e0a0);
    cursor: pointer;
    display: grid;
    place-items: center;
    padding: 0;
    transition: background 0.15s, border-color 0.15s;
  }
  .search-field .go svg { width: 17px; height: 17px; display: block; }
  .search-field .go:hover:not(:disabled) {
    background: color-mix(in srgb, var(--accent, #28e0a0) 26%, transparent);
    border-color: color-mix(in srgb, var(--accent, #28e0a0) 45%, transparent);
  }
  .search-field .go:disabled { opacity: 0.7; cursor: default; }
  .go-spin {
    width: 15px;
    height: 15px;
    border-radius: 50%;
    border: 2px solid color-mix(in srgb, var(--accent, #28e0a0) 30%, transparent);
    border-top-color: var(--accent, #28e0a0);
    animation: go-spin 0.7s linear infinite;
  }
  @keyframes go-spin { to { transform: rotate(360deg); } }
  @media (prefers-reduced-motion: reduce) { .go-spin { animation: none; } }

  .search-sub {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 0.7rem;
    flex-wrap: wrap;
    margin-top: 0.7rem;
    padding: 0 0.2rem;
  }
  .ai-toggle {
    background: none;
    border: 0;
    padding: 0;
    color: var(--accent2, #36c6ff);
    font-size: 0.82rem;
    font-weight: 600;
    cursor: pointer;
    text-align: left;
  }
  .ai-toggle:hover { text-decoration: underline; }
  .ask-btn {
    padding: 0.5rem 0.95rem;
    border-radius: 999px;
    border: 1px solid var(--card-brd, rgba(255, 255, 255, 0.12));
    background: rgba(255, 255, 255, 0.05);
    color: inherit;
    font-size: 0.82rem;
    font-weight: 600;
    cursor: pointer;
    white-space: nowrap;
    transition: background 0.15s;
  }
  .ask-btn:hover { background: rgba(255, 255, 255, 0.1); }

  .ai-search { display: flex; gap: 0.5rem; margin: 0 0 1.3rem; }
  .ai-search input {
    flex: 1;
    min-width: 0;
    padding: 0.75rem 0.9rem;
    border-radius: 12px;
    border: 1px solid color-mix(in srgb, var(--accent2, #36c6ff) 30%, transparent);
    background: color-mix(in srgb, var(--accent2, #36c6ff) 6%, transparent);
    color: inherit;
    font-size: 0.9rem;
    outline: none;
  }
  .ai-search .ai-run {
    padding: 0.75rem 1rem;
    border-radius: 12px;
    border: 0;
    font-weight: 700;
    font-size: 0.85rem;
    background: linear-gradient(135deg, var(--accent2, #36c6ff), var(--accent, #28e0a0));
    color: #08110d;
    cursor: pointer;
    white-space: nowrap;
  }
  .ai-search .ai-run:disabled { opacity: 0.7; cursor: default; }

  .results { margin-bottom: 1.4rem; }
  .results-head { font-size: 1rem; font-weight: 700; margin: 0 0 0.8rem; }
  .results-head.accent { color: var(--accent, #28e0a0); }
  .results-head:not(:first-child) { margin-top: 1.5rem; }
  .results-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(124px, 1fr));
    gap: 0.9rem;
  }
  .results-empty { color: var(--sub, #8b95a7); font-size: 0.9rem; margin: 0.4rem 0; }
  .strip-head {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    margin-top: 0.5rem;
  }
  .strip-head h2 { font-size: 1rem; font-weight: 700; margin: 0; }
  .strip-head a { font-size: 0.82rem; color: var(--accent, #28e0a0); text-decoration: none; }
  .req-strip {
    display: flex;
    gap: 0.5rem;
    overflow-x: auto;
    margin: 0.6rem 0 1rem;
    padding-bottom: 0.3rem;
    scrollbar-width: none;
  }
  .req-strip::-webkit-scrollbar { display: none; }
  .chip {
    flex: 0 0 auto;
    font-size: 0.78rem;
    padding: 0.4rem 0.7rem;
    border-radius: 999px;
    background: rgba(255, 255, 255, 0.06);
    border: 1px solid var(--card-brd, rgba(255, 255, 255, 0.08));
    white-space: nowrap;
  }
  .chip[data-status='available'] { background: color-mix(in srgb, var(--accent, #28e0a0) 16%, transparent); color: var(--accent, #28e0a0); }
  .chip[data-status='declined'] { background: rgba(255, 92, 122, 0.12); color: #ff7a92; }
</style>
