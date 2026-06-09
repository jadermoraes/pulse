<script lang="ts">
  /**
   * WidgetState — shared loading / empty / error presenter for dashboard widgets.
   *
   * Usage:
   *   <WidgetState {loading} {error} empty={items.length === 0} onRetry={load} />
   *
   * Renders nothing (null) when none of the three states apply (data is present).
   * The parent widget handles that case with its own content.
   */
  import { _ } from 'svelte-i18n';

  let {
    loading = false,
    error = '',
    empty = false,
    emptyMessage,
    onRetry,
    settingsHref
  }: {
    loading?: boolean;
    error?: string;
    empty?: boolean;
    emptyMessage?: string;
    onRetry?: () => void;
    /** If provided, an "Open settings" link appears next to Retry on error. */
    settingsHref?: string;
  } = $props();
</script>

{#if loading}
  <!-- Loading skeleton: three muted shimmer bars -->
  <div class="ws-loading" aria-label={$_('state.loading')} aria-live="polite">
    <div class="ws-bar ws-bar-1"></div>
    <div class="ws-bar ws-bar-2"></div>
    <div class="ws-bar ws-bar-3"></div>
  </div>
{:else if error}
  <div class="ws-error" aria-live="polite">
    <span class="ws-icon" aria-hidden="true">
      <!-- warning triangle -->
      <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
        <path d="M10 2.5 L17.5 16.5 H2.5 Z"/>
        <line x1="10" y1="8.5" x2="10" y2="11.5"/>
        <circle cx="10" cy="13.5" r="0.6" fill="currentColor" stroke="none"/>
      </svg>
    </span>
    <span class="ws-msg">{error}</span>
    <div class="ws-actions">
      {#if onRetry}
        <button class="ws-retry" type="button" onclick={onRetry}>{$_('state.retry')}</button>
      {/if}
      {#if settingsHref}
        <a class="ws-settings-link" href={settingsHref}>{$_('state.settings')}</a>
      {/if}
    </div>
  </div>
{:else if empty}
  <div class="ws-empty" aria-live="polite">
    <span class="ws-icon ws-icon-empty" aria-hidden="true">
      <!-- inbox / empty box icon -->
      <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
        <rect x="2.5" y="6.5" width="15" height="11" rx="2"/>
        <path d="M2.5 11h4l1.5 2.5h4L13.5 11H17.5"/>
      </svg>
    </span>
    <span class="ws-msg">{emptyMessage ?? $_('state.emptyDefault')}</span>
  </div>
{/if}

<style>
  /* --- shared container --- */
  .ws-loading,
  .ws-error,
  .ws-empty {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 6px;
    padding: 6px 0;
  }

  /* --- loading skeleton bars --- */
  .ws-loading {
    gap: 8px;
  }

  @keyframes ws-shimmer {
    0%   { opacity: 0.4; }
    50%  { opacity: 0.7; }
    100% { opacity: 0.4; }
  }

  .ws-bar {
    height: 10px;
    border-radius: 5px;
    background: color-mix(in srgb, var(--sub) 35%, transparent);
    animation: ws-shimmer 1.6s ease-in-out infinite;
  }

  .ws-bar-1 { width: 68%; animation-delay: 0s; }
  .ws-bar-2 { width: 50%; animation-delay: 0.2s; }
  .ws-bar-3 { width: 58%; animation-delay: 0.4s; }

  /* --- icon --- */
  .ws-icon {
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--sub);
    opacity: 0.65;
  }

  .ws-error .ws-icon { color: #ff7a92; opacity: 0.85; }

  .ws-icon svg {
    width: 18px;
    height: 18px;
  }

  .ws-icon-empty svg {
    opacity: 0.5;
  }

  /* --- message text --- */
  .ws-msg {
    font-size: 12.5px;
    color: var(--sub);
    line-height: 1.4;
  }

  .ws-error .ws-msg {
    color: #ff7a92;
    opacity: 0.9;
  }

  /* --- error action row --- */
  .ws-actions {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 2px;
  }

  .ws-retry {
    font-size: 11.5px;
    font-weight: 600;
    padding: 3px 10px;
    border-radius: 7px;
    border: 1px solid color-mix(in srgb, var(--accent) 40%, transparent);
    background: color-mix(in srgb, var(--accent) 10%, transparent);
    color: var(--accent);
    cursor: pointer;
    transition: background 0.15s, border-color 0.15s;
  }

  .ws-retry:hover {
    background: color-mix(in srgb, var(--accent) 18%, transparent);
    border-color: color-mix(in srgb, var(--accent) 60%, transparent);
  }

  .ws-settings-link {
    font-size: 11.5px;
    color: var(--sub);
    text-decoration: underline;
    text-underline-offset: 2px;
    transition: color 0.15s;
  }

  .ws-settings-link:hover { color: var(--txt); }
</style>
