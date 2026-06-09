<script lang="ts">
  import type { DrawerItem } from './drawer-types';
  import type { MediaDetail, DetailAction } from '$lib/server/integrations/types';
  import { artClass } from '$lib/art';
  import { _ } from 'svelte-i18n';
  import { get } from 'svelte/store';

  let {
    item = $bindable<DrawerItem | null>(null),
    open = $bindable(false)
  }: {
    item?: DrawerItem | null;
    open?: boolean;
  } = $props();

  let actionMsg = $state('');
  let busy = $state(false);

  const tDone = () => get(_)('drawer.done');
  const tOpened = () => get(_)('drawer.opened');
  const tFailed = (status: number) => get(_)('drawer.failed', { values: { status } });

  // Rich-detail state
  let detail = $state<MediaDetail | null>(null);
  let detailLoading = $state(false);
  let detailFailed = $state(false);
  let posterError = $state(false);

  function close() {
    open = false;
    actionMsg = '';
  }

  // Kinds that carry a server-side `detail`. download/container fall back to static actions.
  const DETAILABLE = new Set(['request', 'movie', 'series', 'episode']);
  function hasDetail(it: DrawerItem): boolean {
    return it.connectionId != null && DETAILABLE.has(it.kind?.toLowerCase());
  }

  function detailUrl(it: DrawerItem): string {
    const q = new URLSearchParams();
    q.set('kind', it.kind ?? '');
    for (const [k, v] of Object.entries(it.params ?? {})) {
      if (v != null) q.set(k, String(v));
    }
    return `/api/detail/${it.connectionId}?${q.toString()}`;
  }

  async function loadDetail(it: DrawerItem) {
    detail = null;
    detailFailed = false;
    posterError = false;
    if (!hasDetail(it)) return;
    detailLoading = true;
    try {
      const res = await fetch(detailUrl(it));
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      detail = (await res.json()) as MediaDetail;
    } catch {
      detailFailed = true; // drawer renders a minimal fallback, never throws
    } finally {
      detailLoading = false;
    }
  }

  // Re-fetch detail whenever the drawer opens for a new detailable item.
  let lastKey = $state('');
  $effect(() => {
    if (!open || !item) return;
    const key = `${item.connectionId}:${item.kind}:${item.id}`;
    if (key === lastKey) return;
    lastKey = key;
    actionMsg = '';
    loadDetail(item);
  });

  // ---- static (download/container) action descriptors --------------------
  type Act = { cls: string; label: string; docker?: string; actionId?: string; deepLink?: boolean };

  function staticActionsFor(it: DrawerItem): Act[] {
    const t = get(_);
    switch (it.kind?.toLowerCase()) {
      case 'download':
        return [
          { cls: 'btn-p', label: t('drawer.pause'), actionId: 'pause' },
          { cls: 'btn-s', label: t('drawer.resume'), actionId: 'resume' },
          { cls: 'btn-d', label: t('drawer.removeDelete'), actionId: 'delete' }
        ];
      case 'container':
        return [
          { cls: 'btn-p', label: t('drawer.restart'), docker: 'restart' },
          { cls: 'btn-s', label: t('drawer.stop'), docker: 'stop' },
          { cls: 'btn-s', label: t('drawer.viewLogs'), docker: 'logs' }
        ];
      default:
        return [{ cls: 'btn-s', label: t('drawer.viewDetails') }];
    }
  }

  // Map a DetailAction.variant → button class.
  function variantClass(v?: string): string {
    return v === 'p' ? 'btn-p' : v === 'd' ? 'btn-d' : 'btn-s';
  }

  // ---- dispatch ----------------------------------------------------------
  async function runStaticAction(act: Act) {
    if (!item || busy) return;
    busy = true;
    actionMsg = '…';
    try {
      if (act.docker) {
        const res = await fetch(`/api/docker/containers/${encodeURIComponent(item.id)}/${act.docker}`, { method: 'POST' });
        const body = await res.json().catch(() => ({}));
        actionMsg = body.error ?? body.message ?? (res.ok ? tDone() : tFailed(res.status));
      } else if (act.actionId && item.connectionId != null) {
        const res = await fetch(`/api/actions/${item.connectionId}/${act.actionId}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(item.params ?? {})
        });
        const body = await res.json().catch(() => ({}));
        if (act.deepLink && body.ok && body.url) {
          window.open(body.url, '_blank', 'noopener');
          actionMsg = tOpened();
        } else {
          actionMsg = body.message ?? (body.ok ? tDone() : tFailed(res.status));
        }
      } else {
        actionMsg = '';
      }
    } catch (e) {
      actionMsg = (e as Error).message;
    } finally {
      busy = false;
    }
  }

  async function runDetailAction(act: DetailAction) {
    if (!item || busy) return;
    busy = true;
    actionMsg = '…';
    let mutated = false;
    try {
      if (act.kind === 'docker') {
        const res = await fetch(`/api/docker/containers/${encodeURIComponent(item.id)}/${act.dockerAction}`, { method: 'POST' });
        const body = await res.json().catch(() => ({}));
        actionMsg = body.error ?? body.message ?? (res.ok ? tDone() : tFailed(res.status));
        mutated = res.ok;
      } else if ((act.kind === 'action' || act.kind === 'deeplink') && act.actionId && item.connectionId != null) {
        const res = await fetch(`/api/actions/${item.connectionId}/${act.actionId}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(act.params ?? {})
        });
        const body = await res.json().catch(() => ({}));
        if (act.kind === 'deeplink' && body.ok && body.url) {
          window.open(body.url, '_blank', 'noopener');
          actionMsg = tOpened();
        } else {
          actionMsg = body.message ?? (body.ok ? tDone() : tFailed(res.status));
          mutated = !!body.ok;
        }
      }
    } catch (e) {
      actionMsg = (e as Error).message;
    } finally {
      busy = false;
    }
    // Refresh detail after a successful mutation so the status stays accurate.
    if (mutated && item && hasDetail(item)) {
      lastKey = ''; // force re-fetch
      await loadDetail(item);
      lastKey = `${item.connectionId}:${item.kind}:${item.id}`;
    }
  }

  function fmtRuntime(min?: number): string {
    if (!min || min <= 0) return '';
    return get(_)('drawer.minutes', { values: { min } });
  }
  function pillState(s?: string): string {
    if (s === 'ok') return 'ok';
    if (s === 'bad') return 'bad';
    if (s === 'idle') return 'idle';
    return 'proc';
  }
</script>

<div
  class="scrim"
  class:open
  role="button"
  tabindex="-1"
  aria-label={$_('drawer.closePanel')}
  onclick={close}
  onkeydown={(e) => e.key === 'Escape' && close()}
></div>

<aside class="drawer" class:open aria-label={$_('drawer.itemDetail')}>
  <button class="close" onclick={close} aria-label={$_('drawer.close')}>✕</button>

  {#if item}
    {#if hasDetail(item) && !detailFailed}
      <!-- Rich media detail -->
      {#if detail?.poster && !posterError}
        <div class="dposter">
          <img src={detail.poster} alt={detail.title} onerror={() => (posterError = true)} />
        </div>
      {:else}
        <div class="dart {item.artClass ?? artClass(item.id)}"></div>
      {/if}

      <h2>{detail?.title ?? item.title}</h2>

      <div class="meta">
        {#if detail}
          {detail.status.state === 'idle' && detail.releaseDate
            ? $_('drawer.releases', { values: { date: detail.releaseDate.slice(0, 10) } })
            : (detail.year ?? '')}
          <span class="pill {pillState(detail.status.state)}">{detail.status.label}</span>
        {:else if detailLoading}
          {$_('drawer.loading')}
        {:else}
          {item.kind}{item.year ? ` · ${item.year}` : ''}
        {/if}
      </div>

      {#if detail}
        <div class="metarow">
          {#if detail.runtimeMin}<span class="chip">{fmtRuntime(detail.runtimeMin)}</span>{/if}
          {#if detail.rating != null}<span class="chip">★ {detail.rating.toFixed(1)}</span>{/if}
          {#if detail.releaseDate}<span class="chip">{detail.releaseDate.slice(0, 10)}</span>{/if}
          {#each (detail.genres ?? []).slice(0, 2) as g}<span class="chip">{g}</span>{/each}
        </div>

        {#if detail.overview}
          <p>{detail.overview}</p>
        {/if}

        {#if detail.imdbUrl}
          <a class="imdb" href={detail.imdbUrl} target="_blank" rel="noopener noreferrer">IMDb ↗</a>
        {/if}

        <div class="acts">
          {#each detail.actions as act (act.id)}
            <button class="btn {variantClass(act.variant)}" disabled={busy} onclick={() => runDetailAction(act)}>
              {act.icon ? `${act.icon}  ` : ''}{act.label}
            </button>
          {/each}
        </div>
      {:else if detailLoading}
        <p class="dim">{$_('drawer.loadingDetails')}</p>
      {/if}
    {:else}
      <!-- Fallback: static actions (download/container, or a failed detail fetch) -->
      <div class="dart {item.artClass ?? artClass(item.id)}"></div>
      <h2>{item.title}</h2>
      <div class="meta">
        {item.kind}{item.year ? ` · ${item.year}` : ''}
        {#if item.status}&nbsp;<span class="pill ok">{item.status}</span>{/if}
      </div>
      {#if item.meta}<p class="submeta">{item.meta}</p>{/if}
      {#if item.description}
        <p>{item.description}</p>
      {/if}

      <div class="acts">
        {#each staticActionsFor(item) as act}
          <button class="btn {act.cls}" disabled={busy} onclick={() => runStaticAction(act)}>{act.label}</button>
        {/each}
      </div>
    {/if}

    {#if actionMsg}<p class="action-msg">{actionMsg}</p>{/if}
  {/if}
</aside>

<style>
  .submeta { color: var(--sub); font-size: 13px; margin-top: 2px; }
  .action-msg { color: var(--sub); font-size: 12px; margin-top: 10px; }
  .dim { color: var(--sub); font-size: 13px; }
  .btn[disabled] { opacity: 0.5; cursor: default; }

  /* Real poster: keep the same rounded "DVD cover" feel as .dart */
  .dposter {
    height: 280px;
    border-radius: 14px;
    margin-bottom: 18px;
    overflow: hidden;
    background: rgba(255, 255, 255, 0.04);
  }
  .dposter img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
  }

  .metarow {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin: 0 0 14px;
  }
  .chip {
    font-size: 11px;
    color: var(--sub);
    background: rgba(255, 255, 255, 0.05);
    border: 1px solid var(--card-brd);
    border-radius: 99px;
    padding: 3px 9px;
  }

  .imdb {
    display: inline-block;
    margin-bottom: 16px;
    font-size: 12.5px;
    font-weight: 600;
    color: #f5c518;
  }

  /* status-pill variants not already in app.css */
  .pill.bad { background: rgba(255, 92, 122, 0.16); color: #ff7a92; }
  .pill.idle { background: rgba(255, 255, 255, 0.08); color: var(--sub); }
</style>
