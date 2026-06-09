<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { goto } from '$app/navigation';
  import ServerStats from '$lib/components/widgets/ServerStats.svelte';
  import NotificationBell from '$lib/components/NotificationBell.svelte';
  import { formatClock, loadClockFormat, type ClockFormat } from '$lib/theme';
  import { _ } from 'svelte-i18n';
  import ServicesLauncher from '$lib/components/ServicesLauncher.svelte';

  let { proxmoxConnId = null }: { proxmoxConnId?: number | null } = $props();

  let clockStr = $state('');
  let clockFmt = $state<ClockFormat>('24h');
  let timer: ReturnType<typeof setInterval> | undefined;

  function updateClock() {
    clockStr = formatClock(new Date(), clockFmt);
  }

  // Re-export so settings page can trigger a refresh via a custom event.
  function handleClockFormatChange(e: Event) {
    const ce = e as CustomEvent<ClockFormat>;
    clockFmt = ce.detail;
    updateClock();
  }

  onMount(() => {
    clockFmt = loadClockFormat();
    updateClock();
    timer = setInterval(updateClock, 30_000);
    window.addEventListener('pulse:clockformat', handleClockFormatChange);
  });

  onDestroy(() => {
    if (timer !== undefined) clearInterval(timer);
    if (typeof window !== 'undefined') {
      window.removeEventListener('pulse:clockformat', handleClockFormatChange);
    }
  });
</script>

<header class="topbar">
  <div class="brand">
    <h1>Pulse</h1>
    <!-- Animated EKG line -->
    <svg class="ekg" viewBox="0 0 60 24">
      <path d="M0 12h10l4-9 6 18 4-9h6l3 5 4-5h13" />
    </svg>
  </div>

  <div class="chips">
    <!-- The wide CPU/RAM/Disk strip doesn't fit on phones — hidden on mobile
         (reachable via the Server tab). Brand + clock + sign-out stay. -->
    <div class="serverstats-wrap">
      <ServerStats {proxmoxConnId} onOpen={() => goto('/server')} />
    </div>

    <!-- Clock -->
    <span class="clock">{clockStr}</span>

    <!-- Services launcher -->
    <ServicesLauncher />

    <!-- Notification bell -->
    <NotificationBell />

    <!-- About -->
    <a href="/about" class="about-btn" title="About Pulse" aria-label="About Pulse">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="12" cy="12" r="10" />
        <line x1="12" y1="16" x2="12" y2="12" />
        <line x1="12" y1="8" x2="12.01" y2="8" />
      </svg>
    </a>

    <!-- Sign out -->
    <form method="POST" action="/logout" class="signout-form">
      <button type="submit" class="signout-btn" title={$_('nav.signOut')}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
          <polyline points="16 17 21 12 16 7" />
          <line x1="21" y1="12" x2="9" y2="12" />
        </svg>
      </button>
    </form>
  </div>
</header>

<style>
  .signout-form {
    display: flex;
    align-items: center;
  }

  .signout-btn {
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

  .signout-btn:hover {
    color: var(--txt);
    border-color: color-mix(in srgb, var(--accent) 50%, transparent);
  }

  .signout-btn svg {
    width: 16px;
    height: 16px;
  }

  .about-btn {
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

  .about-btn:hover {
    color: var(--txt);
    border-color: color-mix(in srgb, var(--accent) 50%, transparent);
  }

  .about-btn svg {
    width: 16px;
    height: 16px;
  }

  /* Mobile (≤768px): hide the wide server-stats strip and the clock so the
     compact brand + reachable sign-out fit on a phone-width top bar. */
  @media (max-width: 768px) {
    .serverstats-wrap {
      display: none;
    }
    .clock {
      display: none;
    }
    .signout-btn {
      /* ≥44px tap target on touch */
      min-width: 44px;
      min-height: 44px;
    }
  }
</style>
