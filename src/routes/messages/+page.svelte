<script lang="ts">
  import type { PageData } from './$types';

  type Msg = {
    id: number;
    consumerId: number;
    body: string;
    status: string;
    replyBody: string | null;
    repliedAt: number | null;
    readByConsumer: boolean;
    readByAdmin: boolean;
    createdAt: number;
    displayName: string | null;
  };

  let { data }: { data: PageData } = $props();

  // Replies applied in place after a successful POST, keyed by message id — merged over
  // the server-loaded list so we don't need a full reload.
  let overrides = $state<Record<number, Partial<Msg>>>({});
  let drafts = $state<Record<number, string>>({});
  let sending = $state<number | null>(null);

  let messages = $derived(
    (data.messages as Msg[]).map((m) => (overrides[m.id] ? { ...m, ...overrides[m.id] } : m))
  );

  function when(ts: number) {
    return new Date(ts).toLocaleString();
  }

  async function sendReply(id: number) {
    const body = (drafts[id] ?? '').trim();
    if (!body || sending !== null) return;
    sending = id;
    try {
      const res = await fetch(`/api/messages/${id}/reply`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ body })
      });
      if (!res.ok) return;
      const { message } = await res.json();
      overrides = { ...overrides, [id]: message };
      drafts = { ...drafts, [id]: '' };
    } finally {
      sending = null;
    }
  }
</script>

<div class="msg-page">
  <header class="msg-head">
    <a class="back" href="/settings">←</a>
    <h1>Messages</h1>
  </header>

  {#if messages.length === 0}
    <p class="empty">No messages yet.</p>
  {:else}
    <ul class="msg-list">
      {#each messages as m (m.id)}
        <li class="msg-card">
          <div class="msg-meta">
            <span class="who">{m.displayName ?? 'viewer'}</span>
            <span class="ts">{when(m.createdAt)}</span>
          </div>
          <p class="body">{m.body}</p>

          {#if m.status === 'replied'}
            <div class="reply">
              <span class="reply-label">Your reply</span>
              <p class="reply-body">{m.replyBody}</p>
            </div>
          {:else}
            <div class="reply-form">
              <textarea
                rows="2"
                placeholder="Write a reply…"
                value={drafts[m.id] ?? ''}
                oninput={(e) => (drafts = { ...drafts, [m.id]: (e.currentTarget as HTMLTextAreaElement).value })}
              ></textarea>
              <button
                class="btn btn-s"
                disabled={sending !== null || !(drafts[m.id] ?? '').trim()}
                onclick={() => sendReply(m.id)}
              >
                {sending === m.id ? 'Sending…' : 'Send reply'}
              </button>
            </div>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
</div>

<style>
  .msg-page { max-width: 860px; margin: 0 auto; width: 100%; padding: 1rem; }
  .msg-head { display: flex; align-items: center; gap: 12px; margin-bottom: 1rem; }
  .msg-head h1 { font-size: 1.1rem; font-weight: 700; margin-right: auto; }
  .msg-head .back { text-decoration: none; color: var(--sub); font-size: 1.2rem; }
  .empty { color: var(--sub); font-size: 14px; padding: 1rem 0; }
  .msg-list { list-style: none; display: flex; flex-direction: column; gap: 10px; }
  .msg-card { padding: 12px 14px; border-radius: 10px; background: rgba(255,255,255,0.03); display: flex; flex-direction: column; gap: 8px; }
  .msg-meta { display: flex; align-items: baseline; gap: 10px; font-size: 13px; }
  .msg-meta .who { font-weight: 600; }
  .msg-meta .ts { color: var(--sub); margin-left: auto; }
  .body { font-size: 14px; white-space: pre-wrap; word-break: break-word; }
  .reply { border-left: 2px solid var(--accent); padding-left: 10px; }
  .reply-label { font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; color: var(--sub); }
  .reply-body { font-size: 14px; color: var(--sub); white-space: pre-wrap; word-break: break-word; margin-top: 2px; }
  .reply-form { display: flex; flex-direction: column; gap: 8px; }
  .reply-form textarea {
    width: 100%; resize: vertical; font: inherit; font-size: 14px; padding: 8px 10px;
    border-radius: 8px; background: rgba(0,0,0,0.2); border: 1px solid var(--card-brd); color: inherit;
  }
  .reply-form button { align-self: flex-start; }
</style>
