import type { LibraryItem } from './jellyfin-library';

export const CATALOG_IDS = { movie: 'pulse-movies', series: 'pulse-series' } as const;
const MAX_SKIP = 100000;

/**
 * `meta` is deliberately absent from `resources`. Items are keyed by imdb id, and Cinemeta —
 * installed by default in every Stremio — serves the detail page for a `tt` id. Declaring `meta`
 * would make pulse responsible for season/episode metadata trees it models nowhere.
 */
export function buildManifest(): Record<string, unknown> {
  const extra = [{ name: 'search', isRequired: false }, { name: 'skip', isRequired: false }];
  return {
    id: 'com.pulse.jellyfin',
    version: '1.0.0',
    name: 'Pulse',
    description: 'Your Jellyfin library, and a way to ask pulse for what is missing.',
    resources: ['catalog', 'stream'],
    types: ['movie', 'series'],
    idPrefixes: ['tt'],
    catalogs: [
      { type: 'movie', id: CATALOG_IDS.movie, name: 'Pulse — Movies', extra },
      { type: 'series', id: CATALOG_IDS.series, name: 'Pulse — Series', extra }
    ],
    behaviorHints: { configurable: false, configurationRequired: false }
  };
}

const MAX_SEARCH_LEN = 200;

/** Extras arrive as a query string stringified into one path segment. */
export function parseExtras(raw: string | undefined): { search?: string; skip: number } {
  const p = new URLSearchParams(raw ?? '');
  const rawSkip = Number(p.get('skip'));
  // Number.isFinite is not load-bearing here: NaN > 0 is false, and Math.min(..., MAX_SKIP)
  // already catches Infinity. Kept for readability, not correctness.
  const skip = Number.isFinite(rawSkip) && rawSkip > 0 ? Math.min(Math.floor(rawSkip), MAX_SKIP) : 0;
  const search = (p.get('search') ?? '')
    // Strip control characters. Write the range as ESCAPES in the source,
    // never as literal control bytes.
    .replace(/[\x00-\x1f\x7f]/g, '')
    .trim()
    .slice(0, MAX_SEARCH_LEN);
  return search ? { search, skip } : { skip };
}

export function toMetaPreviews(
  items: LibraryItem[], origin: string, token: string
): Array<Record<string, unknown>> {
  return items.map((i) => {
    const meta: Record<string, unknown> = { id: i.imdbId, type: i.type, name: i.name };
    if (i.year !== null) meta.releaseInfo = String(i.year);
    // Posters go through pulse for the same reason streams do: the Jellyfin key stays server-side.
    if (i.posterTag) {
      meta.poster = `${origin}/api/_public/addon/${token}/poster/${i.jellyfinId}/${i.posterTag}`;
    }
    return meta;
  });
}
