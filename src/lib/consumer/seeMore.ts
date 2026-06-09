// Build context-aware "See more ▸" links from the /api/app/links bases.
// The bare service base (jellyfin/seerr) lands on the app root; these helpers
// point each discover row at the matching catalog/discover page instead.

export type SeeMoreSource = 'jellyfin' | 'seerr';
export type SeeMoreMediaType = 'movie' | 'tv';

export interface LinkBases {
  jellyfin: string | null;
  seerr: string | null;
}

// Jellyfin web library views. The exact hash routes are pinned here so only this
// constant changes if a future Jellyfin build renames them.
const JELLYFIN_MOVIES = '/web/index.html#/movies.html';
const JELLYFIN_TV = '/web/index.html#/tv.html';

function trimBase(base: string): string {
  return base.replace(/\/$/, '');
}

/**
 * The destination for a discover row's "See more" link, or null when the
 * relevant service base is absent (the link should then be hidden).
 *  - seerr   → /discover/movies | /discover/tv
 *  - jellyfin → the movies / series library view
 */
export function seeMoreUrl(
  bases: LinkBases,
  source: SeeMoreSource,
  mediaType: SeeMoreMediaType
): string | null {
  if (source === 'seerr') {
    if (!bases.seerr) return null;
    return `${trimBase(bases.seerr)}/discover/${mediaType === 'tv' ? 'tv' : 'movies'}`;
  }
  if (!bases.jellyfin) return null;
  return `${trimBase(bases.jellyfin)}${mediaType === 'tv' ? JELLYFIN_TV : JELLYFIN_MOVIES}`;
}
