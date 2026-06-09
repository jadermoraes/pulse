<script lang="ts">
  import type { Snippet } from 'svelte';
  import { type LayoutEntry } from '$lib/dashboard';
  import { _ } from 'svelte-i18n';

  let {
    instance,
    editing = false,
    children,
    onToggleCollapse,
    onHide
  }: {
    instance: LayoutEntry;
    editing?: boolean;
    children: Snippet;
    onToggleCollapse?: (key: string) => void;
    onHide?: (key: string) => void;
  } = $props();

  let menuOpen = $state(false);
  function toggleMenu() {
    menuOpen = !menuOpen;
  }
  function collapse() {
    onToggleCollapse?.(instance.key);
    menuOpen = false;
  }
</script>

<!--
  WidgetFrame fills the GridStack cell (100% height). The body always fills the full
  height — the edit-mode chrome is an OVERLAY (position:absolute) so it never takes
  layout space or pushes the content down. Content area is identical in edit and view.
-->
<div class="wf" class:editing data-key={instance.key} role="group">
  {#if editing}
    <!-- Edit-mode overlay: absolutely positioned at the top, does NOT take layout space. -->
    <div class="wf-edit-bar">
      <!--
        The drag handle must NOT be a <button> (GridStack's native DD skips mousedown on
        button/input/etc via its skipMouseDown filter). Use a div with role="button" and
        make inner content pointer-events:none so e.target is always the handle itself.
      -->
      <div
        class="wf-drag"
        role="button"
        tabindex="0"
        title={$_('dashboard.dragToMove')}
        aria-label="{$_('dashboard.dragToMove')} {instance.title}"
      >
        <span class="grip-pipe" aria-hidden="true"></span>
      </div>

      <span class="wf-edit-title">{instance.title}</span>

      <button
        type="button"
        class="wf-hide"
        title={$_('dashboard.hideWidget')}
        aria-label="{$_('dashboard.hideWidget')} {instance.title}"
        onclick={() => onHide?.(instance.key)}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
          <line x1="1" y1="1" x2="23" y2="23" />
        </svg>
      </button>
    </div>
  {:else}
    <!-- Normal-mode corner control: collapse/expand menu (already absolute-positioned) -->
    <div class="wf-corner">
      <button
        type="button"
        class="wf-corner-btn"
        title={$_('dashboard.widgetOptions')}
        aria-label={$_('dashboard.widgetOptions')}
        aria-haspopup="true"
        aria-expanded={menuOpen}
        onclick={toggleMenu}
        onblur={() => (menuOpen = false)}
      >⋯</button>
      {#if menuOpen}
        <div class="wf-menu" role="menu">
          <button type="button" class="wf-menu-item" role="menuitem" onmousedown={collapse}>
            {instance.collapsed ? $_('dashboard.expand') : $_('dashboard.collapse')}
          </button>
        </div>
      {/if}
    </div>
  {/if}

  <!-- Body always fills 100% of the frame — no layout shift when entering/leaving edit. -->
  <div class="wf-body">
    {@render children()}
  </div>
</div>

<style>
  /* Fill the GridStack cell exactly and lay out as a column. */
  .wf {
    position: relative;
    width: 100%;
    height: 100%;
    min-width: 0;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }

  /* The body grows to fill remaining height; widgets measure it and fit their content.
     overflow:hidden so the content is clipped to the cell — never an internal scrollbar. */
  .wf-body {
    flex: 1 1 auto;
    min-height: 0;
    overflow: hidden;
    display: flex;
    flex-direction: column;
  }
  /* The widget root card fills the body so its inner list container measures correctly. */
  .wf-body :global(.card) {
    flex: 1 1 auto;
    min-height: 0;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  /* ---- Normal-mode corner control ---- */
  .wf-corner {
    position: absolute;
    top: 10px;
    right: 12px;
    z-index: 4;
  }
  .wf-corner-btn {
    background: rgba(255, 255, 255, 0.05);
    border: 1px solid var(--card-brd);
    border-radius: 7px;
    color: var(--sub);
    cursor: pointer;
    font-size: 14px;
    line-height: 1;
    padding: 2px 8px;
    opacity: 0;
    transition: opacity 0.15s, color 0.15s;
  }
  .wf:hover .wf-corner-btn,
  .wf-corner-btn[aria-expanded='true'] { opacity: 1; }
  .wf-corner-btn:hover { color: var(--txt); }

  .wf-menu {
    position: absolute;
    top: 100%;
    right: 0;
    margin-top: 4px;
    background: var(--card, #14181f);
    border: 1px solid var(--card-brd);
    border-radius: 8px;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
    padding: 4px;
    min-width: 120px;
    backdrop-filter: blur(10px);
  }
  .wf-menu-item {
    display: block;
    width: 100%;
    text-align: left;
    background: none;
    border: none;
    color: var(--txt);
    cursor: pointer;
    font-size: 13px;
    padding: 7px 10px;
    border-radius: 6px;
  }
  .wf-menu-item:hover { background: rgba(255, 255, 255, 0.07); }

  /* ---- Edit-mode overlay bar ---- */
  .wf.editing {
    outline: 1px dashed var(--card-brd);
    outline-offset: -1px;
    border-radius: var(--radius);
  }
  /*
   * The edit bar is absolutely positioned so it overlays the widget content without
   * taking any layout space. The content area (.wf-body) stays at 100% height —
   * identical to view mode — so fit-to-height sees the same body in both modes.
   */
  .wf-edit-bar {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    z-index: 10;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 10px;
    /* Accent-tinted background — opaque, masks the widget's own title row beneath. */
    background: color-mix(in srgb, var(--accent) 7%, var(--card));
    border-bottom: 1px solid var(--card-brd);
    border-radius: var(--radius) var(--radius) 0 0;
    flex-wrap: wrap;
    /* Minimum height covers the widget header band (~36px) so the title row is hidden. */
    min-height: 36px;
  }
  /* The GridStack drag handle (a div, not a button — see markup note). */
  .wf-drag {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    background: none;
    border: none;
    color: var(--sub);
    cursor: grab;
    padding: 4px 5px;
    touch-action: none;
    flex-shrink: 0;
  }
  .wf-drag:active { cursor: grabbing; }
  /* Pipe/grip visual: a small rounded vertical pill that reads as "grab to move".
     Rendered as an inner span so it is never the mousedown target
     (keeps e.target === the handle div for GridStack's DD filter). */
  .grip-pipe {
    display: block;
    width: 4px;
    height: 20px;
    border-radius: 2px;
    background: color-mix(in srgb, var(--accent) 55%, var(--card-brd));
    pointer-events: none;
    transition: background 0.15s;
  }
  .wf-drag:hover .grip-pipe,
  .wf-drag:active .grip-pipe {
    background: var(--accent);
  }

  .wf-edit-title {
    font-size: 11px;
    font-weight: 600;
    color: var(--txt);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex: 1;
    min-width: 0;
  }

  .wf-hide {
    display: flex;
    align-items: center;
    justify-content: center;
    background: none;
    border: 1px solid var(--card-brd);
    border-radius: 6px;
    color: var(--sub);
    cursor: pointer;
    padding: 3px 5px;
    flex-shrink: 0;
  }
  .wf-hide:hover { color: #ff7a92; border-color: color-mix(in srgb, #ff7a92 40%, transparent); }
  .wf-hide svg { width: 14px; height: 14px; }
</style>
