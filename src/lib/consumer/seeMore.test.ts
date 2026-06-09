import { describe, it, expect } from 'vitest';
import { seeMoreUrl } from './seeMore';

const bases = { jellyfin: 'http://jf', seerr: 'http://se/' };

describe('seeMoreUrl', () => {
  it('points Hot · Movies at the seerr movie discover page', () => {
    expect(seeMoreUrl(bases, 'seerr', 'movie')).toBe('http://se/discover/movies');
  });
  it('points Hot · Series at the seerr tv discover page', () => {
    expect(seeMoreUrl(bases, 'seerr', 'tv')).toBe('http://se/discover/tv');
  });
  it('points New on server · Movies at the Jellyfin movies view', () => {
    expect(seeMoreUrl(bases, 'jellyfin', 'movie')).toBe('http://jf/web/index.html#/movies.html');
  });
  it('points New on server · Series at the Jellyfin tv view', () => {
    expect(seeMoreUrl(bases, 'jellyfin', 'tv')).toBe('http://jf/web/index.html#/tv.html');
  });
  it('returns null (hide the link) when the relevant base is absent', () => {
    expect(seeMoreUrl({ jellyfin: null, seerr: null }, 'seerr', 'movie')).toBeNull();
    expect(seeMoreUrl({ jellyfin: null, seerr: 'http://se' }, 'jellyfin', 'movie')).toBeNull();
  });
});
