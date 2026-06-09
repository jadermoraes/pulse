<script lang="ts">
  type ModelRow = { model: string; input: number; output: number; cost: number };
  type WindowKey = '24h' | '7d' | '30d' | 'all';
  type Limits = {
    rapidHourUsd: number;
    dailyUsd: number;
    monthlyUsd: number;
    perTurnUsd: number;
    perTurnSteps: number;
  };

  let { open = $bindable(false) }: { open?: boolean } = $props();

  const WINDOWS: { key: WindowKey; label: string }[] = [
    { key: '24h', label: '24h' },
    { key: '7d', label: '7d' },
    { key: '30d', label: '30d' },
    { key: 'all', label: 'All' }
  ];

  let sel = $state<WindowKey>('30d');
  let rows = $state<ModelRow[]>([]);
  let total = $state<{ input: number; output: number; cost: number }>({ input: 0, output: 0, cost: 0 });
  let loading = $state(false);

  let limits = $state<Limits>({ rapidHourUsd: 0, dailyUsd: 0, monthlyUsd: 0, perTurnUsd: 0, perTurnSteps: 0 });
  let savingLimits = $state(false);
  let savedLimits = $state(false);
  let savedTimer: ReturnType<typeof setTimeout> | null = null;

  async function loadUsage() {
    loading = true;
    try {
      const r = await fetch(`/api/ai/usage?window=${sel}`).then((x) => x.json());
      rows = r.rows ?? [];
      total = r.total ?? { input: 0, output: 0, cost: 0 };
    } catch {
      rows = [];
      total = { input: 0, output: 0, cost: 0 };
    } finally {
      loading = false;
    }
  }

  async function loadLimits() {
    try {
      const r = await fetch('/api/ai/limits').then((x) => x.json());
      limits = {
        rapidHourUsd: r.rapidHourUsd ?? 0,
        dailyUsd: r.dailyUsd ?? 0,
        monthlyUsd: r.monthlyUsd ?? 0,
        perTurnUsd: r.perTurnUsd ?? 0,
        perTurnSteps: r.perTurnSteps ?? 0
      };
    } catch {
      /* keep defaults */
    }
  }

  async function saveLimits() {
    savingLimits = true;
    savedLimits = false;
    try {
      await fetch('/api/ai/limits', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(limits)
      });
      savedLimits = true;
      if (savedTimer) clearTimeout(savedTimer);
      savedTimer = setTimeout(() => (savedLimits = false), 1800);
    } catch {
      /* best-effort */
    } finally {
      savingLimits = false;
    }
  }

  function selectWindow(k: WindowKey) {
    sel = k;
    void loadUsage();
  }

  function close() {
    open = false;
  }

  function onBackdrop(e: MouseEvent) {
    if ((e.target as HTMLElement).classList.contains('cm-backdrop')) close();
  }

  function onKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') close();
  }

  // Load whenever the modal transitions to open.
  let wasOpen = false;
  $effect(() => {
    if (open && !wasOpen) {
      wasOpen = true;
      void loadUsage();
      void loadLimits();
    } else if (!open) {
      wasOpen = false;
    }
  });

  function compact(n: number): string {
    return new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(n);
  }
  function usd(n: number): string {
    return `$${n.toFixed(4)}`;
  }
</script>

<svelte:window onkeydown={onKeydown} />

{#if open}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="cm-backdrop" onclick={onBackdrop} role="dialog" aria-modal="true" aria-label="Token usage" tabindex="-1">
    <div class="cm-modal">
      <div class="cm-head">
        <h2 class="cm-title">Token usage &amp; cost</h2>
        <button class="cm-close" type="button" aria-label="Close" onclick={close}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>

      <!-- Window toggle -->
      <div class="cm-windows">
        {#each WINDOWS as w}
          <button
            type="button"
            class="cm-win {sel === w.key ? 'active' : ''}"
            onclick={() => selectWindow(w.key)}
          >{w.label}</button>
        {/each}
      </div>

      <!-- Per-model table -->
      {#if loading}
        <p class="cm-empty">Loading…</p>
      {:else if rows.length === 0}
        <p class="cm-empty">No usage recorded in this window.</p>
      {:else}
        <table class="cm-table">
          <thead>
            <tr>
              <th class="cm-l">Model</th>
              <th class="cm-r">Input</th>
              <th class="cm-r">Output</th>
              <th class="cm-r">Cost</th>
            </tr>
          </thead>
          <tbody>
            {#each rows as r (r.model)}
              <tr>
                <td class="cm-l cm-model">{r.model}</td>
                <td class="cm-r">{compact(r.input)}</td>
                <td class="cm-r">{compact(r.output)}</td>
                <td class="cm-r">
                  {#if r.cost === 0}
                    <span class="cm-unpriced" title="No price configured for this model">unpriced</span>
                  {:else}
                    {usd(r.cost)}
                  {/if}
                </td>
              </tr>
            {/each}
          </tbody>
          <tfoot>
            <tr>
              <td class="cm-l">TOTAL</td>
              <td class="cm-r">{compact(total.input)}</td>
              <td class="cm-r">{compact(total.output)}</td>
              <td class="cm-r cm-total-cost">{usd(total.cost)}</td>
            </tr>
          </tfoot>
        </table>
      {/if}

      <!-- Spend limits -->
      <div class="cm-limits">
        <h3 class="cm-sub">Spend limits</h3>
        <p class="cm-note">Alerts only (bell + Telegram) — nothing is blocked.</p>

        <div class="cm-fields">
          <label class="cm-field">
            <span>Alert if &gt; $/hour</span>
            <input type="number" min="0" step="0.01" bind:value={limits.rapidHourUsd} />
          </label>
          <label class="cm-field">
            <span>Daily budget $</span>
            <input type="number" min="0" step="0.01" bind:value={limits.dailyUsd} />
          </label>
          <label class="cm-field">
            <span>Monthly budget $</span>
            <input type="number" min="0" step="0.01" bind:value={limits.monthlyUsd} />
          </label>
          <label class="cm-field">
            <span>Per-turn $ cap</span>
            <input type="number" min="0" step="0.01" bind:value={limits.perTurnUsd} />
          </label>
          <label class="cm-field">
            <span>Per-turn step cap</span>
            <input type="number" min="0" step="1" bind:value={limits.perTurnSteps} />
          </label>
        </div>

        <div class="cm-actions">
          <button type="button" class="cm-save" onclick={saveLimits} disabled={savingLimits}>
            {savingLimits ? 'Saving…' : 'Save limits'}
          </button>
          {#if savedLimits}
            <span class="cm-saved">✓ Saved</span>
          {/if}
        </div>
      </div>
    </div>
  </div>
{/if}

<style>
  /* ── Backdrop ── */
  .cm-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.72);
    backdrop-filter: blur(6px);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 1000;
    padding: 1rem;
  }

  /* ── Modal panel (opaque surface) ── */
  .cm-modal {
    background: var(--bg, #0a0d13);
    border: 1px solid var(--card-brd);
    border-radius: 16px;
    padding: 1.5rem;
    width: 100%;
    max-width: 560px;
    max-height: 85vh;
    overflow-y: auto;
    box-shadow: 0 8px 40px rgba(0, 0, 0, 0.4);
  }

  .cm-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 1.25rem;
  }

  .cm-title {
    font-size: 1rem;
    font-weight: 600;
    color: var(--txt);
    margin: 0;
  }

  .cm-close {
    display: flex;
    align-items: center;
    justify-content: center;
    background: none;
    border: none;
    color: var(--sub);
    cursor: pointer;
    padding: 4px;
    border-radius: 6px;
    transition: color 0.15s;
  }
  .cm-close:hover {
    color: var(--txt);
  }
  .cm-close svg {
    width: 18px;
    height: 18px;
  }

  /* ── Window toggle ── */
  .cm-windows {
    display: inline-flex;
    gap: 2px;
    padding: 3px;
    border: 1px solid var(--card-brd);
    border-radius: 9px;
    margin-bottom: 1rem;
  }
  .cm-win {
    background: none;
    border: none;
    color: var(--sub);
    cursor: pointer;
    padding: 5px 12px;
    border-radius: 6px;
    font-size: 0.8rem;
    font-weight: 500;
    transition: background 0.15s, color 0.15s;
  }
  .cm-win:hover {
    color: var(--txt);
  }
  .cm-win.active {
    background: color-mix(in srgb, var(--accent) 18%, transparent);
    color: var(--txt);
  }

  /* ── Table ── */
  .cm-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.82rem;
    margin-bottom: 0.5rem;
  }
  .cm-table th {
    color: var(--sub);
    font-weight: 500;
    font-size: 0.72rem;
    text-transform: uppercase;
    letter-spacing: 0.03em;
    padding: 0.4rem 0.5rem;
    border-bottom: 1px solid var(--card-brd);
  }
  .cm-table td {
    padding: 0.45rem 0.5rem;
    color: var(--txt);
    border-bottom: 1px solid color-mix(in srgb, var(--card-brd) 50%, transparent);
  }
  .cm-l {
    text-align: left;
  }
  .cm-r {
    text-align: right;
    font-variant-numeric: tabular-nums;
  }
  .cm-model {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 0.78rem;
    word-break: break-all;
  }
  .cm-unpriced {
    color: var(--sub);
    font-style: italic;
    font-size: 0.75rem;
  }
  .cm-table tfoot td {
    font-weight: 600;
    border-bottom: none;
    border-top: 1px solid var(--card-brd);
  }
  .cm-total-cost {
    color: var(--accent);
  }

  /* ── Limits ── */
  .cm-limits {
    margin-top: 1.5rem;
    padding-top: 1.25rem;
    border-top: 1px solid var(--card-brd);
  }
  .cm-sub {
    font-size: 0.9rem;
    font-weight: 600;
    color: var(--txt);
    margin: 0 0 0.25rem;
  }
  .cm-note {
    font-size: 0.75rem;
    color: var(--sub);
    margin: 0 0 1rem;
  }
  .cm-fields {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
    gap: 0.75rem;
  }
  .cm-field {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
  }
  .cm-field span {
    font-size: 0.75rem;
    color: var(--sub);
  }
  .cm-field input {
    background: var(--surface, var(--card-bg));
    border: 1px solid var(--card-brd);
    border-radius: 8px;
    color: var(--txt);
    padding: 0.45rem 0.6rem;
    font-size: 0.85rem;
    width: 100%;
  }
  .cm-field input:focus {
    outline: none;
    border-color: color-mix(in srgb, var(--accent) 60%, transparent);
  }

  .cm-actions {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    margin-top: 1rem;
  }
  .cm-save {
    background: var(--accent);
    border: none;
    border-radius: 8px;
    color: #fff;
    cursor: pointer;
    padding: 0.5rem 1rem;
    font-size: 0.85rem;
    font-weight: 600;
    transition: opacity 0.15s;
  }
  .cm-save:hover {
    opacity: 0.9;
  }
  .cm-save:disabled {
    opacity: 0.6;
    cursor: default;
  }
  .cm-saved {
    font-size: 0.8rem;
    color: var(--accent);
    font-weight: 500;
  }

  .cm-empty {
    color: var(--sub);
    font-size: 0.85rem;
    text-align: center;
    padding: 1.5rem 0;
    margin: 0;
  }
</style>
