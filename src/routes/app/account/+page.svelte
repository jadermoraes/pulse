<script lang="ts">
  import { onMount } from 'svelte';
  import { _ } from 'svelte-i18n';
  import { goto } from '$app/navigation';
  import { setLocale } from '$lib/i18n';
  import { chatsLeft } from '$lib/consumer/plan';
  import { enablePush, pushFailMessage } from '$lib/push-client';

  type Me = {
    displayName: string;
    language: string;
    roleName: string;
    allowList: string[];
    monthToDate: number;
    cap: number | null;
    planName: string | null;
    daysUntilReset: number;
    plexLinked: boolean;
  };
  let me = $state<Me | null>(null);

  async function load() {
    const res = await fetch('/api/app/me');
    if (res.status === 401) {
      await goto('/app/login');
      return;
    }
    me = await res.json();
  }
  async function setLang(lang: string) {
    await fetch('/api/app/me', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ language: lang })
    });
    setLocale(lang); // persist the i18n cookie so the UI switches immediately + survives reload
    await load();
  }
  async function logout() {
    await fetch('/api/app/logout', { method: 'POST' });
    await goto('/app/login');
  }

  let plexBusy = $state(false);
  let plexErr = $state<string | null>(null);
  let pollTimer: ReturnType<typeof setInterval> | null = null;

  function stopPolling() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  }

  async function linkPlex() {
    plexErr = null;
    plexBusy = true;
    try {
      const res = await fetch('/api/app/plex', { method: 'POST' });
      if (!res.ok) throw new Error(await res.text());
      const pin = await res.json();
      window.open(pin.authUrl, 'plex-link', 'width=600,height=700');
      // Poll until linked or the user gives up.
      stopPolling();
      let tries = 0;
      pollTimer = setInterval(async () => {
        tries++;
        try {
          const p = await fetch(`/api/app/plex?pinId=${pin.id}`);
          if (!p.ok) throw new Error(await p.text());
          const data = await p.json();
          if (data.linked) {
            stopPolling();
            plexBusy = false;
            await load();
          }
        } catch (e) {
          stopPolling();
          plexBusy = false;
          plexErr = (e as Error).message || $_('app.plexLinkFailed');
        }
        if (tries > 60) { stopPolling(); plexBusy = false; } // ~3min cap
      }, 3000);
    } catch (e) {
      plexBusy = false;
      plexErr = (e as Error).message || $_('app.plexLinkFailed');
    }
  }

  let pushBusy = $state(false);
  let pushOn = $state(false);
  let pushMsg = $state<string | null>(null);
  async function turnOnNotifications() {
    pushBusy = true; pushMsg = null;
    try {
      const r = await enablePush();
      pushOn = r.ok;
      if (!r.ok) pushMsg = pushFailMessage(r.reason);
    } catch { pushOn = false; pushMsg = pushFailMessage('error'); }
    finally { pushBusy = false; }
  }

  // Telegram link state
  let telegramEnabled = $state(false);
  let telegramBound = $state(false);
  let telegramBusy = $state(false);

  async function loadTelegram() {
    try {
      const r = await fetch('/api/app/telegram/link').then((x) => x.json());
      telegramEnabled = r.enabled ?? false;
      telegramBound = r.bound ?? false;
    } catch { /* ignore */ }
  }

  async function connectTelegram() {
    telegramBusy = true;
    try {
      const r = await fetch('/api/app/telegram/link', { method: 'POST' }).then((x) => x.json());
      if (r.url) window.open(r.url, '_blank', 'noopener');
    } catch { /* ignore */ }
    finally { telegramBusy = false; }
  }

  async function disconnectTelegram() {
    telegramBusy = true;
    try {
      await fetch('/api/app/telegram/link', { method: 'DELETE' });
      await loadTelegram();
    } catch { /* ignore */ }
    finally { telegramBusy = false; }
  }

  const pct = $derived(me && me.cap ? Math.min(100, Math.round((me.monthToDate / me.cap) * 100)) : 0);
  onMount(async () => { await load(); await loadTelegram(); });
  $effect(() => () => stopPolling());
</script>

<svelte:head><title>My Account · Pulse</title></svelte:head>

<div class="account-page">
<main class="app-card">
  {#if me}
    <header class="app-head">
      <h1>{$_('app.hello', { values: { name: me.displayName } })}</h1>
      <button class="btn btn-s" onclick={logout}>{$_('app.logout')}</button>
    </header>

    <section class="app-usage">
      <h2>{$_('app.thisMonth')}</h2>
      {#if me.cap}
        <div class="usage-bar"><div class="usage-fill" style={`width:${pct}%`}></div></div>
        <p>{$_('app.usageLine', { values: { used: me.monthToDate, cap: me.cap, days: me.daysUntilReset } })}</p>
      {:else}
        <p>{$_('app.unlimitedUsage', { values: { used: me.monthToDate } })}</p>
      {/if}
      <p class="usage-plan">
        {me.planName ? `${me.planName} — ` : ''}{me.cap == null
          ? $_('app.chatsUnlimited')
          : $_('app.chatsLeft', { values: { n: chatsLeft(me.cap, me.monthToDate), d: me.daysUntilReset } })}
      </p>
    </section>

    <section class="app-role">
      <h2>{$_('app.yourPlan')}</h2>
      <p><b>{me.roleName}</b></p>
      <ul>{#each me.allowList as cap}<li>{$_(`users.cap.${cap}`)}</li>{/each}</ul>
    </section>

    <section class="app-prefs">
      <h2>{$_('app.language')}</h2>
      <select value={me.language} onchange={(e) => setLang((e.currentTarget as HTMLSelectElement).value)}>
        <option value="en">English</option>
        <option value="pt-BR">Português</option>
      </select>
    </section>

    <p class="app-hint">{$_('app.sameLoginNote')}</p>

    <!-- B.2 Plex link + C Telegram placeholder -->
    <section class="app-links">
      <a class="btn btn-s" href="/app/messages">Messages</a>
      {#if me.plexLinked}
        <span class="badge badge-ok">{$_('app.plexLinked')}</span>
      {:else}
        <button class="btn btn-s" onclick={linkPlex} disabled={plexBusy}>
          {plexBusy ? $_('app.plexLinking') : $_('app.linkPlex')}
        </button>
      {/if}
      {#if plexErr}<p class="app-error">{plexErr}</p>{/if}
      {#if telegramEnabled}
        {#if telegramBound}
          <span class="badge badge-ok">{$_('app.telegramConnected')}</span>
          <button class="btn btn-s" onclick={disconnectTelegram} disabled={telegramBusy}>{$_('app.disconnect')}</button>
        {:else}
          <button class="btn btn-s" onclick={connectTelegram} disabled={telegramBusy}>{$_('app.connectTelegram')}</button>
          <p class="app-hint">{$_('app.telegramHint')}</p>
        {/if}
      {/if}
    </section>

    <section class="app-notify">
      {#if pushOn}
        <span class="badge badge-ok">{$_('app.notificationsOn')}</span>
      {:else}
        <button class="btn btn-s" onclick={turnOnNotifications} disabled={pushBusy}>
          {$_('app.enableNotifications')}
        </button>
        {#if pushMsg}
          <p class="app-hint">{pushMsg}</p>
        {/if}
      {/if}
      <p class="app-hint">{$_('app.iosNotice')}</p>
    </section>
  {:else}
    <p>{$_('app.loading')}</p>
  {/if}
</main>
</div>

<style>
  .account-page {
    width: 100%;
    display: flex;
    justify-content: center;
    padding: 1.2rem 1rem 1.5rem;
  }
  .account-page :global(.app-card) {
    margin: 0;
  }
</style>
