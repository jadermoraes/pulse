<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import type { ConsumerMessage } from '$lib/server/consumer/messages';

  let messages = $state<ConsumerMessage[] | null>(null);
  let draft = $state('');
  let sending = $state(false);
  let sendError = $state('');

  async function load() {
    const r = await fetch('/api/app/messages');
    if (r.status === 401) { await goto('/app/login'); return; }
    const data = await r.json();
    messages = data.messages;
  }

  async function send() {
    const body = draft.trim();
    if (!body || sending) return;
    sending = true;
    sendError = '';
    try {
      const r = await fetch('/api/app/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body })
      });
      if (r.status === 401) { await goto('/app/login'); return; }
      if (!r.ok) { sendError = 'Could not send. Try again.'; return; }
      draft = '';
      await load();
    } catch {
      sendError = 'Could not send. Try again.';
    } finally {
      sending = false;
    }
  }

  function fmt(ts: number | null): string {
    if (!ts) return '';
    return new Date(ts).toLocaleString();
  }

  onMount(load);
</script>

<svelte:head><title>Messages · Pulse</title></svelte:head>

<div class="page">
  <h1>Messages</h1>

  {#if messages && messages.length}
    <ul class="threads">
      {#each messages as m (m.id)}
        <li class="thread">
          <div class="bubble you">
            <span class="who">You</span>
            <p class="body">{m.body}</p>
            <time class="when">{fmt(m.createdAt)}</time>
          </div>
          {#if m.replyBody}
            <div class="bubble admin">
              <span class="who">Admin</span>
              <p class="body">{m.replyBody}</p>
              <time class="when">{fmt(m.repliedAt)}</time>
            </div>
          {/if}
        </li>
      {/each}
    </ul>
  {:else if messages}
    <div class="empty">
      <p class="empty-title">No messages yet.</p>
    </div>
  {/if}

  {#if messages}
    <form class="composer" onsubmit={(e) => { e.preventDefault(); void send(); }}>
      {#if sendError}
        <p class="send-error" role="alert">{sendError}</p>
      {/if}
      <div class="composer-row">
        <textarea
          bind:value={draft}
          placeholder="Message the admin…"
          rows="1"
          disabled={sending}
        ></textarea>
        <button type="submit" disabled={sending || !draft.trim()}>
          {sending ? 'Sending…' : 'Send'}
        </button>
      </div>
    </form>
  {/if}
</div>

<style>
  .page { padding: 1.1rem 1rem 1.5rem; max-width: 720px; margin: 0 auto; width: 100%; }
  h1 { font-size: 1.4rem; font-weight: 700; letter-spacing: -0.3px; margin: 0 0 1.1rem; }

  .threads { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 1.1rem; }
  .thread { display: flex; flex-direction: column; gap: 0.5rem; }

  .bubble {
    padding: 0.7rem 0.85rem;
    border-radius: 14px;
    background: var(--card, rgba(255, 255, 255, 0.04));
    border: 1px solid var(--card-brd, rgba(255, 255, 255, 0.08));
    max-width: 85%;
  }
  .bubble.you { align-self: flex-end; }
  .bubble.admin {
    align-self: flex-start;
    border-color: color-mix(in srgb, var(--accent, #28e0a0) 28%, transparent);
    background: color-mix(in srgb, var(--accent, #28e0a0) 8%, transparent);
  }

  .who {
    font-size: 0.68rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.3px;
    color: var(--sub, #8b95a7);
  }
  .bubble.admin .who { color: var(--accent, #28e0a0); }

  .body { margin: 0.25rem 0 0.3rem; font-size: 0.95rem; line-height: 1.35; white-space: pre-wrap; word-break: break-word; }
  .when { font-size: 0.72rem; color: var(--sub, #8b95a7); }

  .empty {
    text-align: center;
    padding: 3rem 1rem;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.9rem;
  }
  .empty-title { font-size: 1rem; color: var(--sub, #8b95a7); margin: 0; }

  .composer { margin-top: 1.25rem; display: flex; flex-direction: column; gap: 0.5rem; }
  .composer-row { display: flex; align-items: flex-end; gap: 0.5rem; }
  .composer textarea {
    flex: 1;
    padding: 0.7rem 0.85rem;
    border-radius: 12px;
    border: 1px solid var(--card-brd, rgba(255, 255, 255, 0.08));
    background: var(--card, rgba(255, 255, 255, 0.04));
    color: inherit;
    font: inherit;
    /* >= 16px so iOS Safari doesn't zoom the page on focus. */
    font-size: 16px;
    line-height: 1.45;
    resize: none;
    max-height: 9.5rem;
    outline: none;
  }
  .composer textarea:focus { border-color: color-mix(in srgb, var(--accent, #28e0a0) 50%, transparent); }
  .composer button {
    flex-shrink: 0;
    padding: 0.7rem 1.1rem;
    border-radius: 12px;
    border: 0;
    font-weight: 700;
    background: linear-gradient(135deg, var(--accent, #28e0a0), var(--accent2, #36c6ff));
    color: #08110d;
    cursor: pointer;
  }
  .composer button:disabled { opacity: 0.5; cursor: default; }
  .send-error {
    margin: 0;
    font-size: 0.82rem;
    color: #ff7a92;
  }
</style>
