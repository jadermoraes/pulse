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

  // Stremio link state
  let stremioLinked = $state(false);
  let stremioLastError = $state<string | null>(null);
  let stremioEmail = $state('');
  let stremioPassword = $state('');
  let stremioBusy = $state(false);
  let stremioErr = $state<string | null>(null);

  async function loadStremio() {
    try {
      const r = await fetch('/api/app/stremio').then((x) => x.json());
      stremioLinked = r.linked ?? false;
      stremioLastError = r.lastError ?? null;
    } catch { /* ignore */ }
  }

  async function connectStremio() {
    stremioErr = null;
    stremioBusy = true;
    const email = stremioEmail;
    const password = stremioPassword;
    // The password only ever needs to live long enough to build this one request body — clear
    // it from state immediately rather than holding it for the lifetime of the request.
    stremioPassword = '';
    try {
      const res = await fetch('/api/app/stremio', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password })
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        stremioErr =
          res.status === 400 ? $_('stremio.badCredentials')
          : res.status === 502 ? $_('stremio.unreachable')
          : (body.message ?? $_('stremio.unreachable'));
        return;
      }
      stremioEmail = '';
      await loadStremio();
    } catch (e) {
      stremioErr = (e as Error).message || $_('stremio.unreachable');
    } finally {
      stremioBusy = false;
    }
  }

  async function disconnectStremio() {
    stremioBusy = true;
    try {
      await fetch('/api/app/stremio', { method: 'DELETE' });
      await loadStremio();
    } catch { /* ignore */ }
    finally { stremioBusy = false; }
  }

  // Trakt link state
  let traktConfigured = $state(false);
  let traktLinked = $state(false);
  let traktLastError = $state<string | null>(null);
  let traktBusy = $state(false);
  let traktErr = $state<string | null>(null);
  let traktDevice = $state<{ deviceCode: string; userCode: string; verificationUrl: string } | null>(null);
  // Its own timer handle, deliberately separate from Plex's `pollTimer`: a second poller on the
  // same variable would let either flow's stopPolling() cancel the other flow's in-flight poll.
  let traktPollTimer: ReturnType<typeof setTimeout> | null = null;

  function stopTraktPolling() {
    if (traktPollTimer) { clearTimeout(traktPollTimer); traktPollTimer = null; }
  }

  async function loadTrakt() {
    try {
      const r = await fetch('/api/app/trakt').then((x) => x.json());
      traktConfigured = r.configured ?? false;
      traktLinked = r.linked ?? false;
      traktLastError = r.lastError ?? null;
    } catch { /* ignore */ }
  }

  async function connectTrakt() {
    traktErr = null;
    traktBusy = true;
    try {
      const res = await fetch('/api/app/trakt', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'start' })
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).message);
      const d = await res.json();
      traktDevice = { deviceCode: d.deviceCode, userCode: d.userCode, verificationUrl: d.verificationUrl };

      // Poll on the interval Trakt itself gave us (seconds → ms) rather than a fixed faster
      // tick: Trakt returns 429 for polling too fast and this client can't tell that apart from
      // a hard failure, so self-pacing on `interval` is the mitigation.
      stopTraktPolling();
      let tries = 0;
      const maxTries = Math.max(1, Math.ceil(180_000 / (d.interval * 1000))); // ~3min cap, like Plex
      const tick = async () => {
        tries++;
        try {
          const p = await fetch('/api/app/trakt', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'poll', deviceCode: d.deviceCode })
          });
          if (!p.ok) throw new Error((await p.json().catch(() => ({}))).message);
          const status = (await p.json()).status;
          if (status === 'ok') {
            stopTraktPolling();
            traktBusy = false;
            traktDevice = null;
            await loadTrakt();
            return;
          }
          if (status === 'expired') {
            stopTraktPolling();
            traktBusy = false;
            traktDevice = null;
            traktErr = $_('trakt.expired');
            return;
          }
        } catch (e) {
          stopTraktPolling();
          traktBusy = false;
          traktDevice = null;
          traktErr = (e as Error).message || $_('trakt.expired');
          return;
        }
        if (tries >= maxTries) {
          stopTraktPolling();
          traktBusy = false;
          traktDevice = null;
          traktErr = $_('trakt.expired');
          return;
        }
        traktPollTimer = setTimeout(tick, d.interval * 1000);
      };
      traktPollTimer = setTimeout(tick, d.interval * 1000);
    } catch (e) {
      traktBusy = false;
      traktErr = (e as Error).message || $_('trakt.notConfigured');
    }
  }

  async function disconnectTrakt() {
    traktBusy = true;
    try {
      await fetch('/api/app/trakt', { method: 'DELETE' });
      await loadTrakt();
    } catch { /* ignore */ }
    finally { traktBusy = false; }
  }

  const pct = $derived(me && me.cap ? Math.min(100, Math.round((me.monthToDate / me.cap) * 100)) : 0);
  onMount(async () => { await load(); await loadTelegram(); await loadStremio(); await loadTrakt(); });
  $effect(() => () => { stopPolling(); stopTraktPolling(); });
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

    <section class="app-connections">
      <h2>{$_('app.connections')}</h2>

      <div class="conn-block">
        <h3>{$_('stremio.title')}</h3>
        <p class="app-hint">{$_('stremio.description')}</p>
        {#if stremioLinked}
          <span class="badge badge-ok">{$_('stremio.linked')}</span>
          <button class="btn btn-s" onclick={disconnectStremio} disabled={stremioBusy}>{$_('app.disconnect')}</button>
          {#if stremioLastError}<p class="app-error">{stremioLastError}</p>{/if}
        {:else}
          <form onsubmit={(e) => { e.preventDefault(); connectStremio(); }}>
            <label>{$_('stremio.email')}<input type="email" bind:value={stremioEmail} autocomplete="email" required /></label>
            <label>{$_('stremio.password')}<input type="password" bind:value={stremioPassword} autocomplete="current-password" required /></label>
            <p class="app-hint">{$_('stremio.passwordNote')}</p>
            <button class="btn btn-s" disabled={stremioBusy || !stremioEmail || !stremioPassword}>{$_('stremio.connect')}</button>
          </form>
        {/if}
        {#if stremioErr}<p class="app-error">{stremioErr}</p>{/if}
      </div>

      <div class="conn-block">
        <h3>{$_('trakt.title')}</h3>
        <p class="app-hint">{$_('trakt.description')}</p>
        {#if !traktConfigured}
          <p class="app-hint">{$_('trakt.notConfigured')}</p>
        {:else if traktLinked}
          <span class="badge badge-ok">{$_('trakt.linked')}</span>
          <button class="btn btn-s" onclick={disconnectTrakt} disabled={traktBusy}>{$_('app.disconnect')}</button>
          {#if traktLastError}<p class="app-error">{traktLastError}</p>{/if}
        {:else if traktDevice}
          <p>{$_('trakt.codeInstructions', { values: { url: traktDevice.verificationUrl } })}</p>
          <p class="conn-code">{traktDevice.userCode}</p>
          <a href={traktDevice.verificationUrl} target="_blank" rel="noopener noreferrer">{traktDevice.verificationUrl}</a>
          <p class="app-hint">{$_('trakt.waiting')}</p>
        {:else}
          <button class="btn btn-s" onclick={connectTrakt} disabled={traktBusy}>{$_('trakt.connect')}</button>
        {/if}
        {#if traktErr}<p class="app-error">{traktErr}</p>{/if}
      </div>
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
  .app-connections {
    display: flex;
    flex-direction: column;
    gap: 18px;
  }
  .conn-block {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 10px;
  }
  .conn-block h3 {
    font-size: 14px;
    font-weight: 600;
  }
  .conn-block form {
    width: 100%;
  }
  .conn-code {
    font-size: 22px;
    font-weight: 700;
    letter-spacing: 3px;
  }
</style>
