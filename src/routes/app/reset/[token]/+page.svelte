<script lang="ts">
  import { _ } from 'svelte-i18n';
  import { page } from '$app/stores';
  import { goto } from '$app/navigation';
  import { validatePassword } from '$lib/consumer/validate';

  let { data } = $props();
  const token = $derived(($page.params as Record<string, string>).token);
  let password = $state('');
  let confirm = $state('');
  let touched = $state(false);
  let busy = $state(false);
  let err = $state<string | null>(null);

  const pwErr = $derived(touched ? validatePassword(password) : null);
  const mismatch = $derived(touched && confirm.length > 0 && password !== confirm);
  const invalid = $derived(validatePassword(password) != null || password !== confirm);

  async function submit() {
    err = null; busy = true;
    try {
      const res = await fetch('/api/app/reset', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, password })
      });
      if (!res.ok) { err = (await res.json().catch(() => ({}))).message ?? $_('app.resetFailed'); return; }
      await goto('/app');
    } catch (e) { err = (e as Error).message; } finally { busy = false; }
  }
</script>

<svelte:head><title>Reset password · Pulse</title></svelte:head>

<main class="glass-card reset-card">
  {#if !data.valid}
    <h1>{$_('app.resetInvalidTitle')}</h1>
    <p class="app-sub">{$_('app.resetInvalidBody')}</p>
    <a class="btn btn-s" href="/app/login">{$_('app.backToLogin')}</a>
  {:else}
    <h1>{$_('app.resetTitle')}</h1>
    <p class="app-sub">{$_('app.resetIntro')}</p>
    <form onsubmit={(e) => { e.preventDefault(); submit(); }}>
      <label>{$_('app.newPassword')}
        <input type="password" bind:value={password} autocomplete="new-password" minlength="8"
               onblur={() => (touched = true)} required />
        {#if pwErr}<span class="field-err">{pwErr}</span>{/if}
      </label>
      <label>{$_('app.confirmPassword')}
        <input type="password" bind:value={confirm} autocomplete="new-password" required />
        {#if mismatch}<span class="field-err">{$_('app.passwordsMismatch')}</span>{/if}
      </label>
      <button class="btn btn-p" disabled={busy || invalid}>{$_('app.setPassword')}</button>
      {#if err}<p class="app-error">{err}</p>{/if}
    </form>
  {/if}
</main>

<style>
  .reset-card { max-width: 380px; margin: 12vh auto; display: flex; flex-direction: column; gap: 14px; padding: 26px; }
  .reset-card form { display: flex; flex-direction: column; gap: 12px; }
  .reset-card label { display: flex; flex-direction: column; gap: 6px; font-size: 13px; font-weight: 600; color: var(--sub); }
  .reset-card input { background: rgba(255,255,255,0.06); border: 1px solid var(--card-brd); border-radius: 10px; color: var(--txt); font-size: 16px; /* >=16px so iOS Safari doesn't zoom the page on focus */ padding: 11px 14px; outline: none; }
  .field-err { font-size: 11.5px; font-weight: 500; color: #ff7a92; }
</style>
