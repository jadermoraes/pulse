import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { openDb, migrate, type DB } from '../db';
import { _resetKeyCache, encryptSecret } from '../crypto';
import { getSetting, setSetting } from '../settings';
import {
  loadAiRefs, saveAiRefs, getModel, getConsumerModel,
  getConfigTemperature, getConsumerTemperature, modelFromConnection
} from './provider';
import { createAiConnection, getAiConnection } from './ai-connections';

let db: DB;
beforeEach(() => { db = openDb(':memory:'); migrate(db); _resetKeyCache(); });
afterEach(() => vi.restoreAllMocks());

describe('provider refs', () => {
  it('returns empty refs when nothing is configured', () => {
    const refs = loadAiRefs(db);
    expect(refs.adminConnectionId).toBeNull();
    expect(refs.consumerConnectionId).toBeNull();
    expect(getModel(db)).toBeNull();
    expect(getConsumerModel(db)).toBeNull();
  });

  it('getModel resolves admin ref → connection → model for each provider', () => {
    const a = createAiConnection(db, { label: 'A', provider: 'anthropic', apiKey: 'k' });
    saveAiRefs(db, { adminConnectionId: a, adminModel: 'claude-3-5-haiku-latest', adminTemperature: 0.2, consumerConnectionId: null, consumerModel: null });
    expect(getModel(db)).toBeTruthy();
    expect(getConfigTemperature(db)).toBe(0.2);

    const o = createAiConnection(db, { label: 'O', provider: 'openai', apiKey: 'k' });
    saveAiRefs(db, { adminConnectionId: o, adminModel: 'gpt-4o-mini', consumerConnectionId: null, consumerModel: null });
    expect(getModel(db)).toBeTruthy();

    const g = createAiConnection(db, { label: 'G', provider: 'google', apiKey: 'k' });
    saveAiRefs(db, { adminConnectionId: g, adminModel: 'gemini-1.5-flash', consumerConnectionId: null, consumerModel: null });
    expect(getModel(db)).toBeTruthy();

    const c = createAiConnection(db, { label: 'C', provider: 'openai-compatible', baseUrl: 'http://ollama:11434/v1' });
    saveAiRefs(db, { adminConnectionId: c, adminModel: 'llama3.1', consumerConnectionId: null, consumerModel: null });
    expect(getModel(db)).toBeTruthy();
  });

  it('modelFromConnection returns null with no connection or no model', () => {
    const a = createAiConnection(db, { label: 'A', provider: 'anthropic', apiKey: 'k' });
    expect(modelFromConnection(getAiConnection(db, a), null)).toBeNull();
    expect(modelFromConnection(null, 'm')).toBeNull();
    expect(modelFromConnection(getAiConnection(db, a), 'm')).toBeTruthy();
  });
});

describe('consumer model resolution', () => {
  it('uses the consumer ref when set', () => {
    const admin = createAiConnection(db, { label: 'A', provider: 'anthropic', apiKey: 'ADMIN' });
    const cons = createAiConnection(db, { label: 'C', provider: 'anthropic', apiKey: 'VIEWER' });
    saveAiRefs(db, {
      adminConnectionId: admin, adminModel: 'claude-opus-4',
      consumerConnectionId: cons, consumerModel: 'claude-haiku-4', consumerTemperature: 0.5
    });
    expect(getConsumerModel(db)).toBeTruthy();
    expect(getConsumerTemperature(db)).toBe(0.5);
  });

  it('falls back to the admin model when no consumer ref is set', () => {
    const admin = createAiConnection(db, { label: 'A', provider: 'anthropic', apiKey: 'ADMIN' });
    saveAiRefs(db, { adminConnectionId: admin, adminModel: 'claude-opus-4', consumerConnectionId: null, consumerModel: null });
    expect(getConsumerModel(db)).toBeTruthy(); // == admin model
  });

  it('fallback: consumer model unset + admin model set => getConsumerModel returns a model (not null)', () => {
    // Win 1: consumer chat must never hard-stop when admin model is configured but no consumer
    // model is separately configured. getConsumerModel() must fall back to getModel().
    expect(getConsumerModel(db)).toBeNull(); // neither configured yet
    const adminConnId = createAiConnection(db, { label: 'Admin', provider: 'openai', apiKey: 'sk-admin' });
    saveAiRefs(db, {
      adminConnectionId: adminConnId, adminModel: 'gpt-4o-mini',
      consumerConnectionId: null, consumerModel: null  // consumer deliberately unconfigured
    });
    const model = getConsumerModel(db);
    expect(model).not.toBeNull(); // falls back to admin model
    expect(getModel(db)).not.toBeNull(); // admin model itself is set
    // Both should resolve (fallback means consumer === admin model instance)
    expect(model).toBeTruthy();
  });

  it('returns null when neither admin nor consumer model is configured', () => {
    // Confirm the friendly error path is still reachable when truly nothing is set.
    saveAiRefs(db, { adminConnectionId: null, adminModel: null, consumerConnectionId: null, consumerModel: null });
    expect(getConsumerModel(db)).toBeNull();
    expect(getModel(db)).toBeNull();
  });
});

describe('legacy ai_config migration', () => {
  it('migrates old inlined-key admin config to a connection + refs (idempotent)', () => {
    // Seed the legacy shape directly.
    setSetting(db, 'ai_config', JSON.stringify({
      provider: 'anthropic', model: 'claude-opus-4', temperature: 0.3,
      apiKeyEnc: encryptSecret('ADMIN-KEY')
    }));

    const refs = loadAiRefs(db);
    expect(refs.adminConnectionId).not.toBeNull();
    expect(refs.adminModel).toBe('claude-opus-4');
    expect(refs.adminTemperature).toBe(0.3);

    // Connection holds the decrypted key.
    const conn = getAiConnection(db, refs.adminConnectionId!)!;
    expect(conn.provider).toBe('anthropic');
    expect(conn.secret).toBe('ADMIN-KEY');
    expect(conn.label).toBe('Default');

    // ai_config rewritten to ref shape — no key, no provider inlined.
    const rewritten = getSetting(db, 'ai_config')!;
    expect(rewritten).not.toContain('ADMIN-KEY');
    expect(rewritten).not.toContain('apiKeyEnc');
    expect(rewritten).toContain('adminConnectionId');

    // Idempotent: a second load does not create another connection.
    const before = (db.prepare('select count(*) c from ai_connections').get() as any).c;
    loadAiRefs(db);
    const after = (db.prepare('select count(*) c from ai_connections').get() as any).c;
    expect(after).toBe(before);
  });

  it('migrates distinct consumer provider/key into a second connection', () => {
    setSetting(db, 'ai_config', JSON.stringify({
      provider: 'anthropic', model: 'claude-opus-4', apiKeyEnc: encryptSecret('ADMIN-KEY'),
      consumerProvider: 'openai', consumerModel: 'gpt-4o-mini', consumerApiKeyEnc: encryptSecret('VIEWER-KEY')
    }));
    const refs = loadAiRefs(db);
    expect(refs.adminConnectionId).not.toBeNull();
    expect(refs.consumerConnectionId).not.toBeNull();
    expect(refs.consumerConnectionId).not.toBe(refs.adminConnectionId);
    expect(refs.consumerModel).toBe('gpt-4o-mini');
    const consumerConn = getAiConnection(db, refs.consumerConnectionId!)!;
    expect(consumerConn.provider).toBe('openai');
    expect(consumerConn.secret).toBe('VIEWER-KEY');
    expect((db.prepare('select count(*) c from ai_connections').get() as any).c).toBe(2);
  });

  it('reuses the admin connection when the consumer creds are identical', () => {
    setSetting(db, 'ai_config', JSON.stringify({
      provider: 'anthropic', model: 'claude-opus-4', apiKeyEnc: encryptSecret('SAME'),
      consumerProvider: 'anthropic', consumerModel: 'claude-haiku-4', consumerApiKeyEnc: encryptSecret('SAME')
    }));
    const refs = loadAiRefs(db);
    expect(refs.consumerConnectionId).toBe(refs.adminConnectionId);
    expect((db.prepare('select count(*) c from ai_connections').get() as any).c).toBe(1);
  });

  it('handles an unconfigured (no ai_config) instance cleanly', () => {
    expect(getSetting(db, 'ai_config')).toBeNull();
    const refs = loadAiRefs(db);
    expect(refs.adminConnectionId).toBeNull();
    expect((db.prepare('select count(*) c from ai_connections').get() as any).c).toBe(0);
  });
});
