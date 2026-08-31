import { it, expect } from 'vitest';
import { buildManifest, parseExtras, toMetaPreviews } from './catalog';
import type { LibraryItem } from './jellyfin-library';

const item: LibraryItem = {
  jellyfinId: 'jf-1', imdbId: 'tt0111161', type: 'movie',
  name: 'Shawshank', year: 1994, posterTag: 'tag1'
};

it('the manifest declares catalog and stream but NOT meta', () => {
  const m = buildManifest('http://pulse.lan:8817') as any;
  // Omitting `meta` is deliberate: items are keyed by imdb id and Cinemeta, installed by default,
  // supplies the detail page. Declaring meta would make pulse responsible for season trees it
  // does not model.
  expect(m.resources).toEqual(['catalog', 'stream']);
  expect(m.types).toEqual(['movie', 'series']);
  expect(m.idPrefixes).toEqual(['tt']);
  expect(m.id).toMatch(/^[a-z0-9.]+$/);
  expect(m.version).toMatch(/^\d+\.\d+\.\d+$/);
  expect(m.catalogs.map((c: any) => [c.type, c.id])).toEqual([
    ['movie', 'pulse-movies'], ['series', 'pulse-series']
  ]);
  // Both catalogs must advertise search and skip or Stremio never sends them.
  for (const c of m.catalogs) {
    const names = c.extra.map((e: any) => e.name).sort();
    expect(names).toEqual(['search', 'skip']);
  }
});

it('advertises an absolute logo url on the manifest origin, with no token in it', () => {
  const m = buildManifest('http://pulse.lan:8817') as any;
  // Stremio resolves the logo against its OWN page, so a relative path would 404 there.
  expect(m.logo).toBe('http://pulse.lan:8817/icon-192.png');
  // The logo is served by the static handler, not the addon route: it must not carry the
  // credential that the rest of the addon's urls do.
  expect(m.logo).not.toContain('/addon/');
});

it('parses extras from the path segment', () => {
  expect(parseExtras('search=blade%20runner&skip=100')).toEqual({ search: 'blade runner', skip: 100 });
  expect(parseExtras('skip=20')).toEqual({ skip: 20 });
  expect(parseExtras(undefined)).toEqual({ skip: 0 });
  expect(parseExtras('')).toEqual({ skip: 0 });
});

it('clamps a hostile or nonsense skip instead of passing it upstream', () => {
  expect(parseExtras('skip=-5').skip).toBe(0);
  expect(parseExtras('skip=abc').skip).toBe(0);
  expect(parseExtras('skip=999999999').skip).toBeLessThanOrEqual(100000);
});

it('ignores an empty search rather than sending SearchTerm=', () => {
  expect(parseExtras('search=').search).toBeUndefined();
  expect(parseExtras('search=%20%20').search).toBeUndefined();
});

it('maps library items to meta previews keyed by imdb id', () => {
  const [m] = toMetaPreviews([item], 'http://pulse:3000', 'tok') as any[];
  expect(m.id).toBe('tt0111161');
  expect(m.type).toBe('movie');
  expect(m.name).toBe('Shawshank');
  expect(m.releaseInfo).toBe('1994');
  expect(m.poster).toBe('http://pulse:3000/api/_public/addon/tok/poster/jf-1/tag1');
});

it('omits the poster when the item has no primary image, rather than emitting a broken url', () => {
  const [m] = toMetaPreviews([{ ...item, posterTag: null }], 'http://pulse:3000', 'tok') as any[];
  // toBeUndefined() alone cannot tell an absent key from one explicitly set to undefined.
  expect('poster' in m).toBe(false);
  expect(m.poster).toBeUndefined();
});

it('omits releaseInfo when the year is unknown', () => {
  const [m] = toMetaPreviews([{ ...item, year: null }], 'http://pulse:3000', 'tok') as any[];
  expect('releaseInfo' in m).toBe(false);
  expect(m.releaseInfo).toBeUndefined();
});

it('truncates a hostile search term instead of forwarding it verbatim', () => {
  expect(parseExtras('search=' + 'a'.repeat(10000)).search).toHaveLength(200);
});

it('strips control characters from search, written as escapes rather than literal bytes', () => {
  expect(parseExtras('search=' + encodeURIComponent('a\x00b\x1fc')).search).toBe('abc');
});
