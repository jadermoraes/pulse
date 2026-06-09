<script lang="ts">
  import { _ } from 'svelte-i18n';
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { saveCredential } from '$lib/consumer/saveCredential';
  import PosterWall from '$lib/components/app/PosterWall.svelte';
  import Wordmark from '$lib/components/app/Wordmark.svelte';

  let username = $state('');
  let password = $state('');
  let busy = $state(false);
  let err = $state<string | null>(null);
  let posters = $state<string[]>([]);
  let contact = $state('');

  // Pull the public poster wall for the cinematic backdrop (degrades to a gradient if empty).
  onMount(async () => {
    try {
      const res = await fetch('/api/app/showcase');
      if (res.ok) posters = (await res.json()).posters ?? [];
    } catch { /* gradient fallback */ }
    contact = (await fetch('/api/app/contact').then((r) => r.json()).catch(() => ({}))).contact ?? '';
  });

  async function submit() {
    err = null;
    busy = true;
    try {
      const res = await fetch('/api/app/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password })
      });
      if (!res.ok) {
        err = (await res.json().catch(() => ({}))).message ?? $_('app.loginFailed');
        return;
      }
      // Offer to save the login so the browser can autofill it on Jellyfin/Seerr later
      // (Credential Management API — Chromium-only; degrade silently elsewhere).
      await saveCredential(username, password, username);
      await goto('/app');
    } catch (e) {
      err = (e as Error).message;
    } finally {
      busy = false;
    }
  }
</script>

<svelte:head><title>Sign in · Pulse</title></svelte:head>

<div class="login-stage">
  <PosterWall {posters} />

  <main class="glass-card login-card">
    <div class="login-brand">
      <Wordmark size="lg" />
      <p class="login-tagline">{$_('app.loginTagline')}</p>
    </div>

    <h1 class="sr-h">{$_('app.signIn')}</h1>
    <p class="app-sub">{$_('app.signInHint')}</p>
    <form onsubmit={(e) => { e.preventDefault(); submit(); }}>
      <label>{$_('app.username')}<input bind:value={username} autocomplete="username" required /></label>
      <label>{$_('app.password')}<input type="password" bind:value={password} autocomplete="current-password" required /></label>
      <button class="btn btn-p" disabled={busy || !username || !password}>{$_('app.signIn')}</button>
      {#if err}<p class="app-error">{err}</p>{/if}
    </form>
    <p class="login-trouble">
      {$_('app.loginTrouble')}
      {#if contact && (contact.includes('@') || contact.startsWith('http'))}
        <a href={contact.includes('@') ? `mailto:${contact}` : contact}>{$_('app.contactAdmin')}</a>
      {:else if contact}
        <span>{$_('app.contactAdmin')} — {contact}</span>
      {:else}
        <span>{$_('app.contactAdmin')}.</span>
      {/if}
    </p>
  </main>
</div>

<style>
  .login-stage {
    position: fixed;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24px 16px;
    padding-bottom: calc(24px + env(safe-area-inset-bottom));
    overflow: hidden;
  }

  .login-card {
    position: relative;
    z-index: 1;
    width: 100%;
    max-width: 400px;
    display: flex;
    flex-direction: column;
    gap: 18px;
    padding: 28px 26px;
  }

  .login-brand {
    display: flex;
    flex-direction: column;
    gap: 6px;
    align-items: flex-start;
  }

  .login-tagline {
    color: var(--sub);
    font-size: 14px;
    font-weight: 500;
  }

  /* Visually-hidden accessible heading (the wordmark is the visible brand). */
  .sr-h {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }

  .login-card .app-sub { margin-top: 0; }

  .login-card form {
    display: flex;
    flex-direction: column;
    gap: 14px;
  }

  .login-card label {
    display: flex;
    flex-direction: column;
    gap: 6px;
    font-size: 13px;
    font-weight: 600;
    color: var(--sub);
  }

  .login-card input {
    background: rgba(255, 255, 255, 0.06);
    border: 1px solid var(--card-brd);
    border-radius: 10px;
    color: var(--txt);
    font-size: 16px; /* >=16px so iOS Safari doesn't zoom the page on focus */
    padding: 11px 14px;
    outline: none;
    transition: border-color 0.15s;
  }

  .login-card input:focus {
    border-color: color-mix(in srgb, var(--accent) 55%, transparent);
  }

  .login-card .btn { margin-top: 2px; }
  .login-card .btn:disabled { opacity: 0.5; cursor: not-allowed; }

  .login-trouble { margin-top: 14px; font-size: 12.5px; color: var(--sub); text-align: center; }
  .login-trouble a { color: var(--accent); }
</style>
