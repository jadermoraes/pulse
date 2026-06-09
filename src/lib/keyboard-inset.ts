// Svelte action for a `position: fixed` chat panel that must stay glued to the VISIBLE area when
// the on-screen keyboard opens — the cross-browser fix that works on iOS Safari (which ignores the
// `interactive-widget` viewport meta).
//
// Drives the panel's height + top from `window.visualViewport`: its height shrinks to the area
// above the keyboard, and offsetTop tracks any scroll, so the panel covers exactly the visible
// region and its input sits just above the keyboard. Pair this with a full-screen opaque backdrop
// (rendered behind the panel) so the strip iOS reserves for its keyboard accessory/URL bar shows a
// solid colour rather than the page bleeding through.
//
// On desktop / no keyboard, `visualViewport.height` == the full viewport and `offsetTop` == 0, so
// it's equivalent to `top:0; bottom:0`. No-op when VisualViewport is unavailable.
export function keyboardInset(node: HTMLElement) {
  const vv = typeof window !== 'undefined' ? window.visualViewport : null;
  if (!vv) return {};

  let raf = 0;
  const apply = () => {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => {
      node.style.height = `${vv.height}px`;
      node.style.top = `${vv.offsetTop}px`;
      node.style.bottom = 'auto';
    });
  };

  apply();
  vv.addEventListener('resize', apply);
  vv.addEventListener('scroll', apply);

  return {
    destroy() {
      cancelAnimationFrame(raf);
      vv.removeEventListener('resize', apply);
      vv.removeEventListener('scroll', apply);
      node.style.height = '';
      node.style.top = '';
      node.style.bottom = '';
    }
  };
}
