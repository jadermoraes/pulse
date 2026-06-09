<script lang="ts">
  import { _ } from 'svelte-i18n';

  let { open = $bindable(false) } = $props();

  type ServiceLinkRow = { name: string; url: string };
  let serviceLinks = $state<ServiceLinkRow[]>([]);
  let servicesSaving = $state(false);
  let servicesSaveResult = $state<{ ok: boolean; error?: string } | null>(null);
  let servicesLoaded = false;

  async function loadServiceLinks() {
    if (servicesLoaded) return;
    servicesLoaded = true;
    try {
      const r = await fetch('/api/services').then((x) => x.json());
      serviceLinks = (r.links ?? []).map((l: ServiceLinkRow) => ({ name: l.name, url: l.url }));
    } catch {
      serviceLinks = [];
    }
  }

  function addServiceLink() {
    serviceLinks = [...serviceLinks, { name: '', url: '' }];
  }

  function removeServiceLink(i: number) {
    serviceLinks = serviceLinks.filter((_, idx) => idx !== i);
  }

  async function saveServiceLinks() {
    servicesSaving = true;
    servicesSaveResult = null;
    try {
      const res = await fetch('/api/services', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ links: serviceLinks })
      });
      if (!res.ok) {
        servicesSaveResult = { ok: false, error: `HTTP ${res.status}` };
        return;
      }
      servicesSaveResult = { ok: true };
    } catch (e) {
      servicesSaveResult = { ok: false, error: (e as Error).message };
    } finally {
      servicesSaving = false;
    }
  }

  // Load on open (edge-triggered when `open` flips true).
  let wasOpen = false;
  $effect(() => {
    if (open && !wasOpen) {
      wasOpen = true;
      void loadServiceLinks();
    } else if (!open) {
      wasOpen = false;
    }
  });

  function closeModal() {
    open = false;
  }

  function onBackdrop(e: MouseEvent) {
    if ((e.target as HTMLElement).classList.contains('scm-backdrop')) closeModal();
  }

  function onKeydown(e: KeyboardEvent) {
    if (open && e.key === 'Escape') closeModal();
  }
</script>

<svelte:window onkeydown={onKeydown} />

{#if open}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="scm-backdrop"
    onclick={onBackdrop}
    role="dialog"
    aria-modal="true"
    aria-label={$_('settings.services.title')}
    tabindex="-1"
  >
    <div class="scm-modal">
      <div class="scm-head">
        <h2 class="scm-title">{$_('settings.services.title')}</h2>
        <button class="scm-close" type="button" aria-label={$_('drawer.close')} onclick={closeModal}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>

      <p class="scm-hint">{$_('settings.services.hint')}</p>

      {#each serviceLinks as link, i}
        <div class="scm-row">
          <input
            type="text"
            class="scm-input scm-name"
            placeholder={$_('settings.services.name')}
            bind:value={link.name}
          />
          <input
            type="url"
            class="scm-input scm-url"
            placeholder="https://…"
            bind:value={link.url}
          />
          <button
            type="button"
            class="scm-btn scm-btn-d"
            onclick={() => removeServiceLink(i)}
            title={$_('settings.services.remove')}
          >{$_('settings.services.remove')}</button>
        </div>
      {/each}

      <div class="scm-actions">
        <button type="button" class="scm-btn scm-btn-s" onclick={addServiceLink}>
          {$_('settings.services.add')}
        </button>
        <button type="button" class="scm-btn scm-btn-p" onclick={saveServiceLinks} disabled={servicesSaving}>
          {servicesSaving ? $_('settings.services.saving') : $_('settings.services.save')}
        </button>
      </div>

      {#if servicesSaveResult}
        <div class="scm-result {servicesSaveResult.ok ? 'scm-ok' : 'scm-fail'}">
          {servicesSaveResult.ok
            ? `✓ ${$_('settings.services.saved')}`
            : `✕ ${servicesSaveResult.error ?? $_('settings.services.saveError')}`}
        </div>
      {/if}
    </div>
  </div>
{/if}

<style>
  /* ── Backdrop (mirrors ServicesLauncher) ── */
  .scm-backdrop {
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

  /* ── Modal panel — opaque solid background. ── */
  .scm-modal {
    background: var(--bg, #0a0d13);
    border: 1px solid var(--card-brd);
    border-radius: 16px;
    padding: 1.5rem;
    width: 100%;
    max-width: 600px;
    max-height: 80vh;
    overflow-y: auto;
    box-shadow: 0 8px 40px rgba(0, 0, 0, 0.4);
  }

  .scm-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 0.5rem;
  }

  .scm-title {
    font-size: 1rem;
    font-weight: 600;
    color: var(--txt);
    margin: 0;
  }

  .scm-close {
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

  .scm-close:hover {
    color: var(--txt);
  }

  .scm-close svg {
    width: 18px;
    height: 18px;
  }

  .scm-hint {
    font-size: 12px;
    color: var(--sub);
    margin: 0 0 1rem;
  }

  /* ── Editable rows ── */
  .scm-row {
    display: flex;
    gap: 8px;
    align-items: center;
    margin-bottom: 8px;
  }

  .scm-input {
    background: rgba(255, 255, 255, 0.05);
    border: 1px solid var(--card-brd);
    border-radius: 10px;
    color: var(--txt);
    font-size: 14px;
    padding: 10px 14px;
    outline: none;
    transition: border-color 0.15s;
    width: 100%;
  }

  .scm-input:focus {
    border-color: color-mix(in srgb, var(--accent) 50%, transparent);
  }

  .scm-name {
    flex: 0 0 160px;
    min-width: 0;
  }

  .scm-url {
    flex: 1;
    min-width: 0;
  }

  .scm-actions {
    display: flex;
    gap: 8px;
    margin-top: 12px;
    flex-wrap: wrap;
  }

  .scm-btn {
    padding: 9px 16px;
    border-radius: 10px;
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
    border: none;
    transition: opacity 0.15s;
  }

  .scm-btn:hover {
    opacity: 0.85;
  }

  .scm-btn-p {
    background: linear-gradient(135deg, var(--accent), var(--accent2));
    color: #08110d;
    flex: 1;
  }

  .scm-btn-s {
    background: rgba(255, 255, 255, 0.05);
    color: var(--txt);
    border: 1px solid var(--card-brd);
  }

  .scm-btn-d {
    background: rgba(255, 92, 122, 0.10);
    color: #ff7a92;
    border: 1px solid rgba(255, 92, 122, 0.25);
    white-space: nowrap;
  }

  .scm-result {
    margin-top: 12px;
    padding: 10px 14px;
    border-radius: 9px;
    font-size: 13px;
    font-weight: 600;
  }

  .scm-ok {
    background: color-mix(in srgb, var(--accent) 14%, transparent);
    color: var(--accent);
    border: 1px solid color-mix(in srgb, var(--accent) 30%, transparent);
  }

  .scm-fail {
    background: rgba(255, 92, 122, 0.10);
    color: #ff7a92;
    border: 1px solid rgba(255, 92, 122, 0.25);
  }
</style>
