// Optional public-facing base URL for VIEWER-clicked links and deep-links when the
// consumer PWA is exposed publicly (e.g. behind a Cloudflare tunnel / reverse proxy).
//
// Pulse keeps fetching data + posters over each connection's `baseUrl` (the fast,
// LAN-internal address), so these envs DON'T affect internal traffic — they only
// change the "Watch / Request / See more" hotlinks and per-item deep-links a viewer
// would open in a new tab. Leave unset for LAN-only deployments (falls back to baseUrl).
//
//   PULSE_PUBLIC_JELLYFIN_URL=https://watch.example.com
//   PULSE_PUBLIC_PLEX_URL=https://plex.example.com
//   PULSE_PUBLIC_SEERR_URL=https://request.example.com
export function publicBase(type: string, baseUrl: string): string {
  const env =
    type === 'jellyfin' ? process.env.PULSE_PUBLIC_JELLYFIN_URL :
    type === 'plex'     ? process.env.PULSE_PUBLIC_PLEX_URL :
    type === 'seerr'    ? process.env.PULSE_PUBLIC_SEERR_URL :
    undefined;
  const trimmed = env?.trim();
  return trimmed ? trimmed : baseUrl;
}
