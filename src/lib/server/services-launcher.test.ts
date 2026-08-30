import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { openDb, migrate, type DB } from './db';
import { createConnection } from './connections';
import * as docker from './docker';
import { getServiceLinks, setServiceLinks } from './services-launcher';

let db: DB;
beforeEach(() => {
  db = openDb(':memory:');
  migrate(db);
  // By default, make docker unreachable so existing tests see only connection-derived links.
  vi.spyOn(docker, 'dockerRequest').mockRejectedValue(new Error('no docker'));
});
afterEach(() => vi.restoreAllMocks());

describe('getServiceLinks — default from connections', () => {
  it('returns empty list when there are no connections and no setting', async () => {
    expect(await getServiceLinks(db)).toEqual([]);
  });

  it('derives defaults from enabled connections with a baseUrl', async () => {
    createConnection(db, { type: 'jellyfin', name: 'Jellyfin', baseUrl: 'http://jellyfin:8096', secret: null, options: {} });
    createConnection(db, { type: 'radarr', name: 'Radarr', baseUrl: 'https://radarr.home.example.com', secret: 'k', options: {} });
    const links = await getServiceLinks(db);
    expect(links).toEqual([
      { name: 'Jellyfin', url: 'http://jellyfin:8096' },
      { name: 'Radarr', url: 'https://radarr.home.example.com' }
    ]);
  });

  it('skips disabled connections', async () => {
    createConnection(db, { type: 'jellyfin', name: 'JF', baseUrl: 'http://jf:8096', secret: null, options: {}, enabled: false });
    expect(await getServiceLinks(db)).toEqual([]);
  });

  it('skips connections with empty baseUrl', async () => {
    createConnection(db, { type: 'proxmox', name: 'PVE', baseUrl: '', secret: null, options: {} });
    expect(await getServiceLinks(db)).toEqual([]);
  });
});

describe('setServiceLinks + getServiceLinks — round-trip', () => {
  it('persists and returns the curated list', async () => {
    const input = [
      { name: 'Proxmox', url: 'https://pve.home.example.com' },
      { name: 'Portainer', url: 'http://portainer:9000' }
    ];
    setServiceLinks(db, input);
    expect(await getServiceLinks(db)).toEqual(input);
  });

  it('returns the curated list even when enabled connections exist', async () => {
    createConnection(db, { type: 'jellyfin', name: 'JF', baseUrl: 'http://jf:8096', secret: null, options: {} });
    setServiceLinks(db, [{ name: 'Custom', url: 'http://custom.example.com' }]);
    expect(await getServiceLinks(db)).toEqual([{ name: 'Custom', url: 'http://custom.example.com' }]);
  });

  it('allows persisting an empty list to clear defaults', async () => {
    createConnection(db, { type: 'jellyfin', name: 'JF', baseUrl: 'http://jf:8096', secret: null, options: {} });
    setServiceLinks(db, []);
    expect(await getServiceLinks(db)).toEqual([]);
  });
});

describe('setServiceLinks — validation / filtering', () => {
  it('drops entries with non-http URLs', async () => {
    setServiceLinks(db, [
      { name: 'Good', url: 'https://good.example.com' },
      { name: 'Bad FTP', url: 'ftp://bad.example.com' },
      { name: 'Bad plain', url: 'not-a-url' }
    ]);
    expect(await getServiceLinks(db)).toEqual([{ name: 'Good', url: 'https://good.example.com' }]);
  });

  it('drops entries with empty name', async () => {
    setServiceLinks(db, [
      { name: '', url: 'https://example.com' },
      { name: '  ', url: 'https://example.com' },
      { name: 'Valid', url: 'https://example.com' }
    ]);
    expect(await getServiceLinks(db)).toEqual([{ name: 'Valid', url: 'https://example.com' }]);
  });

  it('drops non-object entries', async () => {
    setServiceLinks(db, [null, 'string', 42, { name: 'OK', url: 'http://ok.example.com' }]);
    expect(await getServiceLinks(db)).toEqual([{ name: 'OK', url: 'http://ok.example.com' }]);
  });

  it('trims name and url', async () => {
    setServiceLinks(db, [{ name: '  Trimmed  ', url: '  https://example.com  ' }]);
    expect(await getServiceLinks(db)).toEqual([{ name: 'Trimmed', url: 'https://example.com' }]);
  });
});

describe('getServiceLinks — non-launchable connection types', () => {
  it('excludes a stremio connection from launcher tiles, unlike jellyfin', async () => {
    createConnection(db, { type: 'stremio', name: 'Stremio', baseUrl: 'https://api.strem.io', secret: 'ak', options: {} });
    createConnection(db, { type: 'jellyfin', name: 'Jellyfin', baseUrl: 'http://jellyfin:8096', secret: null, options: {} });
    const links = await getServiceLinks(db);
    expect(links).toEqual([{ name: 'Jellyfin', url: 'http://jellyfin:8096' }]);
  });

  it('skips a stremio connection as the docker host even when it sorts first', async () => {
    // Stremio is created first (lower id) so a `.find()` with no type guard would pick it.
    createConnection(db, { type: 'stremio', name: 'Stremio', baseUrl: 'https://api.strem.io', secret: 'ak', options: {} });
    createConnection(db, { type: 'jellyfin', name: 'Jellyfin', baseUrl: 'http://jellyfin:8096', secret: null, options: {} });
    vi.spyOn(docker, 'dockerRequest').mockResolvedValue({ status: 200, data: [
      { Names: ['/portainer'], Ports: [{ PrivatePort: 9000, PublicPort: 9000, Type: 'tcp' }] }
    ] } as any);
    const links = await getServiceLinks(db);
    const portainer = links.find((l) => l.name === 'portainer');
    expect(portainer?.url).toBe('http://jellyfin:9000');
  });
});

describe('getServiceLinks — docker auto-list', () => {
  beforeEach(() => {
    // A connection gives us a known host for building docker URLs.
    createConnection(db, { type: 'jellyfin', name: 'JF', baseUrl: 'http://192.168.1.21:8096', secret: 'K', options: {} });
  });

  it('merges docker containers that publish a web port', async () => {
    vi.spyOn(docker, 'dockerRequest').mockResolvedValue({ status: 200, data: [
      { Names: ['/portainer'], Ports: [{ PrivatePort: 9000, PublicPort: 9000, Type: 'tcp' }] },
      { Names: ['/gluetun'], Ports: [{ PrivatePort: 8000, Type: 'tcp' }] }
    ] } as any);
    const links = await getServiceLinks(db);
    expect(links.some((l) => l.name.toLowerCase().includes('portainer'))).toBe(true);
    expect(links.some((l) => l.name.toLowerCase().includes('gluetun'))).toBe(false);
  });

  it('falls back to connection-derived links when docker is unreachable', async () => {
    vi.spyOn(docker, 'dockerRequest').mockRejectedValue(new Error('down'));
    const links = await getServiceLinks(db);
    expect(links.some((l) => l.name === 'JF')).toBe(true);
  });

  it('skips pulse own container and dedupes by host:port', async () => {
    vi.spyOn(docker, 'dockerRequest').mockResolvedValue({ status: 200, data: [
      { Names: ['/pulse'], Ports: [{ PrivatePort: 3000, PublicPort: 3000, Type: 'tcp' }] },
      { Names: ['/jf-dupe'], Ports: [{ PrivatePort: 8096, PublicPort: 8096, Type: 'tcp' }] }
    ] } as any);
    const links = await getServiceLinks(db);
    expect(links.some((l) => l.name.toLowerCase().includes('pulse'))).toBe(false);
    // JF connection is http://192.168.1.21:8096 — the dupe container on the same host:port is deduped.
    expect(links.filter((l) => l.url === 'http://192.168.1.21:8096').length).toBe(1);
  });
});
