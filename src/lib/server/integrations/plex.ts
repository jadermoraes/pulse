import type { Connection } from '../connections';
import type { Integration } from './types';
import { registerIntegration } from './registry';

// Minimal Plex Media Server connection: lets an admin supply the OWNER's server URL +
// X-Plex-Token through Settings → Connections. Used by provisioning to (a) resolve the
// server's machineIdentifier and (b) enumerate library sections for the library-share.
// No widgets/actions/detail — Plex content surfaces via the existing Jellyfin/Tautulli paths.

function identityUrl(conn: Connection): string {
  const base = conn.baseUrl.replace(/\/$/, '');
  return `${base}/identity?X-Plex-Token=${encodeURIComponent(conn.secret ?? '')}`;
}

export const plex: Integration = {
  type: 'plex', label: 'Plex', icon: 'plex',
  configSchema: [
    { key: 'baseUrl', label: 'Server URL', type: 'url', required: true, placeholder: 'http://192.168.1.21:32400' },
    { key: 'secret', label: 'X-Plex-Token', type: 'password', required: true }
  ],
  async testConnection(conn) {
    try {
      const res = await fetch(identityUrl(conn), { headers: { Accept: 'application/json' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      // /identity returns the server's machineIdentifier (JSON: MediaContainer.machineIdentifier).
      const machineId = data?.MediaContainer?.machineIdentifier ?? data?.machineIdentifier;
      if (!machineId) return { ok: false, message: 'No machineIdentifier in /identity response' };
      return { ok: true, message: `Connected · Plex ${String(machineId).slice(0, 8)}…` };
    } catch (e) { return { ok: false, message: (e as Error).message }; }
  },
  widgets: {}
};
registerIntegration(plex);
