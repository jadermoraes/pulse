<script lang="ts">
  import { tick } from 'svelte';
  import { _ } from 'svelte-i18n';
  import { mobile, useMobile } from '$lib/media.svelte';
  import { streamSse, type AgentSseEvent } from '$lib/sse';
  import { agentUi } from '$lib/agent-ui.svelte';
  import ConfirmCard from './agent/ConfirmCard.svelte';
  import ToolActivity, { type ToolActivityItem } from './agent/ToolActivity.svelte';
  import MarkdownText from './MarkdownText.svelte';
  import { autogrow, chatKeydown } from '$lib/chat-input';
  import { modelMessageText } from '$lib/agent-message';
  import { keyboardInset } from '$lib/keyboard-inset';

  let { open = $bindable(false) }: { open?: boolean } = $props();
  useMobile();

  type Pending = { pendingId: string; tool: string; summary: string; args: unknown };
  type Msg =
    | { kind: 'user'; text: string }
    | { kind: 'assistant'; text: string }
    | { kind: 'tools'; items: ToolActivityItem[] }
    | { kind: 'confirm'; pending: Pending; resolved?: 'approved' | 'denied' };

  let messages = $state<Msg[]>([]);
  let input = $state('');
  let busy = $state(false);
  let conversationId = $state<number | null>(null);
  let usage = $state<{ total: number } | null>(null);
  let errorMsg = $state('');
  let bodyEl = $state<HTMLDivElement | null>(null);

  // Only auto-follow streaming output when the reader is already near the bottom;
  // if they scrolled up to read history, leave their position untouched.
  function isNearBottom() {
    if (!bodyEl) return true;
    return bodyEl.scrollHeight - bodyEl.scrollTop - bodyEl.clientHeight < 80;
  }

  async function scrollToBottom(force = false) {
    const should = force || isNearBottom();
    await tick();
    if (bodyEl && should) bodyEl.scrollTop = bodyEl.scrollHeight;
  }

  // Consume a seed prompt + auto-load the last conversation when the panel opens.
  let wasOpen = false;
  $effect(() => {
    if (open && !wasOpen) {
      wasOpen = true;
      if (agentUi.seedPrompt) {
        input = agentUi.seedPrompt;
        agentUi.seedPrompt = null;
      }
      if (messages.length === 0) void loadConversation();
    } else if (!open) {
      wasOpen = false;
    }
  });

  function handleEvent(e: AgentSseEvent) {
    switch (e.type) {
      case 'meta':
        conversationId = e.conversationId;
        break;
      case 'text': {
        const last = messages.at(-1);
        if (last && last.kind === 'assistant') last.text += e.delta;
        else messages.push({ kind: 'assistant', text: e.delta });
        void scrollToBottom();
        break;
      }
      case 'tool_call': {
        // Group consecutive tool activity within one assistant turn into a single
        // compact, collapsible indicator instead of separate chat-bubble frames.
        const last = messages.at(-1);
        const item: ToolActivityItem = { tool: e.tool, args: e.args, hasResult: false };
        if (last && last.kind === 'tools') last.items.push(item);
        else messages.push({ kind: 'tools', items: [item] });
        void scrollToBottom();
        break;
      }
      case 'tool_result': {
        // Attach the result to the most recent matching running call.
        const last = messages.at(-1);
        if (last && last.kind === 'tools') {
          const entry = [...last.items].reverse().find((i) => i.tool === e.tool && !i.hasResult)
            ?? last.items.find((i) => !i.hasResult);
          if (entry) {
            entry.result = e.result;
            entry.hasResult = true;
          } else {
            last.items.push({ tool: e.tool, result: e.result, hasResult: true });
          }
        } else {
          messages.push({ kind: 'tools', items: [{ tool: e.tool, result: e.result, hasResult: true }] });
        }
        void scrollToBottom();
        break;
      }
      case 'confirmation_required':
        messages.push({
          kind: 'confirm',
          pending: { pendingId: e.pendingId, tool: e.tool, summary: e.summary, args: e.args }
        });
        void scrollToBottom();
        break;
      case 'error':
        errorMsg = e.message;
        break;
      case 'done':
        usage = { total: e.usage.total };
        break;
    }
  }

  async function loadConversation() {
    try {
      const r = await fetch('/api/agent/conversations').then((x) => x.json());
      conversationId = r.conversationId ?? null;
      const loaded: Msg[] = [];
      for (const m of r.messages ?? []) {
        // Persisted ModelMessage: user → string body, assistant → part array. modelMessageText
        // handles both (the old inline extractor dropped user messages — string body).
        const text = modelMessageText(m);
        if (m.role === 'user' && text) loaded.push({ kind: 'user', text });
        else if (m.role === 'assistant' && text) loaded.push({ kind: 'assistant', text });
      }
      if (loaded.length) messages = loaded;
      void scrollToBottom();
    } catch {
      /* no history — start fresh */
    }
  }

  async function send() {
    const text = input.trim();
    if (!text || busy) return;
    input = '';
    errorMsg = '';
    messages.push({ kind: 'user', text });
    void scrollToBottom(true);
    busy = true;
    try {
      const res = await fetch('/api/agent/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text, conversationId })
      });
      if (!res.ok) {
        errorMsg = res.status === 400 ? $_('agent.notConfigured') : `HTTP ${res.status}`;
        return;
      }
      await streamSse(res, handleEvent);
    } catch (err) {
      errorMsg = (err as Error).message;
    } finally {
      busy = false;
    }
  }

  // The ONLY path that triggers a write — explicit Approve/Deny by the admin.
  async function resolveConfirm(msg: Extract<Msg, { kind: 'confirm' }>, approved: boolean) {
    if (msg.resolved || busy) return;
    msg.resolved = approved ? 'approved' : 'denied';
    errorMsg = '';
    busy = true;
    try {
      const res = await fetch('/api/agent/confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pendingId: msg.pending.pendingId, approved })
      });
      if (!res.ok) {
        errorMsg = res.status === 410 ? $_('agent.expired') : `HTTP ${res.status}`;
        return;
      }
      await streamSse(res, handleEvent);
    } catch (err) {
      errorMsg = (err as Error).message;
    } finally {
      busy = false;
    }
  }

  async function newConversation() {
    if (conversationId) {
      try {
        await fetch(`/api/agent/conversations?id=${conversationId}`, { method: 'DELETE' });
      } catch {
        /* ignore */
      }
    }
    messages = [];
    conversationId = null;
    usage = null;
    errorMsg = '';
    input = '';
  }
</script>

{#if open}
  {#if mobile.isMobile}
    <!-- Opaque backdrop behind the mobile sheet so the page never shows through iOS's keyboard
         accessory/URL-bar strip. -->
    <div class="agent-backdrop" aria-hidden="true"></div>
  {/if}
  <div class="agent-panel" class:sheet={mobile.isMobile} role="dialog" aria-label={$_('agent.title')} use:keyboardInset>
    <header class="agent-head">
      <span class="agent-head-title">{$_('agent.title')}</span>
      <div class="agent-head-actions">
        {#if usage}<span class="agent-usage">{$_('agent.tokens')}: {usage.total}</span>{/if}
        <button class="agent-icon" onclick={newConversation} title={$_('agent.new')} aria-label={$_('agent.new')}>＋</button>
        <button class="agent-icon" onclick={() => (open = false)} aria-label={$_('agent.close')}>✕</button>
      </div>
    </header>

    <div class="agent-body" bind:this={bodyEl}>
      {#if messages.length === 0}
        <p class="agent-empty">{$_('agent.empty')}</p>
      {/if}
      {#each messages as m}
        {#if m.kind === 'user'}
          <div class="agent-msg user">{m.text}</div>
        {:else if m.kind === 'assistant'}
          <div class="agent-msg assistant"><MarkdownText text={m.text} /></div>
        {:else if m.kind === 'tools'}
          <ToolActivity items={m.items} {busy} />
        {:else if m.kind === 'confirm'}
          <ConfirmCard
            summary={m.pending.summary}
            resolved={m.resolved}
            busy={busy && !m.resolved}
            onConfirm={() => resolveConfirm(m, true)}
            onCancel={() => resolveConfirm(m, false)}
          />
        {/if}
      {/each}
      {#if busy}<div class="agent-typing"><span></span><span></span><span></span></div>{/if}
      {#if errorMsg}<div class="agent-error">{errorMsg}</div>{/if}
    </div>

    <form class="agent-input" onsubmit={(e) => { e.preventDefault(); void send(); }}>
      <textarea
        bind:value={input}
        use:autogrow={{ value: input }}
        onkeydown={chatKeydown(() => void send())}
        placeholder={$_('agent.placeholder')}
        rows="1"
        disabled={busy}
      ></textarea>
      <button type="submit" class="btn btn-p agent-send" disabled={busy || !input.trim()}>{$_('agent.send')}</button>
    </form>
  </div>
{/if}
