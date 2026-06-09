import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { encryptSecret, decryptSecret, getKey, _resetKeyCache } from './crypto';

// Use a temp dir for key file tests
const tmpDir = join('/tmp', 'pulse-crypto-test-' + process.pid);

beforeEach(() => {
  _resetKeyCache();
  delete process.env.PULSE_SECRET_KEY;
  delete process.env.PULSE_DB;
  // Clean up any leftover tmp dir
  if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
});

afterEach(() => {
  _resetKeyCache();
  delete process.env.PULSE_SECRET_KEY;
  delete process.env.PULSE_DB;
  if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
});

describe('crypto', () => {
  it('round-trip encrypts and decrypts a secret', () => {
    process.env.PULSE_SECRET_KEY = 'a'.repeat(64);
    const plain = 'my-super-secret-api-key-123!';
    const encrypted = encryptSecret(plain);
    expect(encrypted).toMatch(/^v1:/);
    expect(encrypted).not.toContain(plain);
    expect(decryptSecret(encrypted)).toBe(plain);
  });

  it('produces different ciphertext each call (random IV)', () => {
    process.env.PULSE_SECRET_KEY = 'b'.repeat(64);
    const enc1 = encryptSecret('same-value');
    const enc2 = encryptSecret('same-value');
    expect(enc1).not.toBe(enc2);
    expect(decryptSecret(enc1)).toBe('same-value');
    expect(decryptSecret(enc2)).toBe('same-value');
  });

  it('plaintext passthrough: decryptSecret returns value as-is when no v1: prefix', () => {
    process.env.PULSE_SECRET_KEY = 'c'.repeat(64);
    expect(decryptSecret('old-plaintext-api-key')).toBe('old-plaintext-api-key');
    expect(decryptSecret('')).toBe('');
    expect(decryptSecret('https://user:pass@host')).toBe('https://user:pass@host');
  });

  it('throws on malformed v1: format', () => {
    process.env.PULSE_SECRET_KEY = 'd'.repeat(64);
    expect(() => decryptSecret('v1:onlyone')).toThrow('Invalid encrypted secret format');
    expect(() => decryptSecret('v1:a:b')).toThrow('Invalid encrypted secret format');
  });

  it('uses env key when PULSE_SECRET_KEY is set', () => {
    const hexKey = '0f'.repeat(32); // 64 hex chars
    process.env.PULSE_SECRET_KEY = hexKey;
    const k = getKey();
    expect(k.toString('hex')).toBe(hexKey);
  });

  it('rejects PULSE_SECRET_KEY that is not 64 hex chars', () => {
    process.env.PULSE_SECRET_KEY = 'tooshort';
    expect(() => getKey()).toThrow('PULSE_SECRET_KEY must be a 64-character hex string');
  });

  it('auto-generates and persists key to file, reusing across calls', () => {
    mkdirSync(tmpDir, { recursive: true });
    process.env.PULSE_DB = join(tmpDir, 'pulse.sqlite');

    const k1 = getKey();
    _resetKeyCache();
    const k2 = getKey();

    expect(k1.toString('hex')).toBe(k2.toString('hex'));
    expect(k1.length).toBe(32);
  });

  it('round-trips with file-based key', () => {
    mkdirSync(tmpDir, { recursive: true });
    process.env.PULSE_DB = join(tmpDir, 'pulse.sqlite');

    const plain = 'token-abc-xyz';
    const enc = encryptSecret(plain);
    _resetKeyCache();
    expect(decryptSecret(enc)).toBe(plain);
  });
});
