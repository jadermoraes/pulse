import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

const ALGO = 'aes-256-gcm';
const PREFIX = 'v1:';

let _key: Buffer | null = null;

function dataDir(): string {
  const dbPath = process.env.PULSE_DB ?? '/data/pulse.sqlite';
  // In-memory DB ':memory:' → fall back to /data
  if (dbPath === ':memory:') return '/data';
  return dirname(dbPath);
}

export function getKey(): Buffer {
  if (_key) return _key;

  // Env var: 64-char hex = 32 bytes
  const envKey = process.env.PULSE_SECRET_KEY;
  if (envKey) {
    if (envKey.length !== 64) {
      throw new Error('PULSE_SECRET_KEY must be a 64-character hex string (32 bytes)');
    }
    _key = Buffer.from(envKey, 'hex');
    return _key;
  }

  // Auto-generate and persist at <dataDir>/secret.key
  const dir = dataDir();
  const keyFile = join(dir, 'secret.key');

  if (existsSync(keyFile)) {
    const stored = readFileSync(keyFile, 'utf8').trim();
    _key = Buffer.from(stored, 'hex');
    return _key;
  }

  // Generate new key
  const newKey = randomBytes(32);
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(keyFile, newKey.toString('hex'), { mode: 0o600, encoding: 'utf8' });
  } catch {
    // If we can't persist (e.g. :memory: in tests), just use in-memory key
  }
  _key = newKey;
  return _key;
}

/** Reset the cached key — used by tests only. */
export function _resetKeyCache(): void {
  _key = null;
}

export function encryptSecret(plaintext: string): string {
  const key = getKey();
  const iv = randomBytes(12); // 96-bit IV for GCM
  const cipher = createCipheriv(ALGO, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${PREFIX}${iv.toString('base64')}:${authTag.toString('base64')}:${encrypted.toString('base64')}`;
}

export function decryptSecret(stored: string): string {
  // Backward compat: plaintext (no v1: prefix) → return as-is
  if (!stored.startsWith(PREFIX)) return stored;

  const rest = stored.slice(PREFIX.length);
  const parts = rest.split(':');
  if (parts.length !== 3) {
    throw new Error('Invalid encrypted secret format');
  }
  const [ivB64, authTagB64, ciphertextB64] = parts;
  const key = getKey();
  const iv = Buffer.from(ivB64, 'base64');
  const authTag = Buffer.from(authTagB64, 'base64');
  const ciphertext = Buffer.from(ciphertextB64, 'base64');

  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(authTag);
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return decrypted.toString('utf8');
}
