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
    description: `\u25b6 Play from your library\n${name}`,
    behaviorHints: {
      // The proxy is plain http on the LAN and the container is whatever Jellyfin holds, so the
      // client must not assume a web-ready mp4 over https.
      notWebReady: true
    }
  };
}

/** The audio preference a request carries. The same two values the PWA's movie modal offers, so
 *  a title requested from the TV and one requested from the phone mean the same thing. */
export type RequestAudio = 'ptbr' | 'original';

/** Stremio has no input widget of any kind — the stream list IS the picker, so every choice has
 *  to be its own selectable row. Two is the whole vocabulary: more rows would bury the actual
 *  play sources under a menu. */
const AUDIO_LABEL: Record<RequestAudio, string> = {
  ptbr: '\ud83c\udde7\ud83c\uddf7 Portuguese audio',
  original: 'Original audio'
};

/** Offer order. Portuguese first, matching the order the PWA's modal puts its two buttons in. */
export const REQUEST_AUDIOS: readonly RequestAudio[] = ['ptbr', 'original'];

/** The value arrives as a URL path segment. Anything that is not one of the two is not a
 *  preference we can honour — reject it rather than quietly filing the request as 'original',
 *  which would hand someone the wrong audio and no way to tell. */
export function parseRequestAudio(raw: string): RequestAudio | null {
  return raw === 'ptbr' || raw === 'original' ? raw : null;
}

export function buildRequestStream(
  origin: string, token: string, type: string, id: string, audio: RequestAudio
): Record<string, unknown> {
  return {
    url: `${origin}/api/_public/addon/${token}/request/${type}/${id}/${audio}`,
    name: 'Pulse',
    description: `\uff0b Request on Pulse\n${AUDIO_LABEL[audio]}`,
    behaviorHints: { notWebReady: true }
  };
}
