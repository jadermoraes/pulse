import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

describe('PWA manifest', () => {
  const manifest = JSON.parse(readFileSync('static/manifest.webmanifest', 'utf8'));
  it('is installable for /app (name, scope, start_url, standalone, icons)', () => {
    expect(manifest.name).toBeTruthy();
    expect(manifest.start_url).toBe('/app');
    expect(manifest.scope).toBe('/app');
    expect(manifest.display).toBe('standalone');
    expect(Array.isArray(manifest.icons) && manifest.icons.length).toBeTruthy();
    expect(manifest.icons.some((i: any) => i.sizes === '512x512')).toBe(true);
  });
});
