// Real IMDb ids are 7-9 digits; the ceiling here is generous, not exact. Bounding season/episode
// digit runs keeps Number() from ever landing on Infinity or a value past Number.MAX_SAFE_INTEGER.
const ID_RE = /^(tt\d{1,12})(?::(\d{1,4}):(\d{1,5}))?$/;

export function parseStreamId(
  raw: string
): { imdbId: string; season: number | null; episode: number | null } | null {
  const m = ID_RE.exec(raw);
  if (!m) return null;
  if (m[2] === undefined) return { imdbId: m[1], season: null, episode: null };
  const season = Number(m[2]);
  const episode = Number(m[3]);
  // The regex's digit-count caps already keep these well under MAX_SAFE_INTEGER; the
  // isSafeInteger checks are belt-and-braces in case the regex is ever loosened independently.
  if (!Number.isSafeInteger(season) || !Number.isSafeInteger(episode)) return null;
  // Season and episode are 1-based; 0 or negative is malformed, not a real address.
  if (season < 1 || episode < 1) return null;
  return { imdbId: m[1], season, episode };
}

export function buildPlayStream(
  origin: string, token: string, jellyfinItemId: string, name: string
): Record<string, unknown> {
  return {
    url: `${origin}/api/_public/addon/${token}/play/${jellyfinItemId}`,
    name: 'Pulse',
    description: `Play ${name} from your library`,
    behaviorHints: {
      // The proxy is plain http on the LAN and the container is whatever Jellyfin holds, so the
      // client must not assume a web-ready mp4 over https.
      notWebReady: true
    }
  };
}

export function buildRequestStream(
  origin: string, token: string, type: string, id: string
): Record<string, unknown> {
  return {
    url: `${origin}/api/_public/addon/${token}/request/${type}/${id}`,
    name: 'Pulse',
    description: 'Not in your library — select to request it on pulse',
    behaviorHints: { notWebReady: true }
  };
}
