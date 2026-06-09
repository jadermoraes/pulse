import { describe, it, expect, afterEach, vi } from 'vitest';
import type { Connection } from '../connections';
import { mapWatchStateUser } from './watchstate';

const conn: Connection = {
  id: 1, type: 'watchstate', name: 'WS', baseUrl: 'http://ws', secret: 'WSKEY', options: {}, enabled: true
};
afterEach(() => vi.restoreAllMocks());

describe('mapWatchStateUser — documented no-op (FIX 4)', () => {
  it('resolves without throwing and makes NO HTTP call', async () => {
    // The old /api/v1/users/map call was wrong on every axis; this must not hit the network.
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    vi.spyOn(console, 'info').mockImplementation(() => {});
    await expect(
      mapWatchStateUser(conn, { jellyfinUserId: 'jf-1', plexAccountId: 'px-9', displayName: 'Ana' })
    ).resolves.toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('never throws even with null ids (never blocks onboarding)', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    await expect(
      mapWatchStateUser(conn, { jellyfinUserId: null, plexAccountId: null, displayName: 'Ana' })
    ).resolves.toBeUndefined();
  });
});
