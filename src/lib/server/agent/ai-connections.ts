import type { DB } from '../db';
import { encryptSecret, decryptSecret } from '../crypto';
import type { AiProvider } from './provider';

/** A stored AI connection WITH its decrypted secret. Server-only — never serialize to a client. */
export interface AiConnection {
  id: number;
  label: string;
  provider: AiProvider;
  baseUrl: string | null;
  secret: string | null; // decrypted plaintext key (null for local/keyless providers)
  createdAt: number;
}

/** Safe public shape — NO secret, just a presence flag. */
export interface AiConnectionPublic {
  id: number;
  label: string;
  provider: AiProvider;
  baseUrl: string | null;
  hasKey: boolean;
}

export interface NewAiConnection {
  label: string;
  provider: AiProvider;
  baseUrl?: string | null;
  apiKey?: string | null; // plaintext; encrypted before insert
}

function row(r: any): AiConnection {
  return {
    id: r.id,
    label: r.label,
    provider: r.provider,
    baseUrl: r.base_url ?? null,
    secret: r.secret != null ? decryptSecret(r.secret) : null,
    createdAt: r.created_at
  };
}

export function createAiConnection(db: DB, c: NewAiConnection): number {
  const encSecret = c.apiKey ? encryptSecret(c.apiKey) : null;
  const info = db
    .prepare('insert into ai_connections (label,provider,base_url,secret,created_at) values (?,?,?,?,?)')
    .run(c.label, c.provider, c.baseUrl ?? null, encSecret, Date.now());
  return Number(info.lastInsertRowid);
}

export function listAiConnections(db: DB): AiConnectionPublic[] {
  return (db.prepare('select id,label,provider,base_url,secret from ai_connections order by id').all() as any[])
    .map((r) => ({
      id: r.id,
      label: r.label,
      provider: r.provider as AiProvider,
      baseUrl: r.base_url ?? null,
      hasKey: r.secret != null
    }));
}

/** Server-only: returns the decrypted secret. Never expose the result to a client. */
export function getAiConnection(db: DB, id: number): AiConnection | null {
  const r = db.prepare('select * from ai_connections where id=?').get(id) as any;
  return r ? row(r) : null;
}

export interface AiConnectionPatch {
  label?: string;
  provider?: AiProvider;
  baseUrl?: string | null;
  /** When provided: a non-empty string replaces the key; an empty string clears it. Omit to keep existing. */
  apiKey?: string;
}

export function updateAiConnection(db: DB, id: number, patch: AiConnectionPatch): void {
  const cur = getAiConnection(db, id);
  if (!cur) return;
  const label = patch.label ?? cur.label;
  const provider = patch.provider ?? cur.provider;
  const baseUrl = patch.baseUrl !== undefined ? patch.baseUrl : cur.baseUrl;
  // apiKey omitted → keep current; '' → clear; non-empty → replace.
  const nextPlain = patch.apiKey === undefined ? cur.secret : (patch.apiKey || null);
  const encSecret = nextPlain ? encryptSecret(nextPlain) : null;
  db.prepare('update ai_connections set label=?,provider=?,base_url=?,secret=? where id=?')
    .run(label, provider, baseUrl ?? null, encSecret, id);
}

export function deleteAiConnection(db: DB, id: number): void {
  db.prepare('delete from ai_connections where id=?').run(id);
}
