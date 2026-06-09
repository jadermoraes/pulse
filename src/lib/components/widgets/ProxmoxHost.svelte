<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import type { WidgetSize } from '$lib/dashboard';
  import { measureBlock, type RowGeometry } from '$lib/fitrows';
  import WidgetState from '$lib/components/WidgetState.svelte';
  import { _ } from 'svelte-i18n';
  // ProxmoxHost adapts its detail level to size — no list capping needed here.

  let { connectionId, size, collapsed = false, onGeometry }: {
    connectionId: number;
    size?: WidgetSize;
    collapsed?: boolean;
    onGeometry?: (geom: RowGeometry) => void;
  } = $props();

  const POLL_MS = 5_000;

  let data = $state<any>(null);
  let err = $state('');
  let loading = $state(true);
  let timer: ReturnType<typeof setInterval> | undefined;

  // ---- formatting helpers ----

  function fmtUptime(sec: number): string {
    const d = Math.floor(sec / 86400);
    const h = Math.floor((sec % 86400) / 3600);
    const m = Math.floor((sec % 3600) / 60);
    if (d > 0) return `${d}d ${h}h`;
    if (h > 0) return `${h}h`;
    return `${m}m`;
  }

  function fmtGB(bytes: number): string {
    return (bytes / 1_073_741_824).toFixed(1) + ' GB';
  }

  function fmtLoad(load: number[]): string {
    return (load ?? []).map((v) => Number(v).toFixed(2)).join(' / ');
  }

  // ---- data fetching ----

  async function load() {
    try {
      const r = await fetch(`/api/widgets/${connectionId}/status`).then((x) => x.json());
      if (r.ok) {
        data = r.data;
        err = '';
      } else {
        err = r.error ?? 'Unknown error';
      }
    } catch (e) {
      err = (e as Error).message;
    } finally {
      loading = false;
    }
  }

  onMount(() => { load(); timer = setInterval(load, POLL_MS); });
  onDestroy(() => { if (timer !== undefined) clearInterval(timer); });

  // At 's' we only show the three bars; at 'm'+ we also show load/uptime and guests.
  const showMeta = $derived(size !== 's');
  const showGuests = $derived(size === 'l' || size === 'full');
</script>

<div class="card">
  <div class="ch">
    <h3>
      <span class="pve-icon">⬛</span>
      {$_('widget.proxmox.title')}{data?.node ? ` · ${data.node}` : ''}
    </h3>
    {#if data}
      <span class="pill ok">online</span>
    {/if}
  </div>

  {#if collapsed}
    <!-- collapsed: header only -->
  {:else if loading || err}
    <WidgetState {loading} error={err} onRetry={load} settingsHref="/settings" />
  {:else if data}
    <div class="pve-rows" use:measureBlock={(g) => onGeometry?.(g)}>

      <!-- CPU -->
      <div class="pve-row">
        <span class="pve-label">CPU</span>
        <div class="pve-bar-wrap">
          <span class="bar"><i style="width:{data.cpuPercent ?? 0}%"></i></span>
        </div>
        <span class="pve-val"><b>{data.cpuPercent ?? 0}%</b></span>
      </div>

      <!-- RAM -->
      <div class="pve-row">
        <span class="pve-label">RAM</span>
        <div class="pve-bar-wrap">
          <span class="bar"><i style="width:{data.memPercent ?? 0}%"></i></span>
        </div>
        <span class="pve-val">
          <b>{data.memPercent ?? 0}%</b>
          <span class="pve-sub">{fmtGB(data.mem?.used ?? 0)} / {fmtGB(data.mem?.total ?? 0)}</span>
        </span>
      </div>

      <!-- Disk -->
      <div class="pve-row">
        <span class="pve-label">Disk</span>
        <div class="pve-bar-wrap">
          <span class="bar"><i style="width:{data.diskPercent ?? 0}%"></i></span>
        </div>
        <span class="pve-val">
          <b>{data.diskPercent ?? 0}%</b>
          <span class="pve-sub">{fmtGB(data.disk?.used ?? 0)} / {fmtGB(data.disk?.total ?? 0)}</span>
        </span>
      </div>

      <!-- Uptime + Load (hidden at size s) -->
      {#if showMeta}
        <div class="pve-meta-row">
          <span class="pve-meta-item">
            <span class="pve-meta-label">Up</span>
            <b>{fmtUptime(data.uptime)}</b>
          </span>
          <span class="pve-meta-item">
            <span class="pve-meta-label">Load</span>
            <b>{fmtLoad(data.load)}</b>
          </span>
        </div>
      {/if}

      <!-- Guest counts (only at l / full) -->
      {#if showGuests && data.guests}
        <div class="pve-meta-row">
          <span class="pve-meta-item">
            <span class="pve-meta-label">LXC</span>
            <b>{data.guests.lxc?.running ?? 0}/{data.guests.lxc?.total ?? 0}</b>
            <span class="pve-sub">running</span>
          </span>
          <span class="pve-meta-item">
            <span class="pve-meta-label">VMs</span>
            <b>{data.guests.qemu?.running ?? 0}/{data.guests.qemu?.total ?? 0}</b>
            <span class="pve-sub">running</span>
          </span>
        </div>
      {/if}

    </div>
  {/if}
</div>

<style>
  .pve-icon { font-size: 10px; line-height: 1; opacity: 0.5; }

  .pve-rows {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .pve-row {
    display: flex;
    align-items: center;
    gap: 10px;
  }

  .pve-label {
    font-size: 12px;
    color: var(--sub);
    width: 32px;
    flex-shrink: 0;
  }

  .pve-bar-wrap {
    flex: 1;
    min-width: 0;
  }

  /* Override global .bar to be full-width inside the card */
  .pve-bar-wrap .bar {
    width: 100%;
    height: 5px;
    display: block;
    border-radius: 99px;
    background: rgba(255, 255, 255, 0.08);
    overflow: hidden;
  }

  .pve-bar-wrap .bar i {
    display: block;
    height: 100%;
    border-radius: 99px;
    background: linear-gradient(90deg, var(--accent), var(--accent2));
    max-width: 100%;
  }

  .pve-val {
    display: flex;
    align-items: baseline;
    gap: 6px;
    width: 120px;
    flex-shrink: 0;
    font-size: 12px;
  }

  .pve-val b {
    font-size: 13px;
    color: var(--txt);
    font-weight: 600;
  }

  .pve-sub {
    font-size: 11px;
    color: var(--sub);
  }

  .pve-meta-row {
    display: flex;
    gap: 18px;
    margin-top: 2px;
  }

  .pve-meta-item {
    display: flex;
    align-items: baseline;
    gap: 5px;
    font-size: 12px;
  }

  .pve-meta-label {
    color: var(--sub);
    font-size: 11px;
  }

  .pve-meta-item b {
    color: var(--txt);
    font-size: 13px;
    font-weight: 600;
  }
</style>
