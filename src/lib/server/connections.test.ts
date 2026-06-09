import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, migrate, type DB } from './db';
import { createConnection, listConnections, listConnectionsPublic, getConnection, updateConnection, deleteConnection } from './connections';

let db: DB;
beforeEach(() => { db = openDb(':memory:'); migrate(db); });

describe('connections', () => {
  it('creates, lists, gets, updates, deletes', () => {
    const id = createConnection(db, { type: 'jellyfin', name: 'JF', baseUrl: 'http://x:8096', secret: 'k', options: {} });
    expect(listConnections(db)).toHaveLength(1);
    expect(getConnection(db, id)?.name).toBe('JF');
    updateConnection(db, id, { name: 'JF2' });
    expect(getConnection(db, id)?.name).toBe('JF2');
    deleteConnection(db, id);
    expect(listConnections(db)).toHaveLength(0);
  });

  it('listConnectionsPublic omits secret and options fields', () => {
    createConnection(db, { type: 'jellyfin', name: 'JF', baseUrl: 'http://x:8096', secret: 'super-secret-key', options: { extra: 1 } });
    const results = listConnectionsPublic(db);
    expect(results).toHaveLength(1);
    const conn = results[0];
    expect('secret' in conn).toBe(false);
    expect('options' in conn).toBe(false);
    expect(conn.name).toBe('JF');
    expect(conn.type).toBe('jellyfin');
    expect(conn.baseUrl).toBe('http://x:8096');
    expect(conn.enabled).toBe(true);
  });

  it('updateConnection preserves existing secret when caller reads existing and passes it through', () => {
    // This simulates the server action: blank edit field → read existing secret → pass it to updateConnection.
    const id = createConnection(db, { type: 'jellyfin', name: 'JF', baseUrl: 'http://x:8096', secret: 'original-key', options: {} });
    const existing = getConnection(db, id)!;
    // Caller resolves: blank secret field → keep existing.secret
    const secretRaw = '';  // blank form field
    const resolvedSecret = secretRaw !== '' ? secretRaw : existing.secret;
    updateConnection(db, id, { name: 'JF-renamed', secret: resolvedSecret });
    const updated = getConnection(db, id);
    expect(updated?.name).toBe('JF-renamed');
    expect(updated?.secret).toBe('original-key');
  });

  it('updateConnection replaces secret when a new one is provided', () => {
    const id = createConnection(db, { type: 'jellyfin', name: 'JF', baseUrl: 'http://x:8096', secret: 'old-key', options: {} });
    updateConnection(db, id, { secret: 'new-key' });
    const updated = getConnection(db, id);
    expect(updated?.secret).toBe('new-key');
  });

  it('updateConnection toggles enabled flag', () => {
    const id = createConnection(db, { type: 'jellyfin', name: 'JF', baseUrl: 'http://x:8096', secret: null, options: {} });
    expect(getConnection(db, id)?.enabled).toBe(true);
    updateConnection(db, id, { enabled: false });
    expect(getConnection(db, id)?.enabled).toBe(false);
    updateConnection(db, id, { enabled: true });
    expect(getConnection(db, id)?.enabled).toBe(true);
  });
});
