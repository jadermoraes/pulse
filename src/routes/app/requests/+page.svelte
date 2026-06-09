<script lang="ts">
  import { onMount } from 'svelte';
  import { _ } from 'svelte-i18n';
  import { goto } from '$app/navigation';
  import MovieModal from '$lib/components/app/MovieModal.svelte';
  import type { ConsumerRequest, DiscoverItem, DiscoverDetail } from '$lib/server/consumer/types';

  let requests = $state<ConsumerRequest[] | null>(null);
  let selected = $state<DiscoverItem | null>(null);
  // Lazily-fetched poster/watch detail, keyed by `${mediaType}:${tmdbId}`.
  let details = $state<Record<string, DiscoverDetail>>({});

  async function load() {
    const r = await fetch('/api/app/requests');
    if (r.status === 401) { await goto('/app/login'); return; }
    requests = await r.json();
    // Hydrate posters/watch links in the background; failures just leave a text fallback.
    for (const req of requests ?? []) hydrate(req);
  }

  async function hydrate(req: ConsumerRequest) {
    const key = `${req.mediaType}:${req.tmdbId}`;
    if (details[key]) return;
    try {
      const res = await fetch(`/api/app/detail?tmdbId=${req.tmdbId}&mediaType=${req.mediaType}`);
      if (res.ok) details = { ...details, [key]: await res.json() };
    } catch { /* leave fallback */ }
  }

  function detailFor(req: ConsumerRequest): DiscoverDetail | undefined {
    return details[`${req.mediaType}:${req.tmdbId}`];
  }

  // Turn a tracked request into the DiscoverItem shape the modal consumes.
  function toItem(req: ConsumerRequest): DiscoverItem {
    const d = detailFor(req);
    return {
      source: 'seerr',
      title: req.title,
      year: d?.year,
      poster: d?.poster,
      tmdbId: req.tmdbId,
      mediaType: req.mediaType,
      onServer: req.status === 'available',
      watchUrl: d?.watchUrl,
      released: true,
      requested: req.status !== 'available'
    };
  }

  // Map our 5 statuses → a friendly label + badge tone.
  function badge(status: ConsumerRequest['status']): { key: string; tone: string } {
    switch (status) {
      case 'available': return { key: 'app.reqStatusAvailable', tone: 'available' };
      case 'declined': return { key: 'app.reqStatusDeclined', tone: 'declined' };
      case 'pending': return { key: 'app.reqStatusPending', tone: 'pending' };
      case 'approved':
      case 'processing':
      default: return { key: 'app.reqStatusProcessing', tone: 'processing' };
    }
  }

  function open(req: ConsumerRequest) { selected = toItem(req); }
  function onKey(e: KeyboardEvent, req: ConsumerRequest) {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(req); }
  }

  onMount(load);
</script>

<svelte:head><title>My Requests · Pulse</title></svelte:head>

<div class="page">
  <h1>{$_('app.requestsTitle')}</h1>

  {#if requests && requests.length}
    <ul class="cards">
      {#each requests as r (r.id)}
        {@const d = detailFor(r)}
        {@const b = badge(r.status)}
        <li class="card" data-status={r.status}>
          <button class="card-btn" type="button" onclick={() => open(r)} onkeydown={(e) => onKey(e, r)}>
            <span class="poster">
              {#if d?.poster}
                <img src={d.poster} alt={r.title} loading="lazy" />
              {:else}
                <span class="poster-fallback" aria-hidden="true">
                  {r.mediaType === 'tv' ? $_('app.tagSeries') : $_('app.tagMovie')}
                </span>
              {/if}
            </span>
            <span class="meta">
              <span class="title">{r.title}</span>
              {#if d?.year}<span class="year">{d.year}</span>{/if}
              <span class="badge" data-tone={b.tone}>{$_(b.key)}</span>
            </span>
          </button>
          {#if r.status === 'available' && d?.watchUrl}
            <a
              class="watch"
              href={d.watchUrl}
              target="_blank"
              rel="noopener noreferrer"
            >{$_('app.watch')}</a>
          {/if}
        </li>
      {/each}
    </ul>
  {:else if requests}
    <div class="empty">
      <p class="empty-title">{$_('app.requestsEmptyTitle')}</p>
      <a class="empty-cta" href="/app/discover">{$_('app.requestsEmptyCta')} ▸</a>
    </div>
  {/if}

  <MovieModal item={selected} onClose={() => (selected = null)} onRequested={load} />
</div>

<style>
  .page { padding: 1.1rem 1rem 1.5rem; max-width: 720px; margin: 0 auto; width: 100%; }
  h1 { font-size: 1.4rem; font-weight: 700; letter-spacing: -0.3px; margin: 0 0 1.1rem; }

  .cards { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 0.7rem; }
  .card {
    display: flex;
    align-items: center;
    gap: 0.7rem;
    padding: 0.7rem;
    border-radius: 14px;
    background: var(--card, rgba(255, 255, 255, 0.04));
    border: 1px solid var(--card-brd, rgba(255, 255, 255, 0.08));
    transition: transform 0.15s, border-color 0.15s, background 0.15s;
  }
  .card:hover {
    transform: translateY(-1px);
    border-color: color-mix(in srgb, var(--accent, #28e0a0) 30%, transparent);
    background: rgba(255, 255, 255, 0.06);
  }
  .card:focus-within {
    outline: 2px solid var(--accent, #28e0a0);
    outline-offset: 2px;
  }
  @media (prefers-reduced-motion: reduce) { .card { transition: none; } }

  .card-btn {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 0.85rem;
    background: none;
    border: 0;
    padding: 0;
    margin: 0;
    color: inherit;
    text-align: left;
    cursor: pointer;
  }
  .card-btn:focus-visible { outline: none; }

  .poster {
    flex: 0 0 auto;
    display: block;
    width: 52px;
    aspect-ratio: 2 / 3;
    border-radius: 8px;
    overflow: hidden;
    background: rgba(255, 255, 255, 0.05);
  }
  .poster img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .poster-fallback {
    width: 100%;
    height: 100%;
    display: grid;
    place-items: center;
    font-size: 0.58rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.4px;
    color: var(--sub, #8b95a7);
    text-align: center;
    padding: 0.2rem;
  }

  .meta { display: flex; flex-direction: column; gap: 0.25rem; min-width: 0; flex: 1; }
  .title {
    font-size: 0.95rem;
    font-weight: 700;
    line-height: 1.2;
    overflow: hidden;
    text-overflow: ellipsis;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
  }
  .year { font-size: 0.75rem; color: var(--sub, #8b95a7); }
  .badge {
    align-self: flex-start;
    margin-top: 0.1rem;
    font-size: 0.68rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.3px;
    padding: 3px 9px;
    border-radius: 999px;
    background: rgba(255, 255, 255, 0.08);
    color: var(--sub, #8b95a7);
  }
  .badge[data-tone='available'] {
    background: color-mix(in srgb, var(--accent, #28e0a0) 16%, transparent);
    color: var(--accent, #28e0a0);
  }
  .badge[data-tone='processing'] {
    background: color-mix(in srgb, var(--accent2, #36c6ff) 15%, transparent);
    color: var(--accent2, #36c6ff);
  }
  .badge[data-tone='pending'] {
    background: rgba(255, 200, 80, 0.14);
    color: #ffce5c;
  }
  .badge[data-tone='declined'] {
    background: rgba(255, 92, 122, 0.14);
    color: #ff7a92;
  }

  .watch {
    flex: 0 0 auto;
    font-size: 0.8rem;
    font-weight: 700;
    padding: 0.5rem 0.85rem;
    border-radius: 10px;
    text-decoration: none;
    color: #08110d;
    background: linear-gradient(135deg, var(--accent, #28e0a0), var(--accent2, #36c6ff));
    white-space: nowrap;
  }
  .watch:hover { filter: brightness(1.06); }

  .empty {
    text-align: center;
    padding: 3rem 1rem;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.9rem;
  }
  .empty-title { font-size: 1rem; color: var(--sub, #8b95a7); margin: 0; }
  .empty-cta {
    font-size: 0.88rem;
    font-weight: 700;
    padding: 0.6rem 1.2rem;
    border-radius: 999px;
    text-decoration: none;
    color: var(--accent, #28e0a0);
    background: color-mix(in srgb, var(--accent, #28e0a0) 12%, transparent);
    border: 1px solid color-mix(in srgb, var(--accent, #28e0a0) 28%, transparent);
  }
  .empty-cta:hover { background: color-mix(in srgb, var(--accent, #28e0a0) 20%, transparent); }
</style>
