<script lang="ts">
  import { onMount } from 'svelte';
  import { _ } from 'svelte-i18n';
  import { page } from '$app/stores';

  type Ev = { id: number; consumerId: number | null; ts: number; type: string; ip: string | null; device: string; displayName: string | null; detail: string | null };
  type User = { id: number; displayName: string };

  let events = $state<Ev[]>([]);
  let users = $state<User[]>([]);
  let filter = $state<number | ''>('');
  let done = $state(false);

  const label: Record<string, string> = {
    login: 'evLogin', login_failed: 'evLoginFailed', request: 'evRequest', chat: 'evChat', password_reset: 'evPasswordReset'
  };
  function evText(t: string) { return label[t] ? $_(`users.${label[t]}`) : t; }
  function when(ts: number) { return new Date(ts).toLocaleString(); }

  async function load(reset = false) {
    if (reset) { events = []; done = false; }
    const before = !reset && events.length ? `&before=${events[events.length - 1].ts}` : '';
    const q = filter ? `consumerId=${filter}` : '';
    const r = await fetch(`/api/access?${q}${before}`).then((x) => x.json());
    if (!r.events.length) { done = true; return; }
    events = reset ? r.events : [...events, ...r.events];
  }

  onMount(async () => {
    users = (await fetch('/api/users').then((r) => r.json())).users ?? [];
    const u = $page.url.searchParams.get('user');
    if (u) filter = Number(u);
    await load(true);
  });

  async function changeFilter(v: string) { filter = v === '' ? '' : Number(v); await load(true); }
</script>

<div class="access-page">
  <header class="access-head">
    <a class="back" href="/settings">←</a>
    <h1>{$_('users.accessLogTitle')}</h1>
    <select aria-label={$_('users.filterByUser')} value={String(filter)} onchange={(e) => changeFilter((e.currentTarget as HTMLSelectElement).value)}>
      <option value="">{$_('users.allUsers')}</option>
      {#each users as u (u.id)}<option value={String(u.id)}>{u.displayName}</option>{/each}
    </select>
  </header>

  <ul class="access-list">
    {#each events as e (e.id)}
      <li class="access-row" class:warn={e.type === 'login_failed'}>
        <span class="ts">{when(e.ts)}</span>
        <span class="who">{e.displayName ?? e.detail ?? '—'}</span>
        <span class="ev">{evText(e.type)}{#if e.detail && e.type === 'request'}: {e.detail}{/if}</span>
        <span class="meta">{e.ip ?? ''}{#if e.device} · {e.device}{/if}</span>
      </li>
    {/each}
  </ul>
  {#if !done}<button class="btn btn-s" onclick={() => load()}>{$_('users.loadMore')}</button>{/if}
</div>

<style>
  .access-page { max-width: 860px; margin: 0 auto; width: 100%; padding: 1rem; }
  .access-head { display: flex; align-items: center; gap: 12px; margin-bottom: 1rem; }
  .access-head h1 { font-size: 1.1rem; font-weight: 700; margin-right: auto; }
  .access-head .back { text-decoration: none; color: var(--sub); font-size: 1.2rem; }
  .access-list { list-style: none; display: flex; flex-direction: column; gap: 4px; }
  .access-row { display: grid; grid-template-columns: 180px 1fr 1.2fr 1fr; gap: 10px; padding: 8px 10px; border-radius: 8px; background: rgba(255,255,255,0.03); font-size: 13px; }
  .access-row.warn { background: rgba(255,92,122,0.08); color: #ff9bb0; }
  .access-row .ts { color: var(--sub); }
  .access-row .meta { color: var(--sub); text-align: right; }
  @media (max-width: 640px) { .access-row { grid-template-columns: 1fr; gap: 2px; } .access-row .meta { text-align: left; } }
</style>
