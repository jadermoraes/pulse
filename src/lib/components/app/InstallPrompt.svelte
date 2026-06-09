<script lang="ts">
  import { onMount } from 'svelte';
  import { shouldShowInstall, type InstallVariant } from '$lib/pwa-install';

  let variant = $state<InstallVariant>('none');
  let deferred: any = null;
  const KEY = 'pulse_install_dismissed';

  function detect() {
    const isStandalone =
      window.matchMedia?.('(display-mode: standalone)').matches || (navigator as any).standalone === true;
    const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) && /safari/i.test(navigator.userAgent);
    const dismissed = localStorage.getItem(KEY) === '1';
    variant = shouldShowInstall({ isStandalone, isIOS, dismissed, hasBeforeInstall: !!deferred });
  }

  function dismiss() { localStorage.setItem(KEY, '1'); variant = 'none'; }

  async function install() {
    if (!deferred) return;
    deferred.prompt();
    try { await deferred.userChoice; } catch { /* ignore */ }
    deferred = null;
    dismiss();
  }

  onMount(() => {
    const onBip = (e: Event) => { e.preventDefault(); deferred = e; detect(); };
    window.addEventListener('beforeinstallprompt', onBip);
    detect();
    return () => window.removeEventListener('beforeinstallprompt', onBip);
  });
</script>

{#if variant === 'android'}
  <div class="install">
    <span>Install Pulse for a full-screen, app-like experience.</span>
    <button onclick={install}>Install app</button>
    <button class="x" onclick={dismiss} aria-label="Dismiss">✕</button>
  </div>
{:else if variant === 'ios'}
  <div class="ip-card" role="dialog" aria-label="Add Pulse to Home Screen">
    <button class="ip-dismiss" onclick={dismiss} aria-label="Dismiss">✕</button>
    <h2 class="ip-heading">Add Pulse to your Home Screen</h2>
    <p class="ip-body">
      Tap&nbsp;
      <span class="ip-share-chip">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="ip-share" aria-hidden="true">
          <path d="M12 16V4" /><path d="m8 8 4-4 4 4" /><path d="M4 12v6a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-6" />
        </svg>
        Share
      </span>
      &nbsp;then <strong>Add to Home Screen</strong>.
    </p>
    <div class="ip-arrow" aria-hidden="true">&#8964;</div>
  </div>
{/if}

<style>
  /* ── Android banner (unchanged) ── */
  .install {
    display: flex; align-items: center; gap: 0.6rem;
    margin: 0.6rem 1rem; padding: 0.6rem 0.8rem; border-radius: 12px;
    font-size: 0.9rem; color: var(--txt, #e7ecf3);
    background: rgba(40, 224, 160, 0.1); border: 1px solid rgba(54, 198, 255, 0.25);
  }
  .install span { flex: 1; }
  .install button { flex-shrink: 0; border: 0; border-radius: 10px; padding: 0.45rem 0.8rem;
    font-weight: 700; cursor: pointer;
    background: linear-gradient(135deg, var(--accent, #28e0a0), var(--accent2, #36c6ff)); color: #08110d; }
  .install button.x { background: none; color: var(--sub, #8b95a7); padding: 0 0.3rem; font-weight: 400; }

  /* ── iOS floating card ── */
  .ip-card {
    position: fixed;
    bottom: calc(1rem + env(safe-area-inset-bottom, 0px));
    left: 1rem;
    right: 1rem;
    z-index: 9999;
    background: var(--bg, #0d1a12);
    border: 1px solid var(--card-brd, rgba(54, 198, 255, 0.2));
    border-radius: 18px;
    padding: 1.2rem 1.2rem 0.8rem;
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.55), 0 0 0 1px rgba(40, 224, 160, 0.08);
    color: var(--txt, #e7ecf3);
    text-align: center;
    animation: ip-slide-up 0.35s cubic-bezier(0.22, 1, 0.36, 1) both;
  }

  @keyframes ip-slide-up {
    from { opacity: 0; transform: translateY(24px); }
    to   { opacity: 1; transform: translateY(0); }
  }

  .ip-dismiss {
    position: absolute;
    top: 0.6rem;
    right: 0.7rem;
    background: none;
    border: 0;
    color: var(--sub, #8b95a7);
    font-size: 1rem;
    line-height: 1;
    padding: 0.25rem 0.4rem;
    cursor: pointer;
    border-radius: 6px;
  }
  .ip-dismiss:hover { color: var(--txt, #e7ecf3); }

  .ip-heading {
    margin: 0 0 0.55rem;
    font-size: 1rem;
    font-weight: 700;
    color: var(--txt, #e7ecf3);
  }

  .ip-body {
    margin: 0 0 0.6rem;
    font-size: 0.9rem;
    color: var(--sub, #8b95a7);
    line-height: 1.5;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-wrap: wrap;
    gap: 0.25rem;
  }
  .ip-body strong { color: var(--txt, #e7ecf3); }

  .ip-share-chip {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    background: rgba(40, 224, 160, 0.12);
    border: 1px solid rgba(40, 224, 160, 0.3);
    border-radius: 6px;
    padding: 0.1rem 0.45rem;
    font-size: 0.85rem;
    font-weight: 600;
    color: var(--accent, #28e0a0);
    white-space: nowrap;
  }

  .ip-share {
    width: 1em;
    height: 1em;
    vertical-align: middle;
    flex-shrink: 0;
  }

  .ip-arrow {
    font-size: 1.6rem;
    line-height: 1;
    color: var(--accent, #28e0a0);
    animation: ip-bounce 1.4s ease-in-out infinite;
  }

  @keyframes ip-bounce {
    0%, 100% { transform: translateY(0); }
    50%       { transform: translateY(5px); }
  }

  @media (prefers-reduced-motion: reduce) {
    .ip-card { animation: none; }
    .ip-arrow { animation: none; }
  }
</style>
