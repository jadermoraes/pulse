import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  fetchJellyfinStreams,
  fetchTautulliStreams,
  fetchTautulliHistory,
  fetchJellystatHistory,
  fetchTautulliMostWatched,
  fetchJellystatMostWatched,
  aggregateNowPlaying,
  aggregateWatchHistory,
  aggregateMostWatched
} from './watch';
import type { Connection } from './connections';

afterEach(() => vi.restoreAllMocks());

const jellyfinConn: Connection = {
  id: 1, type: 'jellyfin', name: 'My Jellyfin',
  baseUrl: 'http://jf:8096', secret: 'JFKEY', options: {}, enabled: true
};

const tautulliConn: Connection = {
  id: 2, type: 'tautulli', name: 'My Tautulli',
  baseUrl: 'http://tau:8181', secret: 'TAUKEY', options: {}, enabled: true
};

const jellystatConn: Connection = {
  id: 3, type: 'jellystat', name: 'My Jellystat',
  baseUrl: 'http://jstat:3000', secret: 'JSKEY', options: {}, enabled: true
};

// ---------------------------------------------------------------------------
// fetchJellyfinStreams
// ---------------------------------------------------------------------------

describe('fetchJellyfinStreams', () => {
  it('returns only sessions with NowPlayingItem', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true, status: 200,
      json: async () => [
        {
          UserName: 'Alice',
          NowPlayingItem: { Name: 'Oppenheimer', Type: 'Movie', RunTimeTicks: 1000 },
          PlayState: { PositionTicks: 500, IsPaused: false },
          Client: 'Web'
        },
        { UserName: 'Bob' } // no NowPlayingItem — idle
      ]
    }) as unknown as Response));

    const streams = await fetchJellyfinStreams(jellyfinConn);
    expect(streams).toHaveLength(1);
    expect(streams[0]).toMatchObject({
      server: 'My Jellyfin',
      serverType: 'jellyfin',
      user: 'Alice',
      title: 'Oppenheimer',
      progressPercent: 50,
      state: 'playing'
    });
  });

  it('maps paused state correctly', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true, status: 200,
      json: async () => [{
        UserName: 'Carol',
        NowPlayingItem: { Name: 'Dark', SeriesName: 'Dark', Type: 'Episode', RunTimeTicks: 2000 },
        PlayState: { PositionTicks: 1000, IsPaused: true }
      }]
    }) as unknown as Response));

    const streams = await fetchJellyfinStreams(jellyfinConn);
    expect(streams[0].state).toBe('paused');
    expect(streams[0].title).toBe('Dark · Dark');
  });

  it('handles zero RunTimeTicks (progress = 0)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true, status: 200,
      json: async () => [{
        UserName: 'Dave',
        NowPlayingItem: { Name: 'Movie', RunTimeTicks: 0 },
        PlayState: { PositionTicks: 100, IsPaused: false }
      }]
    }) as unknown as Response));

    const streams = await fetchJellyfinStreams(jellyfinConn);
    expect(streams[0].progressPercent).toBe(0);
  });

  it('throws on non-ok response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false, status: 401,
      json: async () => null
    }) as unknown as Response));

    await expect(fetchJellyfinStreams(jellyfinConn)).rejects.toThrow('Jellyfin HTTP 401');
  });

  it('never includes the secret in the output', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true, status: 200,
      json: async () => []
    }) as unknown as Response));

    const streams = await fetchJellyfinStreams(jellyfinConn);
    expect(JSON.stringify(streams)).not.toContain('JFKEY');
  });
});

// ---------------------------------------------------------------------------
// fetchTautulliStreams
// ---------------------------------------------------------------------------

describe('fetchTautulliStreams', () => {
  it('maps sessions with correct server type and progress', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true, status: 200,
      json: async () => ({
        response: {
          result: 'success',
          data: {
            stream_count: 1,
            sessions: [{
              friendly_name: 'Eve',
              full_title: 'Dune',
              progress_percent: '72',
              state: 'playing',
              media_type: 'movie'
            }]
          }
        }
      })
    }) as unknown as Response));

    const streams = await fetchTautulliStreams(tautulliConn);
    expect(streams).toHaveLength(1);
    expect(streams[0]).toMatchObject({
      server: 'My Tautulli',
      serverType: 'plex',
      user: 'Eve',
      title: 'Dune',
      progressPercent: 72,
      state: 'playing',
      mediaType: 'movie'
    });
  });

  it('maps paused state', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true, status: 200,
      json: async () => ({
        response: {
          result: 'success',
          data: {
            sessions: [{ friendly_name: 'Frank', full_title: 'X', progress_percent: '30', state: 'paused' }]
          }
        }
      })
    }) as unknown as Response));

    const streams = await fetchTautulliStreams(tautulliConn);
    expect(streams[0].state).toBe('paused');
  });

  it('throws when Tautulli result is not success', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true, status: 200,
      json: async () => ({ response: { result: 'error', data: null } })
    }) as unknown as Response));

    await expect(fetchTautulliStreams(tautulliConn)).rejects.toThrow('Tautulli error');
  });
});

// ---------------------------------------------------------------------------
// fetchTautulliHistory
// ---------------------------------------------------------------------------

describe('fetchTautulliHistory', () => {
  it('converts epoch-seconds date to ISO string and preserves fields', async () => {
    const epochSec = 1748649600; // a fixed epoch second
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true, status: 200,
      json: async () => ({
        response: {
          result: 'success',
          data: {
            data: [{
              friendly_name: 'Grace',
              full_title: 'Interstellar',
              date: epochSec,
              stopped: epochSec + 5400,
              media_type: 'movie'
            }]
          }
        }
      })
    }) as unknown as Response));

    const items = await fetchTautulliHistory(tautulliConn);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      server: 'My Tautulli',
      serverType: 'plex',
      user: 'Grace',
      title: 'Interstellar',
      mediaType: 'movie'
    });
    // The when should be a valid ISO string derived from the epoch
    expect(new Date(items[0].when).getTime()).toBe(epochSec * 1000);
  });

  it('prepends grandparent_title for TV episodes', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true, status: 200,
      json: async () => ({
        response: {
          result: 'success',
          data: {
            data: [{
              friendly_name: 'Hank',
              full_title: 'Episode 1',
              grandparent_title: 'Breaking Bad',
              date: 1000,
              stopped: 2000
            }]
          }
        }
      })
    }) as unknown as Response));

    const items = await fetchTautulliHistory(tautulliConn);
    expect(items[0].title).toBe('Breaking Bad · Episode 1');
  });

  it('filters out in-progress plays (stopped=0) and keeps completed plays', async () => {
    const epochSec = 1748649600;
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true, status: 200,
      json: async () => ({
        response: {
          result: 'success',
          data: {
            data: [
              {
                // In-progress: stopped is 0 — must be excluded
                friendly_name: 'Alice',
                full_title: 'Still Watching',
                date: epochSec + 100,
                stopped: 0,
                media_type: 'movie'
              },
              {
                // Completed: stopped is a truthy epoch — must be included
                friendly_name: 'Bob',
                full_title: 'Finished Film',
                date: epochSec,
                stopped: epochSec + 7200,
                media_type: 'movie'
              }
            ]
          }
        }
      })
    }) as unknown as Response));

    const items = await fetchTautulliHistory(tautulliConn);
    expect(items).toHaveLength(1);
    expect(items[0].title).toBe('Finished Film');
    expect(items[0].user).toBe('Bob');
  });

  it('filters out in-progress plays where stopped is null', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true, status: 200,
      json: async () => ({
        response: {
          result: 'success',
          data: {
            data: [
              {
                friendly_name: 'Carol',
                full_title: 'Actively Playing',
                date: 1748649700,
                stopped: null,
                media_type: 'episode'
              }
            ]
          }
        }
      })
    }) as unknown as Response));

    const items = await fetchTautulliHistory(tautulliConn);
    expect(items).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// fetchJellystatHistory
// ---------------------------------------------------------------------------

describe('fetchJellystatHistory', () => {
  it('maps results envelope with series name', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true, status: 200,
      json: async () => ({
        results: [
          {
            NowPlayingItemName: 'Episode 1',
            SeriesName: 'Severance',
            UserName: 'Iris',
            Client: 'Jellyfin Web',
            ActivityDateInserted: '2026-06-01T10:00:00Z'
          },
          {
            NowPlayingItemName: 'Blade Runner 2049',
            SeriesName: null,
            UserName: 'Jake',
            ActivityDateInserted: '2026-05-30T08:00:00Z'
          }
        ]
      })
    }) as unknown as Response));

    const items = await fetchJellystatHistory(jellystatConn);
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      server: 'My Jellystat',
      serverType: 'jellyfin',
      user: 'Iris',
      title: 'Severance · Episode 1',
      when: '2026-06-01T10:00:00Z'
    });
    expect(items[1].title).toBe('Blade Runner 2049');
  });

  it('tolerates bare array response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true, status: 200,
      json: async () => [{
        NowPlayingItemName: 'Solo',
        SeriesName: null,
        UserName: 'Kai',
        ActivityDateInserted: '2026-06-01T12:00:00Z'
      }]
    }) as unknown as Response));

    const items = await fetchJellystatHistory(jellystatConn);
    expect(items[0].title).toBe('Solo');
  });

  it('never includes the secret in the output', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true, status: 200,
      json: async () => ({ results: [] })
    }) as unknown as Response));

    const items = await fetchJellystatHistory(jellystatConn);
    expect(JSON.stringify(items)).not.toContain('JSKEY');
  });
});

// ---------------------------------------------------------------------------
// aggregateNowPlaying — integration test with mixed connections
// ---------------------------------------------------------------------------

describe('aggregateNowPlaying', () => {
  it('merges jellyfin and tautulli streams', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const u = new URL(url);
      if (u.host === 'jf:8096') {
        return {
          ok: true, status: 200,
          json: async () => [{
            UserName: 'Alice',
            NowPlayingItem: { Name: 'Apex', RunTimeTicks: 1000 },
            PlayState: { PositionTicks: 250, IsPaused: false }
          }]
        } as unknown as Response;
      }
      if (u.host === 'tau:8181') {
        return {
          ok: true, status: 200,
          json: async () => ({
            response: {
              result: 'success',
              data: {
                sessions: [{
                  friendly_name: 'Bob', full_title: 'Rocky', progress_percent: '88', state: 'playing'
                }]
              }
            }
          })
        } as unknown as Response;
      }
      return { ok: false, status: 404, json: async () => null } as unknown as Response;
    }));

    const result = await aggregateNowPlaying([jellyfinConn, tautulliConn]);
    expect(result.count).toBe(2);
    const serverTypes = result.streams.map((s) => s.serverType);
    expect(serverTypes).toContain('jellyfin');
    expect(serverTypes).toContain('plex');
  });

  it('skips a failing connection and still returns results from others', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const u = new URL(url);
      if (u.host === 'jf:8096') {
        // Jellyfin fails
        return { ok: false, status: 500, json: async () => null } as unknown as Response;
      }
      // Tautulli succeeds
      return {
        ok: true, status: 200,
        json: async () => ({
          response: {
            result: 'success',
            data: {
              sessions: [{ friendly_name: 'Carol', full_title: 'Film', progress_percent: '50', state: 'playing' }]
            }
          }
        })
      } as unknown as Response;
    }));

    const result = await aggregateNowPlaying([jellyfinConn, tautulliConn]);
    expect(result.count).toBe(1);
    expect(result.streams[0].serverType).toBe('plex');
  });

  it('filters out disabled connections', async () => {
    const disabledConn = { ...jellyfinConn, enabled: false };
    vi.stubGlobal('fetch', vi.fn(async () =>
      ({ ok: true, status: 200, json: async () => [] }) as unknown as Response
    ));

    const result = await aggregateNowPlaying([disabledConn]);
    // fetch may not even be called, but result should be empty
    expect(result.count).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// aggregateWatchHistory — integration test with tautulli + jellystat
// ---------------------------------------------------------------------------

describe('aggregateWatchHistory', () => {
  it('merges and sorts by when desc, returns top N', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const u = new URL(url);
      if (u.host === 'tau:8181') {
        // Tautulli returns older item
        return {
          ok: true, status: 200,
          json: async () => ({
            response: {
              result: 'success',
              data: {
                data: [{
                  friendly_name: 'Alice',
                  full_title: 'Dune',
                  date: 1748476800, // 2025-05-29 (epoch seconds)
                  stopped: 1748476800 + 7200,
                  media_type: 'movie'
                }]
              }
            }
          })
        } as unknown as Response;
      }
      if (u.host === 'jstat:3000') {
        // Jellystat returns newer item
        return {
          ok: true, status: 200,
          json: async () => ({
            results: [{
              NowPlayingItemName: 'Severance S2E1',
              SeriesName: 'Severance',
              UserName: 'Bob',
              ActivityDateInserted: '2026-06-01T15:00:00Z'
            }]
          })
        } as unknown as Response;
      }
      return { ok: false, status: 404, json: async () => null } as unknown as Response;
    }));

    const result = await aggregateWatchHistory([tautulliConn, jellystatConn]);
    expect(result.count).toBe(2);
    // Jellystat item is newer → should be first
    expect(result.items[0].serverType).toBe('jellyfin');
    expect(result.items[0].title).toBe('Severance · Severance S2E1');
    expect(result.items[1].serverType).toBe('plex');
    expect(result.items[1].title).toBe('Dune');
  });

  it('skips a failing connection gracefully', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const u = new URL(url);
      if (u.host === 'tau:8181') {
        return { ok: false, status: 503, json: async () => null } as unknown as Response;
      }
      // Jellystat works
      return {
        ok: true, status: 200,
        json: async () => ({
          results: [{
            NowPlayingItemName: 'Film',
            SeriesName: null,
            UserName: 'Cleo',
            ActivityDateInserted: '2026-06-02T09:00:00Z'
          }]
        })
      } as unknown as Response;
    }));

    const result = await aggregateWatchHistory([tautulliConn, jellystatConn]);
    expect(result.items).toHaveLength(1);
    expect(result.items[0].user).toBe('Cleo');
  });

  it('ignores non-tautulli/jellystat connection types', async () => {
    const otherConn: Connection = { id: 99, type: 'jellyfin', name: 'JF', baseUrl: 'http://jf', secret: null, options: {}, enabled: true };
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true, status: 200, json: async () => []
    }) as unknown as Response));

    const result = await aggregateWatchHistory([otherConn]);
    expect(result.items).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Poster URL generation — verify structure & that secrets never appear
// ---------------------------------------------------------------------------

describe('poster URL generation', () => {
  it('fetchJellyfinStreams: poster routes via /api/image/<jellyfinConnId>?path=...', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true, status: 200,
      json: async () => [{
        UserName: 'Alice',
        NowPlayingItem: { Id: 'item-abc', Name: 'Dune', Type: 'Movie', RunTimeTicks: 1000 },
        PlayState: { PositionTicks: 500, IsPaused: false }
      }]
    }) as unknown as Response));

    const streams = await fetchJellyfinStreams(jellyfinConn);
    expect(streams[0].poster).toBe(
      `/api/image/1?path=${encodeURIComponent('/Items/item-abc/Images/Primary?fillHeight=160')}`
    );
    // Secret must not appear in the proxied URL
    expect(streams[0].poster).not.toContain('JFKEY');
  });

  it('fetchJellyfinStreams: poster is null when item has no Id', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true, status: 200,
      json: async () => [{
        UserName: 'Bob',
        NowPlayingItem: { Name: 'Mystery', Type: 'Movie', RunTimeTicks: 0 },
        PlayState: { PositionTicks: 0, IsPaused: false }
      }]
    }) as unknown as Response));

    const streams = await fetchJellyfinStreams(jellyfinConn);
    expect(streams[0].poster).toBeNull();
  });

  it('fetchTautulliStreams: poster routes via /api/image/<tautulliConnId>?path=...', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true, status: 200,
      json: async () => ({
        response: {
          result: 'success',
          data: {
            sessions: [{
              friendly_name: 'Eve',
              full_title: 'Dune',
              progress_percent: '72',
              state: 'playing',
              media_type: 'movie',
              thumb: '/library/metadata/123/thumb/456',
              grandparent_thumb: ''
            }]
          }
        }
      })
    }) as unknown as Response));

    const streams = await fetchTautulliStreams(tautulliConn);
    expect(streams[0].poster).toBe(
      `/api/image/2?path=${encodeURIComponent('/library/metadata/123/thumb/456')}`
    );
    // Tautulli apikey must NOT appear in poster URL
    expect(streams[0].poster).not.toContain('TAUKEY');
  });

  it('fetchTautulliStreams: episode uses grandparent_thumb for show poster', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true, status: 200,
      json: async () => ({
        response: {
          result: 'success',
          data: {
            sessions: [{
              friendly_name: 'Frank',
              full_title: 'S01E01',
              progress_percent: '30',
              state: 'playing',
              media_type: 'episode',
              thumb: '/library/metadata/ep1/thumb/1',
              grandparent_thumb: '/library/metadata/show99/thumb/9'
            }]
          }
        }
      })
    }) as unknown as Response));

    const streams = await fetchTautulliStreams(tautulliConn);
    // Episodes should use grandparent_thumb (show poster)
    expect(streams[0].poster).toBe(
      `/api/image/2?path=${encodeURIComponent('/library/metadata/show99/thumb/9')}`
    );
  });

  it('fetchTautulliStreams: poster is null when no thumb paths available', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true, status: 200,
      json: async () => ({
        response: {
          result: 'success',
          data: {
            sessions: [{
              friendly_name: 'Grace',
              full_title: 'Live TV',
              progress_percent: '0',
              state: 'playing',
              media_type: 'track',
              thumb: '',
              grandparent_thumb: ''
            }]
          }
        }
      })
    }) as unknown as Response));

    const streams = await fetchTautulliStreams(tautulliConn);
    expect(streams[0].poster).toBeNull();
  });

  it('fetchTautulliHistory: poster routes via tautulli conn, secret never in URL', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true, status: 200,
      json: async () => ({
        response: {
          result: 'success',
          data: {
            data: [{
              friendly_name: 'Hank',
              full_title: 'Interstellar',
              date: 1748649600,
              stopped: 1748649600 + 7200,
              media_type: 'movie',
              thumb: '/library/metadata/456/thumb/789',
              grandparent_thumb: ''
            }]
          }
        }
      })
    }) as unknown as Response));

    const items = await fetchTautulliHistory(tautulliConn);
    expect(items[0].poster).toBe(
      `/api/image/2?path=${encodeURIComponent('/library/metadata/456/thumb/789')}`
    );
    expect(items[0].poster).not.toContain('TAUKEY');
  });

  it('fetchJellystatHistory: poster routes via jellyfinConnId when provided', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true, status: 200,
      json: async () => ({
        results: [{
          NowPlayingItemName: 'Episode 1',
          NowPlayingItemId: 'jellyfin-item-xyz',
          SeriesName: 'Severance',
          UserName: 'Iris',
          ActivityDateInserted: '2026-06-01T10:00:00Z'
        }]
      })
    }) as unknown as Response));

    // jellyfinConnId = 1 (the jellyfin connection's id)
    const items = await fetchJellystatHistory(jellystatConn, 1);
    expect(items[0].poster).toBe(
      `/api/image/1?path=${encodeURIComponent('/Items/jellyfin-item-xyz/Images/Primary?fillHeight=160')}`
    );
    // Jellystat secret must not appear in poster URL
    expect(items[0].poster).not.toContain('JSKEY');
  });

  it('fetchJellystatHistory: poster is null when no jellyfinConnId given', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true, status: 200,
      json: async () => ({
        results: [{
          NowPlayingItemName: 'Film',
          NowPlayingItemId: 'jellyfin-item-xyz',
          SeriesName: null,
          UserName: 'Jake',
          ActivityDateInserted: '2026-06-01T10:00:00Z'
        }]
      })
    }) as unknown as Response));

    const items = await fetchJellystatHistory(jellystatConn, null);
    expect(items[0].poster).toBeNull();
  });

  it('fetchJellystatHistory: poster is null when item has no item id', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true, status: 200,
      json: async () => ({
        results: [{
          NowPlayingItemName: 'Live Content',
          SeriesName: null,
          UserName: 'Kim',
          ActivityDateInserted: '2026-06-01T10:00:00Z'
        }]
      })
    }) as unknown as Response));

    const items = await fetchJellystatHistory(jellystatConn, 1);
    expect(items[0].poster).toBeNull();
  });

  it('aggregateWatchHistory: passes jellyfinConnId to fetchJellystatHistory', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const u = new URL(url);
      if (u.host === 'jstat:3000') {
        return {
          ok: true, status: 200,
          json: async () => ({
            results: [{
              NowPlayingItemName: 'The Bear',
              NowPlayingItemId: 'item-bear-99',
              SeriesName: null,
              UserName: 'Leo',
              ActivityDateInserted: '2026-06-01T12:00:00Z'
            }]
          })
        } as unknown as Response;
      }
      return { ok: false, status: 404, json: async () => null } as unknown as Response;
    }));

    // Pass both a jellyfin conn (id=1) and a jellystat conn (id=3)
    const result = await aggregateWatchHistory([jellyfinConn, jellystatConn]);
    expect(result.items).toHaveLength(1);
    // poster should use jellyfinConn.id (1)
    expect(result.items[0].poster).toBe(
      `/api/image/1?path=${encodeURIComponent('/Items/item-bear-99/Images/Primary?fillHeight=160')}`
    );
  });
});

// ---------------------------------------------------------------------------
// fetchTautulliMostWatched
// ---------------------------------------------------------------------------

describe('fetchTautulliMostWatched', () => {
  it('extracts top_movies and top_tv rows, normalizes to MostWatchedItem', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true, status: 200,
      json: async () => ({
        response: {
          result: 'success',
          data: [
            {
              stat_id: 'top_movies',
              rows: [
                { title: 'Dune', total_plays: 42, thumb: '/library/metadata/1/thumb/1', grandparent_thumb: '' },
                { title: 'Inception', total_plays: 30, thumb: '/library/metadata/2/thumb/2', grandparent_thumb: '' }
              ]
            },
            {
              stat_id: 'top_tv',
              rows: [
                { title: 'Breaking Bad', total_plays: 99, thumb: '/library/metadata/3/thumb/3', grandparent_thumb: '/library/metadata/show3/thumb/3' }
              ]
            },
            {
              stat_id: 'top_users',
              rows: [{ title: 'Alice', total_plays: 999 }]
            }
          ]
        }
      })
    }) as unknown as Response));

    const items = await fetchTautulliMostWatched(tautulliConn);
    expect(items).toHaveLength(3);
    expect(items[0]).toMatchObject({
      server: 'My Tautulli',
      serverType: 'plex',
      title: 'Dune',
      plays: 42
    });
    // Only top_movies + top_tv, not top_users
    expect(items.map((i) => i.title)).not.toContain('Alice');
  });

  it('uses grandparent_thumb when available (show poster priority)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true, status: 200,
      json: async () => ({
        response: {
          result: 'success',
          data: [{
            stat_id: 'top_tv',
            rows: [{
              title: 'Severance',
              total_plays: 55,
              thumb: '/library/metadata/ep/thumb/1',
              grandparent_thumb: '/library/metadata/show/thumb/1'
            }]
          }]
        }
      })
    }) as unknown as Response));

    const items = await fetchTautulliMostWatched(tautulliConn);
    expect(items[0].poster).toBe(
      `/api/image/2?path=${encodeURIComponent('/library/metadata/show/thumb/1')}`
    );
    // Tautulli apikey must NOT appear in poster URL
    expect(items[0].poster).not.toContain('TAUKEY');
  });

  it('sets poster to null when no thumb paths available', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true, status: 200,
      json: async () => ({
        response: {
          result: 'success',
          data: [{
            stat_id: 'top_movies',
            rows: [{ title: 'Live TV', total_plays: 5, thumb: '', grandparent_thumb: '' }]
          }]
        }
      })
    }) as unknown as Response));

    const items = await fetchTautulliMostWatched(tautulliConn);
    expect(items[0].poster).toBeNull();
  });

  it('throws on non-ok HTTP response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false, status: 503, json: async () => null
    }) as unknown as Response));

    await expect(fetchTautulliMostWatched(tautulliConn)).rejects.toThrow('Tautulli HTTP 503');
  });
});

// ---------------------------------------------------------------------------
// fetchJellystatMostWatched
// ---------------------------------------------------------------------------

describe('fetchJellystatMostWatched', () => {
  it('merges Movie + Series types and maps to MostWatchedItem', async () => {
    let callCount = 0;
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      callCount++;
      const body = JSON.parse(init?.body as string ?? '{}');
      if (body.type === 'Movie') {
        return {
          ok: true, status: 200,
          json: async () => [
            { Name: 'Interstellar', Id: 'item-123', Plays: 25 }
          ]
        } as unknown as Response;
      }
      if (body.type === 'Series') {
        return {
          ok: true, status: 200,
          json: async () => [
            { Name: 'Dark', Id: 'item-456', Plays: 40 }
          ]
        } as unknown as Response;
      }
      return { ok: false, status: 404, json: async () => null } as unknown as Response;
    }));

    const items = await fetchJellystatMostWatched(jellystatConn, 1);
    expect(items).toHaveLength(2);
    const titles = items.map((i) => i.title);
    expect(titles).toContain('Interstellar');
    expect(titles).toContain('Dark');
    expect(items[0].serverType).toBe('jellyfin');
  });

  it('builds poster via jellyfinConnId when provided', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(init?.body as string ?? '{}');
      if (body.type === 'Movie') {
        return {
          ok: true, status: 200,
          json: async () => [{ Name: 'Blade Runner', Id: 'item-br', Plays: 10 }]
        } as unknown as Response;
      }
      return { ok: true, status: 200, json: async () => [] } as unknown as Response;
    }));

    const items = await fetchJellystatMostWatched(jellystatConn, 1);
    const bladeRunner = items.find((i) => i.title === 'Blade Runner');
    expect(bladeRunner?.poster).toBe(
      `/api/image/1?path=${encodeURIComponent('/Items/item-br/Images/Primary?fillHeight=160')}`
    );
    // Jellystat secret must not appear in poster URL
    expect(bladeRunner?.poster).not.toContain('JSKEY');
  });

  it('sets poster to null when no jellyfinConnId given', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(init?.body as string ?? '{}');
      if (body.type === 'Movie') {
        return {
          ok: true, status: 200,
          json: async () => [{ Name: 'Film', Id: 'item-f', Plays: 5 }]
        } as unknown as Response;
      }
      return { ok: true, status: 200, json: async () => [] } as unknown as Response;
    }));

    const items = await fetchJellystatMostWatched(jellystatConn, null);
    expect(items[0].poster).toBeNull();
  });

  it('tolerates a failing type call and returns items from the other type', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(init?.body as string ?? '{}');
      if (body.type === 'Movie') {
        // Movie fails
        return { ok: false, status: 500, json: async () => null } as unknown as Response;
      }
      // Series succeeds
      return {
        ok: true, status: 200,
        json: async () => [{ Name: 'The Wire', Id: 'item-tw', Plays: 80 }]
      } as unknown as Response;
    }));

    const items = await fetchJellystatMostWatched(jellystatConn, null);
    expect(items).toHaveLength(1);
    expect(items[0].title).toBe('The Wire');
  });
});

// ---------------------------------------------------------------------------
// aggregateMostWatched — integration test with tautulli + jellystat
// ---------------------------------------------------------------------------

describe('aggregateMostWatched', () => {
  it('merges tautulli + jellystat, sorts by plays desc, takes top N', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      const u = new URL(url);
      if (u.host === 'tau:8181') {
        // Tautulli: get_home_stats
        return {
          ok: true, status: 200,
          json: async () => ({
            response: {
              result: 'success',
              data: [
                {
                  stat_id: 'top_movies',
                  rows: [
                    { title: 'Dune', total_plays: 50, thumb: '/library/1/thumb', grandparent_thumb: '' }
                  ]
                }
              ]
            }
          })
        } as unknown as Response;
      }
      if (u.host === 'jstat:3000') {
        // Jellystat: getMostViewedByType
        const body = JSON.parse(init?.body as string ?? '{}');
        if (body.type === 'Movie') {
          return {
            ok: true, status: 200,
            json: async () => [{ Name: 'Inception', Id: 'item-i', Plays: 75 }]
          } as unknown as Response;
        }
        return { ok: true, status: 200, json: async () => [] } as unknown as Response;
      }
      return { ok: false, status: 404, json: async () => null } as unknown as Response;
    }));

    const result = await aggregateMostWatched([tautulliConn, jellystatConn]);
    expect(result.count).toBe(2);
    // Sorted by plays desc: Inception (75) first, then Dune (50)
    expect(result.items[0].title).toBe('Inception');
    expect(result.items[0].serverType).toBe('jellyfin');
    expect(result.items[1].title).toBe('Dune');
    expect(result.items[1].serverType).toBe('plex');
  });

  it('skips a failing connection and still returns results from others', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const u = new URL(url);
      if (u.host === 'tau:8181') {
        return { ok: false, status: 503, json: async () => null } as unknown as Response;
      }
      // Jellystat succeeds for Movie type
      return {
        ok: true, status: 200,
        json: async () => [{ Name: 'Heat', Id: 'item-h', Plays: 20 }]
      } as unknown as Response;
    }));

    const result = await aggregateMostWatched([tautulliConn, jellystatConn]);
    expect(result.items.length).toBeGreaterThan(0);
    expect(result.items.every((i) => i.serverType === 'jellyfin')).toBe(true);
  });

  it('ignores non-tautulli/jellystat connection types', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      ({ ok: true, status: 200, json: async () => [] }) as unknown as Response
    ));
    const result = await aggregateMostWatched([jellyfinConn]);
    expect(result.items).toHaveLength(0);
  });

  it('passes jellyfinConnId to jellystat for poster URL generation', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      const u = new URL(url);
      if (u.host === 'jstat:3000') {
        const body = JSON.parse(init?.body as string ?? '{}');
        if (body.type === 'Movie') {
          return {
            ok: true, status: 200,
            json: async () => [{ Name: 'Arrival', Id: 'item-arr', Plays: 18 }]
          } as unknown as Response;
        }
        return { ok: true, status: 200, json: async () => [] } as unknown as Response;
      }
      return { ok: false, status: 404, json: async () => null } as unknown as Response;
    }));

    // jellyfinConn (id=1) + jellystatConn (id=3)
    const result = await aggregateMostWatched([jellyfinConn, jellystatConn]);
    expect(result.items).toHaveLength(1);
    // poster should use jellyfinConn.id (1)
    expect(result.items[0].poster).toBe(
      `/api/image/1?path=${encodeURIComponent('/Items/item-arr/Images/Primary?fillHeight=160')}`
    );
    // No secret in poster URL
    expect(result.items[0].poster).not.toContain('JSKEY');
  });

  it('filters out disabled connections', async () => {
    const disabledTau = { ...tautulliConn, enabled: false };
    vi.stubGlobal('fetch', vi.fn(async () =>
      ({ ok: true, status: 200, json: async () => ({ response: { result: 'success', data: [] } }) }) as unknown as Response
    ));
    const result = await aggregateMostWatched([disabledTau]);
    expect(result.count).toBe(0);
  });
});
