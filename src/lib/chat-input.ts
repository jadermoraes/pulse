// Shared behavior for the chat composer textareas (admin AgentChat + consumer chat).
//
// - `autogrow`: a Svelte action that resizes a <textarea> to fit its content,
//   from 1 row up to `maxRows`, then scrolls internally. Recomputes on input and
//   whenever the bound `value` changes (so it shrinks back after a send resets it).
// - `chatKeydown`: Enter sends, Shift+Enter inserts a newline, and we never send
//   while an IME composition is active (composing) — keeps CJK/diacritic input safe.

export type AutogrowParams = { value: string; maxRows?: number };

export function autogrow(node: HTMLTextAreaElement, params: AutogrowParams) {
  const maxRows = params.maxRows ?? 6;

  function resize() {
    // Measure against a clean baseline so the box can shrink as well as grow.
    node.style.height = 'auto';
    const cs = getComputedStyle(node);
    const line = parseFloat(cs.lineHeight) || 20;
    const padding = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
    const border = parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth);
    const max = line * maxRows + padding + border;
    const next = Math.min(node.scrollHeight, max);
    node.style.height = `${next}px`;
    node.style.overflowY = node.scrollHeight > max ? 'auto' : 'hidden';
  }

  node.addEventListener('input', resize);
  // Initial sizing after layout settles.
  queueMicrotask(resize);

  return {
    update(next: AutogrowParams) {
      // `value` is passed so the action re-runs (and resizes) on external changes,
      // e.g. clearing the field after send or seeding a prompt.
      void next.value;
      queueMicrotask(resize);
    },
    destroy() {
      node.removeEventListener('input', resize);
    }
  };
}

// Returns a keydown handler that calls `onSend()` on a plain Enter press.
export function chatKeydown(onSend: () => void) {
  return (e: KeyboardEvent) => {
    if (e.key !== 'Enter' || e.shiftKey) return;
    // Don't submit mid-composition (IME) — `isComposing` covers most cases; the
    // legacy keyCode 229 guards older browsers.
    if (e.isComposing || e.keyCode === 229) return;
    e.preventDefault();
    onSend();
  };
}
