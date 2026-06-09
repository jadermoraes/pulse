<script lang="ts">
  import { _ } from 'svelte-i18n';

  type ServiceLink = { name: string; url: string };

  let open = $state(false);
  let links = $state<ServiceLink[]>([]);
  let loaded = $state(false);

  async function load() {
    if (loaded) return;
    try {
      const r = await fetch('/api/services').then((x) => x.json());
      links = r.links ?? [];
    } catch {
      links = [];
    }
    loaded = true;
  }

  function openModal() {
    open = true;
    void load();
  }

  function closeModal() {
    open = false;
  }

  function onBackdrop(e: MouseEvent) {
    if ((e.target as HTMLElement).classList.contains('sl-backdrop')) closeModal();
  }

  function onKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') closeModal();
  }

  /** First letter of the service name as avatar text. */
  function avatar(name: string): string {
    return name.trim().charAt(0).toUpperCase();
  }

  /** Map a service link name to a dashboard-icons slug (best-effort, by keyword). */
  function logoSlug(name: string): string | null {
    const n = name.toLowerCase();
    const map: Array<[string, string]> = [
      ['jellyfin', 'jellyfin'], ['jellystat', 'jellystat'], ['jellyseerr', 'jellyseerr'],
      ['seerr', 'jellyseerr'], ['sonarr', 'sonarr'], ['radarr', 'radarr'], ['prowlarr', 'prowlarr'],
      ['qbittorrent', 'qbittorrent'], ['qbit', 'qbittorrent'], ['tautulli', 'tautulli'],
      ['plex', 'plex'], ['proxmox', 'proxmox'], ['portainer', 'portainer'], ['gluetun', 'gluetun'],
      ['homepage', 'homepage'], ['glance', 'glance'], ['sabnzbd', 'sabnzbd'], ['bazarr', 'bazarr'],
      ['nginx', 'nginx-proxy-manager'], ['npm', 'nginx-proxy-manager'], ['grafana', 'grafana'],
      ['uptime', 'uptime-kuma'], ['pihole', 'pi-hole'], ['adguard', 'adguard-home']
    ];
    for (const [kw, slug] of map) if (n.includes(kw)) return slug;
    return null;
  }

  function logoUrl(name: string): string | null {
    const s = logoSlug(name);
    return s ? `https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/svg/${s}.svg` : null;
  }

  let failed = $state<Set<string>>(new Set());
</script>

<svelte:window onkeydown={onKeydown} />

<!-- Launcher button — rendered inline in the TopBar chips area -->
<button
  class="sl-btn"
  type="button"
  title={$_('nav.services')}
  aria-label={$_('nav.services')}
  onclick={openModal}
>
  <!-- 3×3 grid / apps icon -->
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <rect x="3" y="3" width="4" height="4" rx="1" />
    <rect x="10" y="3" width="4" height="4" rx="1" />
    <rect x="17" y="3" width="4" height="4" rx="1" />
    <rect x="3" y="10" width="4" height="4" rx="1" />
    <rect x="10" y="10" width="4" height="4" rx="1" />
    <rect x="17" y="10" width="4" height="4" rx="1" />
    <rect x="3" y="17" width="4" height="4" rx="1" />
    <rect x="10" y="17" width="4" height="4" rx="1" />
    <rect x="17" y="17" width="4" height="4" rx="1" />
  </svg>
</button>

<!-- Modal -->
{#if open}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="sl-backdrop" onclick={onBackdrop} role="dialog" aria-modal="true" aria-label={$_('launcher.title')} tabindex="-1">
    <div class="sl-modal">
      <div class="sl-modal-head">
        <h2 class="sl-modal-title">{$_('launcher.title')}</h2>
        <button class="sl-close" type="button" aria-label={$_('drawer.close')} onclick={closeModal}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>

      {#if links.length === 0}
        <p class="sl-empty">{$_('launcher.empty')}</p>
      {:else}
        <div class="sl-grid">
          {#each links as link (`${link.url}||${link.name}`)}
            <a
              class="sl-card"
              href={link.url}
              target="_blank"
              rel="noopener noreferrer"
              onclick={closeModal}
            >
              {#if logoUrl(link.name) && !failed.has(link.url)}
                <span class="sl-avatar sl-avatar-img">
                  <img src={logoUrl(link.name)!} alt="" loading="lazy"
                       onerror={() => { failed = new Set(failed).add(link.url); }} />
                </span>
              {:else}
                <span class="sl-avatar">{avatar(link.name)}</span>
              {/if}
              <span class="sl-name">{link.name}</span>
            </a>
          {/each}
        </div>
      {/if}
    </div>
  </div>
{/if}

<style>
  /* ── Trigger button (same visual as signout-btn in TopBar) ── */
  .sl-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    background: none;
    border: 1px solid var(--card-brd);
    border-radius: 8px;
    color: var(--sub);
    cursor: pointer;
    padding: 5px 7px;
    transition: color 0.15s, border-color 0.15s;
  }

  .sl-btn:hover {
    color: var(--txt);
    border-color: color-mix(in srgb, var(--accent) 50%, transparent);
  }

  .sl-btn svg {
    width: 16px;
    height: 16px;
  }

  /* ── Backdrop ── */
  .sl-backdrop {
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

  /* ── Modal panel ── */
  .sl-modal {
    /* Opaque surface — var(--card-bg) is translucent, which let the discover posters bleed
       through behind the tiles. Use the solid page background so the modal is fully opaque. */
    background: var(--bg, #0a0d13);
    border: 1px solid var(--card-brd);
    border-radius: 16px;
    padding: 1.5rem;
    width: 100%;
    max-width: 540px;
    max-height: 80vh;
    overflow-y: auto;
    box-shadow: 0 8px 40px rgba(0, 0, 0, 0.4);
  }

  .sl-modal-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 1.25rem;
  }

  .sl-modal-title {
    font-size: 1rem;
    font-weight: 600;
    color: var(--txt);
    margin: 0;
  }

  .sl-close {
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

  .sl-close:hover {
    color: var(--txt);
  }

  .sl-close svg {
    width: 18px;
    height: 18px;
  }

  /* ── Empty state ── */
  .sl-empty {
    color: var(--sub);
    font-size: 0.85rem;
    text-align: center;
    padding: 1.5rem 0;
    margin: 0;
  }

  /* ── Services grid ── */
  .sl-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(110px, 1fr));
    gap: 0.75rem;
  }

  .sl-card {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.5rem;
    padding: 0.85rem 0.5rem;
    background: var(--surface);
    border: 1px solid var(--card-brd);
    border-radius: 12px;
    text-decoration: none;
    transition: border-color 0.15s, background 0.15s;
    cursor: pointer;
  }

  .sl-card:hover {
    border-color: color-mix(in srgb, var(--accent) 60%, transparent);
    background: color-mix(in srgb, var(--accent) 6%, var(--surface));
  }

  .sl-avatar {
    width: 40px;
    height: 40px;
    border-radius: 10px;
    background: linear-gradient(135deg, var(--accent), var(--accent2, var(--accent)));
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 1.1rem;
    font-weight: 700;
    color: #fff;
    flex-shrink: 0;
  }

  /* When showing a real logo, drop the accent gradient and let the SVG speak for itself. */
  .sl-avatar-img {
    background: transparent;
  }

  .sl-avatar-img img {
    width: 100%;
    height: 100%;
    object-fit: contain;
    padding: 18%;
  }

  .sl-name {
    font-size: 0.75rem;
    font-weight: 500;
    color: var(--txt);
    text-align: center;
    line-height: 1.3;
    word-break: break-word;
  }
</style>
