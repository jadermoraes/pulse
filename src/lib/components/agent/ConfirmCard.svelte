<script lang="ts">
  import { _ } from 'svelte-i18n';
  let {
    summary,
    resolved,
    busy = false,
    onConfirm,
    onCancel
  }: {
    summary: string;
    resolved?: 'approved' | 'denied';
    busy?: boolean;
    onConfirm: () => void;
    onCancel: () => void;
  } = $props();
</script>

<div class="agent-card confirm">
  <p class="agent-confirm-prompt">{$_('agent.confirmPrompt')}</p>
  <p class="agent-confirm-detail">{summary}</p>
  {#if resolved}
    <p class="agent-confirm-resolved {resolved}">
      {resolved === 'approved' ? $_('agent.approved') : $_('agent.denied')}
    </p>
  {:else}
    <div class="agent-confirm-acts">
      <button class="btn btn-p" disabled={busy} onclick={onConfirm}>{$_('agent.confirm')}</button>
      <button class="btn btn-d" disabled={busy} onclick={onCancel}>{$_('agent.cancel')}</button>
    </div>
  {/if}
</div>
