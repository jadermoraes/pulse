import { describe, it, expect } from 'vitest';
import { extractResultUrl } from './chat-actions';

describe('extractResultUrl', () => {
  it('returns url from { ok:true, url:"http://…" } shape (Jellyfin deep-link)', () => {
    const result = { ok: true, url: 'http://192.168.1.21:8096/web/#/details?id=abc123' };
    expect(extractResultUrl(result)).toBe('http://192.168.1.21:8096/web/#/details?id=abc123');
  });

  it('returns https url', () => {
    const result = { ok: true, url: 'https://example.com/page' };
    expect(extractResultUrl(result)).toBe('https://example.com/page');
  });

  it('returns null when result has no url field', () => {
    const result = { ok: true, message: 'done' };
    expect(extractResultUrl(result)).toBeNull();
  });

  it('returns null when url is not http(s) (e.g. a relative path)', () => {
    const result = { ok: true, url: '/relative/path' };
    expect(extractResultUrl(result)).toBeNull();
  });

  it('returns null when url is empty string', () => {
    const result = { ok: true, url: '' };
    expect(extractResultUrl(result)).toBeNull();
  });

  it('returns null for null result', () => {
    expect(extractResultUrl(null)).toBeNull();
  });

  it('returns null for undefined result', () => {
    expect(extractResultUrl(undefined)).toBeNull();
  });

  it('returns null for a non-object primitive', () => {
    expect(extractResultUrl('http://example.com')).toBeNull();
    expect(extractResultUrl(42)).toBeNull();
    expect(extractResultUrl(true)).toBeNull();
  });

  it('returns null for array result', () => {
    expect(extractResultUrl(['http://example.com'])).toBeNull();
  });

  it('falls back to scanning other string fields if url field is absent', () => {
    const result = { ok: true, deepLink: 'http://192.168.1.21:8096/web/#/details?id=xyz' };
    expect(extractResultUrl(result)).toBe('http://192.168.1.21:8096/web/#/details?id=xyz');
  });

  it('ignores non-http strings in other fields during fallback scan', () => {
    const result = { ok: true, message: 'not a url', label: 'something' };
    expect(extractResultUrl(result)).toBeNull();
  });

  it('prefers the explicit url field over fallback fields', () => {
    const result = {
      ok: true,
      url: 'http://primary.example.com/',
      other: 'http://secondary.example.com/'
    };
    expect(extractResultUrl(result)).toBe('http://primary.example.com/');
  });

  it('returns null when ok is false and no url is present', () => {
    const result = { ok: false, error: 'something went wrong' };
    expect(extractResultUrl(result)).toBeNull();
  });

  it('still returns a url even when ok is false (url was included anyway)', () => {
    const result = { ok: false, url: 'http://fallback.example.com/' };
    expect(extractResultUrl(result)).toBe('http://fallback.example.com/');
  });
});
