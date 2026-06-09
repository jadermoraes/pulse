<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { browser as isBrowser } from '$app/environment';

  let { data } = $props();

  const STATS_MS = 3_000;
  const TOP_MS   = 10_000;
  const LS_KEY   = 'pulse_stats_source';

  type Source = 'proxmox' | 'container';

  // Derive proxmox conn id from layout-merged data.
  const proxmoxConnId = $derived(
    (data.connections as Array<{ id: number; type: string; enabled: boolean }>)
      .find((c) => c.type === 'proxmox' && c.enabled)?.id ?? null
  );

  let source = $state<Source>('container');

  let stats      = $state<any>(null);
  let pveData    = $state<any>(null);   // raw proxmox response data
  let top        = $state<{ available: boolean; top: any[] }>({ available: true, top: [] });

  let statsTimer: ReturnType<typeof setInterval> | undefined;
  let topTimer:   ReturnType<typeof setInterval> | undefined;

  const N = 60;
  let cpuBuf      = $state<number[]>([]);
  let memBuf      = $state<number[]>([]);
  let netRateBuf  = $state<number[]>([]);
  let ioRateBuf   = $state<number[]>([]);

  let prevNet: { rx: number; tx: number; t: number } | null = null;
  let prevIO:  { rd: number; wr: number; t: number } | null = null;
  let netThroughput = $state({ rx: 0, tx: 0 });

  function push(buf: number[], v: number): number[] {
    const next = [...buf, v];
    return next.length > N ? next.slice(next.length - N) : next;
  }

  async function loadStats() {
    try {
      if (source === 'proxmox' && proxmoxConnId != null) {
        const r = await fetch(`/api/widgets/${proxmoxConnId}/status`).then((x) => x.json());
        if (r.ok && r.data) {
          pveData = r.data;
          stats   = null; // clear container stats
          cpuBuf  = push(cpuBuf, r.data.cpuPercent ?? 0);
          memBuf  = push(memBuf, r.data.memPercent ?? 0);
        }
      } else {
        const s = await fetch('/api/server/stats').then((x) => x.json());
        stats   = s;
        pveData = null;
        const now = Date.now();
        if (s.cpu)    cpuBuf = push(cpuBuf, s.cpu.percent);
        if (s.memory) memBuf = push(memBuf, s.memory.percent);
        if (s.network) {
          if (prevNet) {
            const dt = Math.max(0.001, (now - prevNet.t) / 1000);
            const rx = Math.max(0, (s.network.rxBytes - prevNet.rx) / dt);
            const tx = Math.max(0, (s.network.txBytes - prevNet.tx) / dt);
            netThroughput = { rx, tx };
            netRateBuf    = push(netRateBuf, rx + tx);
          }
          prevNet = { rx: s.network.rxBytes, tx: s.network.txBytes, t: now };
        }
        if (s.diskIO) {
          if (prevIO) {
            const dt = Math.max(0.001, (now - prevIO.t) / 1000);
            const rd = Math.max(0, (s.diskIO.readBytes - prevIO.rd) / dt);
            const wr = Math.max(0, (s.diskIO.writeBytes - prevIO.wr) / dt);
            ioRateBuf = push(ioRateBuf, rd + wr);
          }
          prevIO = { rd: s.diskIO.readBytes, wr: s.diskIO.writeBytes, t: now };
        }
      }
    } catch { /* leave last-known */ }
  }

  async function loadTop() {
    try { top = await fetch('/api/docker/top?limit=6').then((x) => x.json()); }
    catch { top = { available: false, top: [] }; }
  }

  function switchSource(s: Source) {
    source = s;
    if (isBrowser) localStorage.setItem(LS_KEY, s);
    // Clear buffers so graphs don't show stale mixed data
    cpuBuf = []; memBuf = []; netRateBuf = []; ioRateBuf = [];
    prevNet = null; prevIO = null;
    stats = null; pveData = null;
    loadStats();
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
    loadStats(); loadTop();
    statsTimer = setInterval(loadStats, STATS_MS);
    topTimer   = setInterval(loadTop,   TOP_MS);
  });

  onDestroy(() => {
    if (statsTimer !== undefined) clearInterval(statsTimer);
    if (topTimer   !== undefined) clearInterval(topTimer);
  });

  // --- helpers ---

  function areaPath(vals: number[], w: number, h: number): { line: string; area: string } {
    if (vals.length < 2) return { line: '', area: '' };
    const max = Math.max(...vals) * 1.2 || 1;
    const st  = w / (vals.length - 1);
    const pts = vals.map((v, i) => [i * st, h - (v / max) * h] as const);
    const line = 'M' + pts.map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' L');
    return { line, area: `${line} L${w},${h} L0,${h} Z` };
  }

  function fmtUptime(sec: number | null | undefined): string {
    if (sec == null) return '—';
    const d = Math.floor(sec / 86400);
    const h = Math.floor((sec % 86400) / 3600);
    return d > 0 ? `${d}d ${h}h` : `${h}h`;
  }

  function fmtRate(bps: number): string {
    if (bps >= 1024 * 1024) return `${(bps / 1048576).toFixed(1)} MB/s`;
    if (bps >= 1024) return `${(bps / 1024).toFixed(0)} KB/s`;
    return `${Math.round(bps)} B/s`;
  }

  function fmtGB(bytes: number): string {
    return (bytes / 1_073_741_824).toFixed(1) + ' GB';
  }

  const W = 300, H = 54;

  // Container-mode panels (same as before)
  const containerPanels = $derived([
    { title: 'CPU',      buf: cpuBuf,     cur: stats?.cpu     ? `${stats.cpu.percent}%`    : '—', avail: !!stats?.cpu },
    { title: 'Memory',   buf: memBuf,     cur: stats?.memory  ? `${stats.memory.percent}%` : '—', avail: !!stats?.memory },
    { title: 'Network',  buf: netRateBuf, cur: stats?.network ? fmtRate(netThroughput.rx + netThroughput.tx) : '—', avail: !!stats?.network },
    { title: 'Disk I/O', buf: ioRateBuf,  cur: stats?.diskIO  ? fmtRate(ioRateBuf.at(-1) ?? 0) : '—', avail: !!stats?.diskIO }
  ]);

  // Proxmox-mode panels: CPU + Memory with graphs; Network + Disk I/O are n/a
  const proxmoxPanels = $derived([
    { title: 'CPU',    buf: cpuBuf, cur: pveData ? `${pveData.cpuPercent ?? 0}%`  : '—', avail: !!pveData },
    { title: 'Memory', buf: memBuf, cur: pveData ? `${pveData.memPercent ?? 0}%`  : '—', avail: !!pveData }
  ]);
</script>

<div class="lp-head">
  <a href="/" class="back" aria-label="Back to dashboard">‹</a>
  <h2>Server{source === 'proxmox' && pveData?.node ? ` · ${pveData.node}` : ''}</h2>
  <span class="cnt-pill">
    {#if source === 'proxmox'}
      {#if pveData}up {fmtUptime(pveData.uptime)} · load {pveData.load?.[0]?.toFixed(2) ?? '—'}
      {:else}loading…{/if}
    {:else}
      {#if stats?.available === false}host metrics unavailable
      {:else}up {fmtUptime(stats?.uptimeSec)} · load {stats?.load?.[0]?.toFixed(2) ?? '—'}{/if}
    {/if}
  </span>
  {#if proxmoxConnId != null}
    <div class="src-toggle" role="group" aria-label="Stats source">
      <button class="src-btn" class:src-active={source === 'proxmox'} onclick={() => switchSource('proxmox')}>Host</button>
      <button class="src-btn" class:src-active={source === 'container'} onclick={() => switchSource('container')}>LXC</button>
    </div>
  {/if}
</div>

{#if source === 'proxmox'}
  <div class="sv-grid">
    {#each proxmoxPanels as p}
      <div class="sv-panel">
        <div class="sv-top"><span class="sv-ttl">{p.title}</span><b>{p.cur}</b></div>
        {#if p.avail && p.buf.length >= 2}
          {@const path = areaPath(p.buf, W, H)}
          <svg class="chart" viewBox="0 0 {W} {H}" preserveAspectRatio="none">
            <path d={path.area} fill="var(--accent)" opacity="0.14" />
            <path d={path.line} fill="none" stroke="var(--accent)" stroke-width="2" />
          </svg>
        {:else}
          <div class="sv-na">{p.avail ? 'collecting…' : 'unavailable'}</div>
        {/if}
      </div>
    {/each}
    <!-- Network and Disk I/O are not available from the Proxmox status endpoint -->
    <div class="sv-panel">
      <div class="sv-top"><span class="sv-ttl">Network</span><b>—</b></div>
      <div class="sv-na">n/a for host source</div>
    </div>
    <div class="sv-panel">
      <div class="sv-top"><span class="sv-ttl">Disk I/O</span><b>—</b></div>
      <div class="sv-na">n/a for host source</div>
    </div>
  </div>

  <div class="sv-stats">
    <div class="sstat"><div class="v">{fmtUptime(pveData?.uptime)}</div><div class="l">Uptime</div></div>
    <div class="sstat"><div class="v">{pveData?.load?.[0]?.toFixed(2) ?? '—'}</div><div class="l">Load (1m)</div></div>
    <div class="sstat"><div class="v">{pveData ? `${pveData.diskPercent ?? 0}%` : '—'}</div><div class="l">Root disk</div></div>
    <div class="sstat"><div class="v">{pveData ? fmtGB(pveData.disk?.used ?? 0) + ' / ' + fmtGB(pveData.disk?.total ?? 0) : '—'}</div><div class="l">Disk used</div></div>
  </div>

{:else}
  <div class="sv-grid">
    {#each containerPanels as p}
      <div class="sv-panel">
        <div class="sv-top"><span class="sv-ttl">{p.title}</span><b>{p.cur}</b></div>
        {#if p.avail && p.buf.length >= 2}
          {@const path = areaPath(p.buf, W, H)}
          <svg class="chart" viewBox="0 0 {W} {H}" preserveAspectRatio="none">
            <path d={path.area} fill="var(--accent)" opacity="0.14" />
            <path d={path.line} fill="none" stroke="var(--accent)" stroke-width="2" />
          </svg>
        {:else}
          <div class="sv-na">{p.avail ? 'collecting…' : 'unavailable'}</div>
        {/if}
      </div>
    {/each}
  </div>

  <div class="sv-stats">
    <div class="sstat"><div class="v">{fmtUptime(stats?.uptimeSec)}</div><div class="l">Uptime</div></div>
    <div class="sstat"><div class="v">{stats?.cpuTempC != null ? `${stats.cpuTempC}°C` : '—'}</div><div class="l">CPU temp</div></div>
    <div class="sstat"><div class="v">{stats?.load?.[0]?.toFixed(2) ?? '—'}</div><div class="l">Load (1m)</div></div>
    <div class="sstat"><div class="v">↓ {fmtRate(netThroughput.rx)} · ↑ {fmtRate(netThroughput.tx)}</div><div class="l">Network</div></div>
  </div>
{/if}

<div class="topc">
  <h4>Top containers by CPU</h4>
  {#if !top.available}
    <p class="sv-na">Docker socket unavailable.</p>
  {:else if top.top.length === 0}
    <p class="sv-na">No running containers.</p>
  {:else}
    {#each top.top as c}
      <div class="tcr">
        <span class="nm">{c.name}</span>
        <span class="pbar"><i style="width:{Math.min(100, c.cpuPercent)}%"></i></span>
        <span class="pc2">{c.cpuPercent}%</span>
      </div>
    {/each}
  {/if}
</div>

<style>
  .src-toggle {
    display: flex;
    gap: 4px;
    align-items: center;
    margin-left: auto;
  }

  .src-btn {
    font-size: 11px;
    font-weight: 600;
    padding: 3px 10px;
    border-radius: 7px;
    background: transparent;
    border: 1px solid var(--card-brd);
    color: var(--sub);
    cursor: pointer;
    transition: color 0.12s, background 0.12s, border-color 0.12s;
  }

  .src-btn:hover {
    color: var(--txt);
    background: rgba(255, 255, 255, 0.05);
  }

  .src-btn.src-active {
    color: var(--accent);
    background: color-mix(in srgb, var(--accent) 14%, transparent);
    border-color: color-mix(in srgb, var(--accent) 30%, transparent);
  }
</style>
