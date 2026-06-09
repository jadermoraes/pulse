// Shared reactive mobile breakpoint. SSR-safe: starts `false` on the server and during
// the first client render, then onMount wires up a matchMedia listener (browser-only).
// Components import the singleton `mobile` and read `mobile.isMobile` reactively.
import { onMount } from 'svelte';

/** Mobile breakpoint — phones / narrow tablets in portrait. */
export const MOBILE_QUERY = '(max-width: 768px)';

class MediaState {
  isMobile = $state(false);
}

/** Singleton reactive media state, shared across every component that imports it. */
export const mobile = new MediaState();

let listeners = 0;
let mql: MediaQueryList | undefined;
let onChange: ((e: MediaQueryListEvent) => void) | undefined;

/**
 * Wire the shared `mobile.isMobile` to a matchMedia listener for the lifetime of the
 * calling component. Call this in a component's top-level script (it registers an
 * onMount + cleanup). Reference-counted so multiple components share one listener.
 */
export function useMobile() {
  onMount(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    if (listeners === 0) {
      mql = window.matchMedia(MOBILE_QUERY);
      mobile.isMobile = mql.matches;
      onChange = (e: MediaQueryListEvent) => {
        mobile.isMobile = e.matches;
      };
      mql.addEventListener('change', onChange);
    }
    listeners += 1;
    return () => {
      listeners -= 1;
      if (listeners === 0 && mql && onChange) {
        mql.removeEventListener('change', onChange);
        mql = undefined;
        onChange = undefined;
      }
    };
  });
  return mobile;
}
