import type { Capability } from './types';

/**
 * Maps an agent tool name to the operator-facing capability that governs it.
 * `null` ⇒ the tool is not exposed to consumers at all (admin/system tools).
 * This is the single decoupling point between role allow-lists and internal tool names.
 */
const TOOL_CAPABILITY: Record<string, Capability> = {
  // discover (browse / search / recommend)
  getWidget: 'discover',
  getMediaDetail: 'discover',
  searchMedia: 'discover',
  getWatchHistory: 'discover',
  // status (what's happening / what's wrong for me)
  getEvents: 'status',
  getNowPlaying: 'status',
  // request (the seerr request write)
  runAction: 'request',
  // watchlist (save-for-later + notify subscription)
  watchlistList: 'watchlist',
  watchlistAdd: 'watchlist',
  watchlistRemove: 'watchlist',
  // my-requests (the viewer's own seerr requests)
  myRequests: 'request',
  cancelRequest: 'request',
  // message-admin (send a short note / problem report to the operator)
  messageAdmin: 'message_admin'
  // ungoverned tools omitted ⇒ null.
};

export function capabilityForTool(tool: string): Capability | null {
  return TOOL_CAPABILITY[tool] ?? null;
}

/** A consumer may use `tool` iff it maps to a capability that is in their allow-list. */
export function toolAllowed(tool: string, allowList: Capability[]): boolean {
  const cap = capabilityForTool(tool);
  if (cap == null) return false;          // ungoverned/admin-only ⇒ never for consumers
  return allowList.includes(cap);
}
