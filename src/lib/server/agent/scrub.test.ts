import { describe, it, expect } from 'vitest';
import { scrub } from './scrub';

describe('scrub', () => {
  it('redacts secret-like keys at any depth', () => {
    const out = scrub({
      name: 'JF', apiKey: 'SECRET', secret: 'x', token: 't',
      password: 'p', nested: { api_key: 'y', authorization: 'Bearer z', ok: 1 },
      list: [{ password: 'q', keep: 'v' }]
    });
    expect(out).toMatchObject({
      name: 'JF', apiKey: '[redacted]', secret: '[redacted]', token: '[redacted]',
      password: '[redacted]', nested: { api_key: '[redacted]', authorization: '[redacted]', ok: 1 },
      list: [{ password: '[redacted]', keep: 'v' }]
    });
  });
  it('redacts bearer/api-key tokens embedded in strings', () => {
    const out = scrub({ url: 'http://h/api?api_key=abcdef123456&x=1' }) as any;
    expect(out.url).not.toContain('abcdef123456');
    expect(out.url).toContain('[redacted]');
  });
  it('redacts the no-underscore apikey= URL form (tautulli)', () => {
    const out = scrub({ url: 'http://h/api/v2?apikey=tautullisecret789&cmd=get_activity' }) as any;
    expect(out.url).not.toContain('tautullisecret789');
    expect(out.url).toContain('[redacted]');
    expect(out.url).toContain('cmd=get_activity');
  });
  it('passes through primitives and null', () => {
    expect(scrub(null)).toBeNull();
    expect(scrub(42)).toBe(42);
    expect(scrub('plain')).toBe('plain');
  });
});
