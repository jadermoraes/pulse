<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { _ } from 'svelte-i18n';
  import { page } from '$app/stores';
  import { streamSse, type AgentSseEvent } from '$lib/sse';
  import MarkdownText from '$lib/components/MarkdownText.svelte';
  import ToolActivity, { type ToolActivityItem } from '$lib/components/agent/ToolActivity.svelte';
  import { autogrow, chatKeydown } from '$lib/chat-input';

  type Msg =
    | { kind: 'user'; text: string }
    | { kind: 'assistant'; text: string }
    | { kind: 'tools'; items: ToolActivityItem[] };

  let messages = $state<Msg[]>([]);
  let input = $state('');
  let busy = $state(false);
  let blocked = $state(false);
  let errorMsg = $state('');
  let conversationId: number | undefined;
  let logEl = $state<HTMLDivElement | null>(null);

  // Auto-follow only when already near the bottom — don't yank readers up.
  function isNearBottom() {
    if (!logEl) return true;
    return logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 80;
  }

  async function scrollToBottom(force = false) {
    const should = force || isNearBottom();
    await tick();
    if (logEl && should) logEl.scrollTo({ top: logEl.scrollHeight, behavior: 'smooth' });
  }

  function handle(ev: AgentSseEvent) {
    switch (ev.type) {
      case 'meta':
        conversationId = ev.conversationId;
        break;
      case 'text': {
        const last = messages.at(-1);
        if (last && last.kind === 'assistant') last.text += ev.delta;
        else messages.push({ kind: 'assistant', text: ev.delta });
        void scrollToBottom();
        break;
      }
      case 'tool_call': {
        // Group tool activity within a turn into one compact, muted indicator.
        const last = messages.at(-1);
        const item: ToolActivityItem = { tool: ev.tool, args: ev.args, hasResult: false };
        if (last && last.kind === 'tools') last.items.push(item);
        else messages.push({ kind: 'tools', items: [item] });
        void scrollToBottom();
        break;
      }
      case 'tool_result': {
        const last = messages.at(-1);
        if (last && last.kind === 'tools') {
          const entry = [...last.items].reverse().find((i) => i.tool === ev.tool && !i.hasResult)
            ?? last.items.find((i) => !i.hasResult);
          if (entry) {
            entry.result = ev.result;
            entry.hasResult = true;
          } else {
            last.items.push({ tool: ev.tool, result: ev.result, hasResult: true });
          }
        } else {
          messages.push({ kind: 'tools', items: [{ tool: ev.tool, result: ev.result, hasResult: true }] });
        }
        void scrollToBottom();
        break;
      }
      case 'blocked':
        if (ev.reason === 'cap') {
          blocked = true;
          messages.push({ kind: 'assistant', text: $_('app.chatCapHit') });
          void scrollToBottom();
        }
        break;
      case 'error':
        // Surface the error as a dismissable inline notice. The stream will close and
        // `busy` resets in send()'s finally, so the input stays usable — the chat never
        // ends up in a dead state.
        errorMsg = ev.message || $_('app.chatErrorRetry');
        void scrollToBottom();
        break;
    }
  }

  async function send(text: string) {
    const msg = text.trim();
    if (!msg || busy || blocked) return;
    input = '';
    errorMsg = '';
    messages.push({ kind: 'user', text: msg });
    void scrollToBottom(true);
    busy = true;
    try {
      const res = await fetch('/api/app/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: msg, conversationId })
      });
      if (!res.ok) {
        errorMsg = $_('app.chatErrorRetry');
        return;
      }
      await streamSse(res, handle);
    } catch {
      // Network/parse failure mid-turn — show a friendly, retryable notice.
      errorMsg = $_('app.chatErrorRetry');
    } finally {
      busy = false;
    }
  }

  onMount(() => {
    const q = $page.url.searchParams.get('q');
    if (q) void send(q);
  });
</script>

<svelte:head><title>Assistant · Pulse</title></svelte:head>

<div class="chat">
  <header class="chat-head">
    <a class="back" href="/app" aria-label={$_('app.back')}>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>
    </a>
    <h1>{$_('app.chatTitle')}</h1>
  </header>

  <div class="log" bind:this={logEl}>
    {#each messages as m, i (i)}
      {#if m.kind === 'tools'}
        <ToolActivity items={m.items} {busy} />
      {:else if m.kind === 'assistant'}
        <div class="bubble assistant"><MarkdownText text={m.text} /></div>
      {:else}
        <div class="bubble user">{m.text}</div>
      {/if}
    {/each}
    {#if busy}<div class="typing"><span></span><span></span><span></span></div>{/if}
  </div>

  {#if errorMsg}
    <div class="error-notice" role="alert">
      <span>{errorMsg}</span>
      <button type="button" class="dismiss" onclick={() => (errorMsg = '')} aria-label={$_('app.dismiss')}>✕</button>
    </div>
  {/if}

  <form onsubmit={(e) => { e.preventDefault(); void send(input); }}>
    <textarea
      bind:value={input}
      use:autogrow={{ value: input }}
      onkeydown={chatKeydown(() => void send(input))}
      placeholder={$_('app.chatPlaceholder')}
      rows="1"
      disabled={blocked}
    ></textarea>
    <button type="submit" disabled={busy || blocked || !input.trim()}>{$_('app.chatSend')}</button>
  </form>
</div>

<style>
  .chat {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-height: 0;
    /* Fill the viewport minus the bottom nav on mobile (the layout pads .app-content);
       on desktop the top nav takes its own space and the chat fills the rest. */
    height: 100%;
    max-width: 760px;
    width: 100%;
    margin: 0 auto;
  }
  .chat-head {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    padding: 0.8rem 1rem;
    border-bottom: 1px solid var(--card-brd, rgba(255, 255, 255, 0.08));
    flex-shrink: 0;
    background: color-mix(in srgb, var(--bg, #0a0d13) 90%, transparent);
    backdrop-filter: blur(8px);
  }
  .back {
    display: grid;
    place-items: center;
    width: 38px;
    height: 38px;
    border-radius: 10px;
    border: 1px solid var(--card-brd, rgba(255, 255, 255, 0.08));
    color: var(--sub, #8b95a7);
    text-decoration: none;
    flex-shrink: 0;
  }
  .back:hover { color: var(--txt, #e7ecf3); border-color: color-mix(in srgb, var(--accent, #28e0a0) 40%, transparent); }
  .back svg { width: 20px; height: 20px; }
  .chat-head h1 { font-size: 1.05rem; font-weight: 700; margin: 0; }
  .log {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 0.55rem;
    padding: 1rem;
    -webkit-overflow-scrolling: touch;
    overscroll-behavior: contain;
  }
  .bubble {
    padding: 0.65rem 0.85rem;
    border-radius: 14px;
    max-width: 82%;
    white-space: pre-wrap;
    word-break: break-word;
    line-height: 1.5;
    animation: msg-in 0.22s ease both;
  }
  @keyframes msg-in {
    from { opacity: 0; transform: translateY(6px); }
    to { opacity: 1; transform: translateY(0); }
  }
  @media (prefers-reduced-motion: reduce) {
    .bubble { animation: none; }
  }
  .bubble.user {
    align-self: flex-end;
    background: linear-gradient(135deg, var(--accent, #28e0a0), var(--accent2, #36c6ff));
    color: #08110d;
    border-bottom-right-radius: 4px;
  }
  .bubble.assistant {
    align-self: flex-start;
    background: rgba(255, 255, 255, 0.05);
    border: 1px solid var(--card-brd, rgba(255, 255, 255, 0.08));
    border-bottom-left-radius: 4px;
    /* Rendered as Markdown HTML — let block elements own their whitespace. */
    white-space: normal;
  }
  .error-notice {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.6rem;
    margin: 0 1rem;
    padding: 0.6rem 0.8rem;
    border-radius: 10px;
    font-size: 0.85rem;
    color: #ff7a92;
    background: rgba(255, 92, 122, 0.1);
    border: 1px solid rgba(255, 92, 122, 0.25);
  }
  .error-notice .dismiss {
    flex-shrink: 0;
    background: none;
    border: none;
    color: inherit;
    cursor: pointer;
    font-size: 0.9rem;
    padding: 0 0.2rem;
    opacity: 0.8;
  }
  .error-notice .dismiss:hover { opacity: 1; }
  .typing {
    align-self: flex-start;
    display: flex;
    gap: 0.25rem;
    padding: 0.4rem 0.6rem;
  }
  .typing span {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: currentColor;
    opacity: 0.4;
    animation: blink 1.2s infinite;
  }
  .typing span:nth-child(2) { animation-delay: 0.2s; }
  .typing span:nth-child(3) { animation-delay: 0.4s; }
  @keyframes blink {
    0%, 100% { opacity: 0.2; }
    50% { opacity: 0.8; }
  }
  form {
    display: flex;
    align-items: flex-end;
    gap: 0.5rem;
    padding: 0.75rem 1rem;
    padding-bottom: calc(0.75rem + env(safe-area-inset-bottom));
    border-top: 1px solid var(--card-brd, rgba(255, 255, 255, 0.08));
    flex-shrink: 0;
    background: color-mix(in srgb, var(--bg, #0a0d13) 90%, transparent);
  }
  textarea {
    flex: 1;
    padding: 0.7rem 0.85rem;
    border-radius: 12px;
    border: 1px solid var(--card-brd, rgba(255, 255, 255, 0.08));
    background: rgba(255, 255, 255, 0.05);
    color: inherit;
    font: inherit;
    /* >= 16px so iOS Safari doesn't zoom the page on focus (reads as a "resize"). */
    font-size: 16px;
    line-height: 1.45;
    resize: none;
    overflow-y: hidden;
    max-height: 9.5rem;
    outline: none;
  }
  textarea:focus { border-color: color-mix(in srgb, var(--accent, #28e0a0) 50%, transparent); }
  button[type='submit'] {
    flex-shrink: 0;
    padding: 0.7rem 1.1rem;
    border-radius: 12px;
    border: 0;
    font-weight: 700;
    background: linear-gradient(135deg, var(--accent, #28e0a0), var(--accent2, #36c6ff));
    color: #08110d;
    cursor: pointer;
  }
  button[type='submit']:disabled {
    opacity: 0.5;
    cursor: default;
  }
</style>
