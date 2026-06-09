// src/lib/server/consumer/types.ts  (authoritative — created in Task 2)

export interface DiscoverItem {
  source: 'jellyfin' | 'plex' | 'seerr';
  title: string;
  year?: number;
  poster?: string;                  // already a Pulse-proxied or absolute URL
  tmdbId?: number;
  mediaType: 'movie' | 'tv';
  onServer: boolean;                // true ⇒ ▶ Watch (has watchUrl); false ⇒ + Request
  watchUrl?: string;
  rating?: number;                  // voteAverage, 1 decimal
  overview?: string;
  released: boolean;                // release/first-air date is on or before today (missing ⇒ false)
  requested?: boolean;              // seerr mediaInfo.status 1–4 ⇒ already requested / processing (not yet available)
}

/** Rich detail payload for the consumer movie/series modal (`/api/app/detail`). */
export interface DiscoverDetail {
  title: string;
  year?: number;
  overview?: string;
  genres: string[];
  rating?: number;
  runtimeMin?: number;
  poster?: string;
  backdrop?: string;
  available: boolean;               // seerr mediaInfo?.status === 5
  watchUrl?: string;
  status: string;                   // 'Available' | 'Requested' | 'Not on server'
}

export interface DiscoverResult {
  newOnServer: DiscoverItem[];
  hot: DiscoverItem[];
  continueWatching: DiscoverItem[];
}

export type ConsumerRequestStatus =
  'pending' | 'approved' | 'processing' | 'available' | 'declined';

export interface ConsumerRequest {
  id: number;
  consumerId: number;
  seerrRequestId: number | null;
  tmdbId: number;
  mediaType: 'movie' | 'tv';
  title: string;
  status: ConsumerRequestStatus;
  notified: boolean;
  createdAt: number;
}

export interface PushSubscription {
  id: number;
  consumerId: number;
  endpoint: string;
  p256dh: string;
  auth: string;
}

/**
 * Named token tiers + per-chat estimate. The runtime values live in the client-safe
 * `$lib/consumer/plan` (SvelteKit forbids importing `$lib/server/*` into browser code,
 * and the role editor + My-Account need these) and are re-exported here so server
 * modules keep a single import surface.
 */
export { TOKEN_PLANS, AVG_TOKENS_PER_CHAT, type PlanName } from '$lib/consumer/plan';

// ---- seerr paths D adds (pinned constants; VERIFY against your seerr build, shapes pinned by tests) ----
export const SEERR_PATHS = {
  request: '/api/v1/request',                 // POST { mediaType, mediaId, userId, seasons? }
  trending: '/api/v1/discover/trending',
  discoverMovies: '/api/v1/discover/movies',
  discoverTv: '/api/v1/discover/tv',
  search: '/api/v1/search'                     // GET ?query=
} as const;

/** Plex web deep-link base (no secret). VERIFY against your Plex; isolated so only this const changes. */
export const PLEX_WEB_BASE = 'https://app.plex.tv/desktop/#!/server';
