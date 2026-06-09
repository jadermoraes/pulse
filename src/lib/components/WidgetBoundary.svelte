<script lang="ts">
  import type { Snippet } from 'svelte';

  let { children }: { children: Snippet } = $props();
</script>

<svelte:boundary>
  {@render children()}

  {#snippet failed(error: unknown, reset: () => void)}
    <div class="card wb-err">
      <p class="wb-msg">Widget failed to render.</p>
      {#if error instanceof Error && error.message}
        <p class="wb-detail">{error.message}</p>
      {/if}
      <button class="wb-retry" onclick={reset}>Retry</button>
    </div>
  {/snippet}
</svelte:boundary>

<style>
  .wb-err {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 16px;
  }
  .wb-msg {
    font-size: 13px;
    color: #ff7a92;
    margin: 0;
  }
  .wb-detail {
    font-size: 11px;
    color: var(--sub);
    margin: 0;
    word-break: break-all;
  }
  .wb-retry {
    align-self: flex-start;
    background: rgba(255,255,255,0.07);
    border: 1px solid rgba(255,255,255,0.12);
    border-radius: 6px;
    color: var(--txt);
    cursor: pointer;
    font-size: 12px;
    padding: 5px 12px;
  }
  .wb-retry:hover { background: rgba(255,255,255,0.12); }
</style>
