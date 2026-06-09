import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, migrate, type DB } from '../db';
import { createRole } from './roles';
import { createConsumer } from './consumers';
import { mintReset, getReset, consumeReset } from './password-reset';

let db: DB; let consumerId: number;
beforeEach(() => {
  db = openDb(':memory:'); migrate(db);
  const roleId = createRole(db, { name: 'M', allowList: ['discover'], monthlyTokenCap: null, autoApprove: false, seerrQuota: {} });
  consumerId = createConsumer(db, { roleId, displayName: 'Ana', language: 'en' });
});

describe('password-reset', () => {
  it('mints a token resolvable via getReset', () => {
    const { token } = mintReset(db, consumerId);
    expect(token).toHaveLength(48);
    expect(getReset(db, token)!.consumerId).toBe(consumerId);
  });

  it('consumeReset returns the consumer id and is single-use', () => {
    const { token } = mintReset(db, consumerId);
    expect(consumeReset(db, token)).toBe(consumerId);
    expect(() => consumeReset(db, token)).toThrow();
    expect(getReset(db, token)).toBeNull(); // used ⇒ no longer valid
  });

  it('getReset rejects an expired token', () => {
    const { token } = mintReset(db, consumerId, -1000); // already expired
    expect(getReset(db, token)).toBeNull();
  });

  it('getReset returns null for an unknown token', () => {
    expect(getReset(db, 'nope')).toBeNull();
  });
});
