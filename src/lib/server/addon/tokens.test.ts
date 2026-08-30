import { it, expect, beforeEach } from 'vitest';
import { openDb, migrate, type DB } from '../db';
import {
  mintAddonToken, resolveAddonToken, touchAddonToken, revokeAddonToken, readAddonToken
} from './tokens';

let db: DB;
let a: number;
let b: number;
beforeEach(() => {
  db = openDb(':memory:'); migrate(db);
  db.prepare('INSERT INTO roles(id,name,created_at) VALUES (2,?,?)').run('viewer', Date.now());
  const mk = (n: string) => Number(db.prepare(
    "INSERT INTO consumer_users(role_id,display_name,status,created_at) VALUES (2,?,'active',?)"
  ).run(n, Date.now()).lastInsertRowid);
  a = mk('Jader'); b = mk('Jessica');
});

it('mints a high-entropy hex token', () => {
  const t = mintAddonToken(db, { consumerId: a, label: 'TV' });
  expect(t).toMatch(/^[0-9a-f]{48}$/);
});

it('resolves a live token to its consumer', () => {
  const t = mintAddonToken(db, { consumerId: a, label: 'TV' });
  expect(resolveAddonToken(db, t)).toEqual({ token: t, consumerId: a });
});

// NOTE: this one does NOT exercise the shape guard — every input below is also rejected by the
// parameterised query, so it stays green with the guard deleted. It is kept for what it genuinely
// covers (an unknown token never resolves). The guard itself is defended by the two tests below,
// which put a matchable row in the table first.
it('returns null for a token that was never minted', () => {
  mintAddonToken(db, { consumerId: a, label: 'TV' });
  for (const bad of ['', 'nope', 'x'.repeat(48), '../../etc/passwd', "' OR 1=1 --"]) {
    expect(resolveAddonToken(db, bad)).toBeNull();
  }
});

// Also non-discriminating on its own (mint only ever stores conforming shapes, so exact-match
// rejects these anyway) — kept because it documents the intended contract at the API boundary.
it('rejects a live token that has been padded, cased or wrapped', () => {
  const t = mintAddonToken(db, { consumerId: a, label: 'TV' });
  expect(resolveAddonToken(db, t)).not.toBeNull(); // the token itself is genuinely live

  // Each of these embeds the REAL token. A missing or unanchored guard would let the query see
  // something it can match, so unlike the unknown-token cases these actually exercise the check.
  for (const bad of [
    t + '\n',
    t + ' ',
    ' ' + t,
    t.toUpperCase(),
    `../${t}/manifest.json`,
    `${t}/../../etc/passwd`
  ]) {
    expect(resolveAddonToken(db, bad)).toBeNull();
  }
});

it('rejects a live row whose stored token does not have exactly the minted shape', () => {
  // mintAddonToken only ever stores conforming lowercase-48-hex tokens, so every variant above
  // (padded, cased, wrapped) differs from the stored row byte-for-byte and is rejected by the
  // exact-match query alone — that test passes even with the guard deleted or unanchored, so it
  // does not actually exercise the guard. To make the guard the only thing standing between a
  // malformed-shape input and a match, insert a row directly (bypassing mint) whose token is
  // wrapped in non-hex characters, and query with that exact same string: the row is live and an
  // exact match for the query, so only the shape guard can reject it.
  const t = mintAddonToken(db, { consumerId: a, label: 'TV' });
  revokeAddonToken(db);
  const wrapped = `xx${t}xx`;
  db.prepare('INSERT INTO addon_tokens(token,consumer_id,label,created_at) VALUES (?,?,?,?)')
    .run(wrapped, a, 'weird', Date.now());
  expect(resolveAddonToken(db, wrapped)).toBeNull();
});

it('touch does not resurrect activity on a revoked token', () => {
  const t = mintAddonToken(db, { consumerId: a, label: 'TV' });
  revokeAddonToken(db);
  touchAddonToken(db, t);
  const row = db.prepare('SELECT last_used_at FROM addon_tokens WHERE token=?').get(t) as any;
  // The admin panel reads last_used_at to answer "is the TV using this?". A revoked URL being
  // hammered must not look like live use.
  expect(row.last_used_at).toBeNull();
});

it('a failed mint rolls back, leaving the previous token live rather than none at all', () => {
  const first = mintAddonToken(db, { consumerId: a, label: 'TV' });
  // consumer_id has a FK to consumer_users and foreign_keys is ON, so this insert throws.
  expect(() => mintAddonToken(db, { consumerId: 99999, label: 'bogus' })).toThrow();
  // Without the transaction the revoke would have committed and the household would have NO
  // working addon URL, with nothing to tell them why.
  expect(resolveAddonToken(db, first)).toEqual({ token: first, consumerId: a });
});

it('returns null once revoked', () => {
  const t = mintAddonToken(db, { consumerId: a, label: 'TV' });
  revokeAddonToken(db);
  expect(resolveAddonToken(db, t)).toBeNull();
  expect(readAddonToken(db)).toBeNull();
});

it('minting again revokes the previous token', () => {
  const first = mintAddonToken(db, { consumerId: a, label: 'TV' });
  const second = mintAddonToken(db, { consumerId: b, label: 'PC' });
  expect(second).not.toBe(first);
  // The old URL must stop working the moment a new one is minted, or a leaked token survives
  // a "regenerate".
  expect(resolveAddonToken(db, first)).toBeNull();
  expect(resolveAddonToken(db, second)).toEqual({ token: second, consumerId: b });
  expect(readAddonToken(db)!.token).toBe(second);
});

it('touch records last use without changing anything else', () => {
  const t = mintAddonToken(db, { consumerId: a, label: 'TV' });
  expect(readAddonToken(db)!.lastUsedAt).toBeNull();
  touchAddonToken(db, t);
  const r = readAddonToken(db)!;
  expect(r.lastUsedAt).toEqual(expect.any(Number));
  expect(r.consumerId).toBe(a);
  expect(r.label).toBe('TV');
});

it('deleting the attributed consumer revokes the token', () => {
  const t = mintAddonToken(db, { consumerId: a, label: 'TV' });
  db.prepare('DELETE FROM consumer_users WHERE id=?').run(a);
  expect(resolveAddonToken(db, t)).toBeNull();
  expect(readAddonToken(db)).toBeNull();
});

it('is a no-op rather than a throw when nothing is minted', () => {
  expect(() => { revokeAddonToken(db); touchAddonToken(db, 'whatever'); }).not.toThrow();
  expect(readAddonToken(db)).toBeNull();
});
