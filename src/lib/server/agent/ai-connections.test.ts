import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, migrate, type DB } from '../db';
import { getSetting } from '../settings';
import {
  createAiConnection, listAiConnections, getAiConnection,
  updateAiConnection, deleteAiConnection
} from './ai-connections';

let db: DB;
beforeEach(() => { db = openDb(':memory:'); migrate(db); });

describe('ai-connections', () => {
  it('creates a connection with the key encrypted at rest', () => {
    const id = createAiConnection(db, { label: 'Default', provider: 'anthropic', apiKey: 'sk-secret' });
    const rawRow = db.prepare('select secret from ai_connections where id=?').get(id) as { secret: string };
    expect(rawRow.secret).toContain('v1:');
    expect(rawRow.secret).not.toContain('sk-secret');
  });

  it('listAiConnections never returns the secret, only hasKey', () => {
    createAiConnection(db, { label: 'A', provider: 'openai', apiKey: 'k' });
    createAiConnection(db, { label: 'B', provider: 'openai-compatible', baseUrl: 'http://ollama:11434/v1' });
    const list = listAiConnections(db);
    expect(list).toHaveLength(2);
    expect(list[0]).toEqual({ id: expect.any(Number), label: 'A', provider: 'openai', baseUrl: null, hasKey: true });
    expect(list[1]).toEqual({ id: expect.any(Number), label: 'B', provider: 'openai-compatible', baseUrl: 'http://ollama:11434/v1', hasKey: false });
    expect(JSON.stringify(list)).not.toContain('"k"');
    for (const c of list) expect('secret' in c).toBe(false);
  });

  it('getAiConnection returns the decrypted secret (server-only)', () => {
    const id = createAiConnection(db, { label: 'A', provider: 'anthropic', apiKey: 'sk-secret', baseUrl: 'http://x' });
    const c = getAiConnection(db, id)!;
    expect(c.label).toBe('A');
    expect(c.provider).toBe('anthropic');
    expect(c.baseUrl).toBe('http://x');
    expect(c.secret).toBe('sk-secret');
  });

  it('getAiConnection returns null for a missing id', () => {
    expect(getAiConnection(db, 999)).toBeNull();
  });

  it('updateAiConnection patches label/provider/baseUrl and replaces the key', () => {
    const id = createAiConnection(db, { label: 'A', provider: 'anthropic', apiKey: 'old' });
    updateAiConnection(db, id, { label: 'A2', baseUrl: 'http://y' });
    let c = getAiConnection(db, id)!;
    expect(c.label).toBe('A2');
    expect(c.baseUrl).toBe('http://y');
    expect(c.secret).toBe('old'); // key preserved when not passed
    updateAiConnection(db, id, { apiKey: 'new' });
    c = getAiConnection(db, id)!;
    expect(c.secret).toBe('new');
  });

  it('updateAiConnection can clear the key with an empty string', () => {
    const id = createAiConnection(db, { label: 'A', provider: 'anthropic', apiKey: 'old' });
    updateAiConnection(db, id, { apiKey: '' });
    expect(getAiConnection(db, id)!.secret).toBeNull();
  });

  it('deleteAiConnection removes the row', () => {
    const id = createAiConnection(db, { label: 'A', provider: 'anthropic', apiKey: 'k' });
    deleteAiConnection(db, id);
    expect(getAiConnection(db, id)).toBeNull();
    expect(listAiConnections(db)).toHaveLength(0);
  });
});
