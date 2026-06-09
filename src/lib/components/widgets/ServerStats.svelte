<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { browser as isBrowser } from '$app/environment';
  import { _ } from 'svelte-i18n';

  let { onOpen, proxmoxConnId = null }: {
    onOpen?: () => void;
    proxmoxConnId?: number | null;
  } = $props();

  const POLL_MS = 3_000;
  const LS_KEY = 'pulse_stats_source';

  type Source = 'proxmox' | 'container';

  interface NormStats {
    cpuPercent: number;
    memPercent: number;
    diskPercent: number;
    uptimeSec: number | null;
  }

  let source = $state<Source>('container');
  let stats = $state<NormStats | null>(null);
  let err = $state('');
  let timer: ReturnType<typeof setInterval> | undefined;

  function fmtUptime(sec: number | null): string {
    if (sec == null) return '—';
    const d = Math.floor(sec / 86400);
    const h = Math.floor((sec % 86400) / 3600);
    const m = Math.floor((sec % 3600) / 60);
    if (d > 0) return `${d}d ${h}h`;
    if (h > 0) return `${h}h`;
    return `${m}m`;
  }

  function normaliseContainer(r: any): NormStats | null {
    if (!r || r.available === false) return null;
    return {
      cpuPercent: r.cpu?.percent ?? 0,
      memPercent: r.memory?.percent ?? 0,
      diskPercent: r.disks?.[0]?.percent ?? 0,
      uptimeSec: r.uptimeSec ?? null
    };
  }

  function normaliseProxmox(r: any): NormStats | null {
    if (!r?.ok || !r.data) return null;
    return {
      cpuPercent: r.data.cpuPercent ?? 0,
      memPercent: r.data.memPercent ?? 0,
      diskPercent: r.data.diskPercent ?? 0,
      uptimeSec: r.data.uptime ?? null
    };
  }

  async function load() {
    try {
      if (source === 'proxmox' && proxmoxConnId != null) {
        const r = await fetch(`/api/widgets/${proxmoxConnId}/status`).then((x) => x.json());
        const n = normaliseProxmox(r);
        if (n) { stats = n; err = ''; } else { err = r?.error ?? 'Proxmox unavailable'; }
      } else {
        const r = await fetch('/api/server/stats').then((x) => x.json());
        const n = normaliseContainer(r);
        if (n) { stats = n; err = ''; } else { err = 'Container metrics unavailable'; }
      }
    } catch (e) {
      err = (e as Error).message;
    }
  }

  function setSource(s: Source, e: MouseEvent) {
    e.stopPropagation();
    source = s;
    if (isBrowser) localStorage.setItem(LS_KEY, s);
    stats = null; err = '';
    load();
  }

  onMount(() => {
    if (isBrowser) {
      const saved = localStorage.getItem(LS_KEY) as Source | null;
      if (saved === 'proxmox' || saved === 'container') {
        source = saved;
      } else {
        source = proxmoxConnId != null ? 'proxmox' : 'container';
      }
    }
    load();
    timer = setInterval(load, POLL_MS);
  });

  onDestroy(() => { if (timer !== undefined) clearInterval(timer); });
</script>

<!-- Wrapper: source toggle (buttons) + drilldown chip (button).
     Nested <button> inside <button> is invalid HTML, so we use a
     flex row of sibling elements: the toggle group, then the stats button. -->
<div class="server-wrap">
  {#if proxmoxConnId != null}
    <div class="src-toggle" role="group" aria-label="Stats source">
      <button
        class="src-btn"
        class:src-active={source === 'proxmox'}
        onclick={(e) => setSource('proxmox', e)}
        title={$_('widget.serverStats.hostTitle')}
      >{$_('widget.serverStats.host')}</button>
      <button
        class="src-btn"
        class:src-active={source === 'container'}
        onclick={(e) => setSource('container', e)}
        title="Container stats"
      >LXC</button>
    </div>
  {/if}

  {#if err}
    <button class="server-btn" onclick={onOpen} title="Host metrics unavailable">
      <div class="chip"><span class="unavail">Metrics unavailable</span></div>
    </button>
  {:else if stats}
    <button class="server-btn" onclick={onOpen} title="Open server monitoring">
      <div class="chip">
        CPU <b>{stats.cpuPercent}%</b>
        <span class="bar"><i style="width:{stats.cpuPercent}%"></i></span>
      </div>
      <div class="chip">
        RAM <b>{stats.memPercent}%</b>
        <span class="bar"><i style="width:{stats.memPercent}%"></i></span>
      </div>
      <div class="chip">
        Disk <b>{stats.diskPercent}%</b>
        <span class="bar"><i style="width:{stats.diskPercent}%"></i></span>
      </div>
      <div class="chip">Up <b>{fmtUptime(stats.uptimeSec)}</b></div>
      <span class="arr2">→</span>
    </button>
  {:else}
    <button class="server-btn" title="Loading host metrics">
      <div class="chip"><span class="unavail">Loading…</span></div>
    </button>
  {/if}
</div>

<style>
  .server-wrap {
    display: flex;
    align-items: center;
    gap: 0;
  }

  .unavail { font-size: 12px; color: var(--sub); }

  .src-toggle {
    display: flex;
    align-items: center;
    gap: 2px;
    padding: 4px 6px;
    border-right: 1px solid var(--card-brd);
  }

  .src-btn {
    font-size: 10px;
    font-weight: 600;
    padding: 2px 7px;
    border-radius: 6px;
    background: transparent;
    border: 1px solid transparent;
    color: var(--sub);
    cursor: pointer;
    line-height: 1.4;
    transition: color 0.12s, background 0.12s, border-color 0.12s;
  }

  .src-btn:hover {
    color: var(--txt);
    background: rgba(255, 255, 255, 0.06);
  }

  .src-btn.src-active {
    color: var(--accent);
    background: color-mix(in srgb, var(--accent) 14%, transparent);
    border-color: color-mix(in srgb, var(--accent) 28%, transparent);
  }
</style>
