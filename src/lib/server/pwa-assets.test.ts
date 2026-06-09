import { it, expect } from 'vitest';
import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(process.cwd()); // vitest runs from repo root
const stat = (p: string) => statSync(resolve(root, p));
const read = (p: string) => readFileSync(resolve(root, p), 'utf8');

it('manifest has split any + maskable icons', () => {
  const m = JSON.parse(read('static/manifest.webmanifest'));
  const purposes = m.icons.map((i: { purpose: string }) => i.purpose);
  expect(purposes).toContain('any');
  expect(purposes).toContain('maskable');
});

it('branded icon files exist and are not the tiny grayscale placeholders', () => {
  expect(stat('static/icon-192.png').size).toBeGreaterThan(1000);
  expect(stat('static/icon-512.png').size).toBeGreaterThan(2000);
  expect(stat('static/icon-maskable-512.png').size).toBeGreaterThan(1000);
  expect(stat('static/apple-touch-icon.png').size).toBeGreaterThan(800);
  expect(read('static/favicon.svg')).not.toContain('svelte-logo');
});

it('app.html wires the favicon + apple/mobile meta', () => {
  const html = read('src/app.html');
  expect(html).toContain('rel="apple-touch-icon"');
  expect(html).toContain('apple-mobile-web-app-capable');
  expect(html).toContain('mobile-web-app-capable');
  expect(html).toContain('href="/favicon.svg"');
});
