<script lang="ts">
  import { _ } from 'svelte-i18n';
  import type { DiscoverItem, DiscoverDetail } from '$lib/server/consumer/types';

  // Mirrors PLEX_WEB_BASE from $lib/server/consumer/types (server-only module). Kept inline
  // so this client component stays out of the SvelteKit server-import guard.
  const PLEX_WEB_BASE = 'https://app.plex.tv/desktop/#!/server';

  let { item, onClose, onRequested }: {
    item: DiscoverItem | null;
    onClose: () => void;
    onRequested: () => void;
  } = $props();

  let detail = $state<DiscoverDetail | null>(null);
  let loading = $state(false);
  let busy = $state(false);
  let done = $state(false);
  let reqError = $state(false);
  // Audio preference for the request: 'original' (seerr's default profile) or 'ptbr' (the
  // Brazilian-Portuguese quality profile). Only meaningful for movies/series not yet on the server.
  let audio = $state<'original' | 'ptbr'>('original');

  // Report-a-problem composer state.
  let reportOpen = $state(false);
  let reportNote = $state('');
  let reportSending = $state(false);
  let reportSent = $state(false);
  let reportError = $state('');

  // Lazily fetch the rich detail whenever a new item opens. Falls back to the item's own
  // fields when there's no tmdbId or the fetch fails.
  $effect(() => {
    const current = item;
    detail = null;
    done = false;
    busy = false;
    reqError = false;
    loading = false;
    reportOpen = false;
    reportNote = '';
    reportSending = false;
    reportSent = false;
    reportError = '';
    if (!current) return;
    if (current.tmdbId == null) return;
    loading = true;
    const tmdbId = current.tmdbId;
    const mediaType = current.mediaType;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/app/detail?tmdbId=${tmdbId}&mediaType=${mediaType}`);
        if (!cancelled && res.ok) detail = await res.json();
      } catch {
        /* fall back to item fields */
      } finally {
        if (!cancelled) loading = false;
      }
    })();
    return () => { cancelled = true; };
  });

  // Resolved fields prefer the rich detail, then the item's own data.
  const title = $derived(detail?.title ?? item?.title ?? '');
  const year = $derived(detail?.year ?? item?.year);
  const overview = $derived(detail?.overview ?? item?.overview);
  const rating = $derived(detail?.rating ?? item?.rating);
  const poster = $derived(detail?.poster ?? item?.poster);
  const backdrop = $derived(detail?.backdrop);
  const genres = $derived(detail?.genres ?? []);
  const runtimeMin = $derived(detail?.runtimeMin);
  const available = $derived(detail ? detail.available : (item?.onServer ?? false));
  const onServer = $derived(item?.onServer ?? available);
  // Already requested but not yet available (seerr mediaInfo.status 1–4, or the detail's
  // 'Requested' label). Shown as a disabled "Requested (processing)" state — never "+ Request".
  const requested = $derived(
    !available && !onServer && (done || item?.requested === true || detail?.status === 'Requested')
  );

  const watchUrl = $derived(
    detail?.watchUrl ??
    item?.watchUrl ??
    (item?.source === 'plex' ? PLEX_WEB_BASE : undefined)
  );

  const statusLine = $derived(
    available
      ? $_('app.statusAvailable')
      : done
        ? $_('app.statusRequested')
        : detail?.status === 'Requested'
          ? $_('app.statusRequested')
          : $_('app.statusNotOnServer')
  );

  // A small, optional insights line built from the score / runtime / genres.
  const insights = $derived.by(() => {
    const out: string[] = [];
    if (rating != null && rating >= 7.5) out.push($_('app.insightHighlyRated'));
    if (runtimeMin) out.push($_('app.runtimeMin', { values: { n: runtimeMin } }));
    else if (genres.length) out.push(genres.slice(0, 2).join(' · '));
    return out;
  });

  async function request() {
    if (!item || item.tmdbId == null) return;
    busy = true;
    reqError = false;
    try {
      const res = await fetch('/api/app/request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tmdbId: item.tmdbId, mediaType: item.mediaType, audio })
      });
      if (res.ok) { done = true; onRequested(); }
      else reqError = true;
    } catch {
      reqError = true;
    } finally {
      busy = false;
    }
  }

  function watch() {
    if (watchUrl) window.open(watchUrl, '_blank', 'noopener');
  }

  async function sendReport() {
    if (reportSending) return;
    reportSending = true;
    reportError = '';
    const note = reportNote.trim();
    const body = note ? `Problem with "${title}": ${note}` : `Problem with "${title}"`;
    try {
      const r = await fetch('/api/app/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body })
      });
      if (!r.ok) { reportError = 'Could not send. Try again.'; return; }
      reportSent = true;
      reportNote = '';
      // Collapse the composer after a short delay.
      setTimeout(() => { reportOpen = false; reportSent = false; }, 2200);
    } catch {
      reportError = 'Could not send. Try again.';
    } finally {
      reportSending = false;
    }
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === 'Escape') onClose();
  }
</script>

<svelte:window onkeydown={item ? onKey : undefined} />

{#if item}
  <div class="backdrop-overlay" role="presentation" onclick={onClose}></div>
  <div class="modal" role="dialog" aria-modal="true" aria-label={title}>
    <button class="close" aria-label={$_('app.close')} onclick={onClose}>✕</button>

    <header class="hero" class:has-backdrop={!!backdrop}>
      {#if backdrop}
        <img class="hero-bg" src={backdrop} alt="" aria-hidden="true" />
      {/if}
      <div class="hero-scrim"></div>
      <div class="hero-content">
        {#if poster}
          <img class="hero-poster" src={poster} alt={title} />
        {/if}
        <div class="hero-meta">
          <span class="kind" data-type={item.mediaType}>
            {item.mediaType === 'tv' ? $_('app.tagSeries') : $_('app.tagMovie')}
          </span>
          <h2>{title}{year ? ` (${year})` : ''}</h2>
          {#if insights.length}
            <p class="insights">{insights.join(' • ')}</p>
          {/if}
        </div>
      </div>
    </header>

    <div class="body">
      {#if loading && !detail}
        <p class="loading">{$_('app.detailLoading')}</p>
      {/if}

      <div class="facts">
        {#if rating != null}
          <span class="fact score">⭐ {$_('app.scoreLabel', { values: { score: rating.toFixed(1) } })}</span>
        {/if}
        {#if runtimeMin}
          <span class="fact">{$_('app.runtimeMin', { values: { n: runtimeMin } })}</span>
        {/if}
      </div>

      {#if genres.length}
        <div class="chips" aria-label={$_('app.genresLabel')}>
          {#each genres as g}<span class="chip">{g}</span>{/each}
        </div>
      {/if}

      {#if overview}
        <p class="overview">{overview}</p>
      {/if}

      <p class="status" data-available={available}>{statusLine}</p>

      <div class="actions">
        {#if (available || onServer) && watchUrl}
          <button class="act act-watch" onclick={watch}>{$_('app.watch')}</button>
        {:else if requested}
          <button class="act act-requested" disabled>{$_('app.requestedProcessing')}</button>
        {:else if !available && !onServer}
          <div class="audio-toggle" role="group" aria-label={$_('app.audioLabel')}>
            <button
              type="button"
              class="audio-opt"
              class:sel={audio === 'ptbr'}
              onclick={() => (audio = 'ptbr')}
              disabled={busy}
            >🇧🇷 {$_('app.audioPtbr')}</button>
            <button
              type="button"
              class="audio-opt"
              class:sel={audio === 'original'}
              onclick={() => (audio = 'original')}
              disabled={busy}
            >{$_('app.audioOriginal')}</button>
          </div>
          <button class="act act-request" onclick={request} disabled={busy}>
            {busy ? $_('app.loading') : $_('app.request')}
          </button>
        {/if}
      </div>
      {#if reqError}<p class="req-error">{$_('app.requestError')}</p>{/if}

      <div class="report-section">
        {#if !reportOpen}
          <button class="report-trigger" onclick={() => { reportOpen = true; reportSent = false; reportError = ''; }}>
            Report a problem
          </button>
        {:else}
          <div class="report-composer">
            {#if reportSent}
              <p class="report-sent" role="status">✓ Sent to the admin</p>
            {:else}
              <form onsubmit={(e) => { e.preventDefault(); void sendReport(); }}>
                <textarea
                  bind:value={reportNote}
                  placeholder="What's wrong? (e.g. won't play, wrong audio)"
                  rows="2"
                  disabled={reportSending}
                  class="report-textarea"
                ></textarea>
                {#if reportError}
                  <p class="report-error" role="alert">{reportError}</p>
                {/if}
                <div class="report-actions">
                  <button type="button" class="report-cancel" onclick={() => { reportOpen = false; reportNote = ''; reportError = ''; }}>
                    Cancel
                  </button>
                  <button type="submit" class="report-send" disabled={reportSending}>
                    {reportSending ? 'Sending…' : 'Send'}
                  </button>
                </div>
              </form>
            {/if}
          </div>
        {/if}
      </div>
    </div>
  </div>
{/if}

<style>
  .backdrop-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.62);
    backdrop-filter: blur(3px);
    z-index: 50;
    animation: fade 0.18s ease;
  }
  .modal {
    position: fixed;
    z-index: 51;
    background: var(--surface, #14171e);
    color: var(--txt, #e7ecf3);
    overflow: hidden auto;
    -webkit-overflow-scrolling: touch;
  }
  /* Mobile-first: full-height bottom sheet. */
  .modal {
    left: 0;
    right: 0;
    bottom: 0;
    top: 8%;
    border-radius: 20px 20px 0 0;
    box-shadow: 0 -10px 40px rgba(0, 0, 0, 0.5);
    animation: slide-up 0.24s cubic-bezier(0.22, 1, 0.36, 1);
  }
  /* Desktop: centered modal card. */
  @media (min-width: 700px) {
    .modal {
      left: 50%;
      top: 50%;
      right: auto;
      bottom: auto;
      transform: translate(-50%, -50%);
      width: min(560px, 92vw);
      max-height: 88vh;
      border-radius: 18px;
      box-shadow: 0 30px 80px rgba(0, 0, 0, 0.6);
      animation: pop 0.2s cubic-bezier(0.22, 1, 0.36, 1);
    }
  }
  @keyframes fade { from { opacity: 0; } }
  @keyframes slide-up { from { transform: translateY(100%); } }
  @keyframes pop { from { transform: translate(-50%, -48%) scale(0.96); opacity: 0; } }
  @media (prefers-reduced-motion: reduce) {
    .backdrop-overlay, .modal { animation: none; }
  }

  .close {
    position: absolute;
    top: 12px;
    right: 12px;
    z-index: 3;
    width: 34px;
    height: 34px;
    border-radius: 999px;
    border: 0;
    background: rgba(10, 13, 19, 0.6);
    color: #fff;
    font-size: 0.95rem;
    cursor: pointer;
    display: grid;
    place-items: center;
    backdrop-filter: blur(6px);
  }
  .close:hover { background: rgba(10, 13, 19, 0.85); }

  .hero {
    position: relative;
    min-height: 168px;
    display: flex;
    align-items: flex-end;
    padding: 1rem;
    background: linear-gradient(160deg, color-mix(in srgb, var(--accent2, #36c6ff) 18%, transparent), transparent);
  }
  .hero-bg {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    object-fit: cover;
    z-index: 0;
  }
  .hero-scrim {
    position: absolute;
    inset: 0;
    z-index: 1;
    background:
      linear-gradient(0deg, var(--surface, #14171e) 2%, transparent 60%),
      linear-gradient(90deg, rgba(0, 0, 0, 0.55), transparent 70%);
  }
  .hero-content {
    position: relative;
    z-index: 2;
    display: flex;
    gap: 0.9rem;
    align-items: flex-end;
    width: 100%;
  }
  .hero-poster {
    width: 88px;
    aspect-ratio: 2 / 3;
    object-fit: cover;
    border-radius: 10px;
    flex: 0 0 auto;
    box-shadow: 0 6px 20px rgba(0, 0, 0, 0.5);
  }
  .hero-meta { min-width: 0; }
  .kind {
    display: inline-block;
    font-size: 0.62rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    padding: 2px 7px;
    border-radius: 6px;
    background: rgba(255, 255, 255, 0.12);
  }
  .kind[data-type='tv'] { color: var(--accent2, #36c6ff); }
  .kind[data-type='movie'] { color: var(--accent, #28e0a0); }
  .hero-meta h2 {
    font-size: 1.35rem;
    font-weight: 800;
    letter-spacing: -0.3px;
    margin: 0.4rem 0 0;
    text-shadow: 0 2px 12px rgba(0, 0, 0, 0.6);
  }
  .insights {
    margin: 0.3rem 0 0;
    font-size: 0.78rem;
    font-weight: 600;
    color: var(--accent, #28e0a0);
  }

  .body { padding: 1rem 1.1rem 1.4rem; }
  .loading { color: var(--sub, #8b95a7); font-size: 0.88rem; margin: 0 0 0.8rem; }
  .facts {
    display: flex;
    gap: 0.6rem;
    flex-wrap: wrap;
    margin-bottom: 0.7rem;
  }
  .fact {
    font-size: 0.82rem;
    font-weight: 600;
    color: var(--sub, #8b95a7);
  }
  .fact.score { color: #ffd34d; }
  .chips { display: flex; gap: 0.4rem; flex-wrap: wrap; margin-bottom: 0.8rem; }
  .chip {
    font-size: 0.72rem;
    font-weight: 600;
    padding: 3px 9px;
    border-radius: 999px;
    background: rgba(255, 255, 255, 0.06);
    border: 1px solid var(--card-brd, rgba(255, 255, 255, 0.08));
    color: var(--sub, #8b95a7);
  }
  .overview {
    font-size: 0.92rem;
    line-height: 1.5;
    margin: 0 0 0.9rem;
    color: var(--txt, #e7ecf3);
  }
  .status {
    font-size: 0.82rem;
    font-weight: 600;
    margin: 0 0 0.9rem;
    color: var(--sub, #8b95a7);
  }
  .status[data-available='true'] { color: var(--accent, #28e0a0); }
  .actions { display: flex; gap: 0.6rem; }
  .act {
    flex: 1;
    padding: 0.85rem;
    border-radius: 12px;
    border: 0;
    font-size: 0.95rem;
    font-weight: 700;
    cursor: pointer;
  }
  .act-watch {
    background: linear-gradient(135deg, var(--accent, #28e0a0), var(--accent2, #36c6ff));
    color: #08110d;
  }
  .act-request {
    background: rgba(255, 255, 255, 0.08);
    color: var(--txt, #e7ecf3);
    border: 1px solid var(--card-brd, rgba(255, 255, 255, 0.12));
  }
  .act-request:disabled { opacity: 0.7; cursor: default; }
  .act-requested {
    background: color-mix(in srgb, var(--accent2, #36c6ff) 14%, transparent);
    color: var(--accent2, #36c6ff);
    border: 1px solid color-mix(in srgb, var(--accent2, #36c6ff) 30%, transparent);
    cursor: default;
  }
  .act:hover:not(:disabled) { filter: brightness(1.06); }
  .req-error { color: #ff7a92; font-size: 0.82rem; margin: 0.6rem 0 0; }

  /* Audio (quality-profile) toggle shown above the Request button */
  .audio-toggle {
    display: inline-flex;
    gap: 0.25rem;
    padding: 0.25rem;
    margin-bottom: 0.6rem;
    background: rgba(255, 255, 255, 0.05);
    border: 1px solid var(--card-brd, rgba(255, 255, 255, 0.12));
    border-radius: 0.7rem;
  }
  .audio-opt {
    flex: 1;
    padding: 0.4rem 0.75rem;
    border: none;
    border-radius: 0.5rem;
    background: none;
    color: var(--sub, #8b95a7);
    font-size: 0.85rem;
    font-weight: 600;
    cursor: pointer;
    white-space: nowrap;
  }
  .audio-opt.sel {
    background: color-mix(in srgb, var(--accent2, #36c6ff) 16%, transparent);
    color: var(--accent2, #36c6ff);
  }
  .audio-opt:disabled { cursor: default; }

  /* Report a problem */
  .report-section { margin-top: 1rem; }
  .report-trigger {
    background: none;
    border: none;
    padding: 0;
    font-size: 0.8rem;
    color: var(--sub, #8b95a7);
    cursor: pointer;
    text-decoration: underline;
    text-decoration-style: dotted;
    text-underline-offset: 2px;
  }
  .report-trigger:hover { color: var(--txt, #e7ecf3); }
  .report-composer {
    background: rgba(255, 255, 255, 0.03);
    border: 1px solid var(--card-brd, rgba(255, 255, 255, 0.08));
    border-radius: 12px;
    padding: 0.75rem;
  }
  .report-textarea {
    width: 100%;
    box-sizing: border-box;
    padding: 0.6rem 0.75rem;
    border-radius: 10px;
    border: 1px solid var(--card-brd, rgba(255, 255, 255, 0.08));
    background: rgba(255, 255, 255, 0.04);
    color: var(--txt, #e7ecf3);
    font: inherit;
    /* >= 16px prevents iOS Safari zoom on focus */
    font-size: 16px;
    line-height: 1.45;
    resize: none;
    outline: none;
  }
  .report-textarea:focus {
    border-color: color-mix(in srgb, var(--accent, #28e0a0) 40%, transparent);
  }
  .report-error { color: #ff7a92; font-size: 0.78rem; margin: 0.35rem 0 0; }
  .report-actions {
    display: flex;
    justify-content: flex-end;
    gap: 0.5rem;
    margin-top: 0.55rem;
  }
  .report-cancel {
    background: none;
    border: 1px solid var(--card-brd, rgba(255, 255, 255, 0.12));
    border-radius: 8px;
    padding: 0.45rem 0.9rem;
    font-size: 0.82rem;
    font-weight: 600;
    color: var(--sub, #8b95a7);
    cursor: pointer;
  }
  .report-cancel:hover { color: var(--txt, #e7ecf3); border-color: rgba(255, 255, 255, 0.2); }
  .report-send {
    border: none;
    border-radius: 8px;
    padding: 0.45rem 0.9rem;
    font-size: 0.82rem;
    font-weight: 700;
    background: linear-gradient(135deg, var(--accent, #28e0a0), var(--accent2, #36c6ff));
    color: #08110d;
    cursor: pointer;
  }
  .report-send:disabled { opacity: 0.55; cursor: default; }
  .report-sent {
    font-size: 0.88rem;
    font-weight: 600;
    color: var(--accent, #28e0a0);
    margin: 0;
    text-align: center;
    padding: 0.35rem 0;
  }
</style>
