import { it, expect } from 'vitest';
import { reconcile, stremioType, type PulseItem, type StremioItem } from './stremio-reconcile';

const want = (over: Partial<PulseItem> = {}): PulseItem => ({
  tmdbId: 278, mediaType: 'movie', imdbId: 'tt0111161', title: 'Shawshank',
  onServer: false, droppedAt: null, ...over
});
const inStremio = (over: Partial<StremioItem> = {}): StremioItem =>
  ({ imdbId: 'tt0111161', type: 'movie', removed: false, ...over });

it('pushes a wanted title Stremio does not have', () => {
  const r = reconcile([want()], []);
  expect(r.push.map((p) => p.tmdbId)).toEqual([278]);
  expect(r.remove).toEqual([]);
});

it('does not re-push a title already present in Stremio', () => {
  expect(reconcile([want()], [inStremio()]).push).toEqual([]);
});

it('never pushes a row with no imdb id', () => {
  expect(reconcile([want({ imdbId: null })], []).push).toEqual([]);
});

it('removes an available title that is still in Stremio', () => {
  const r = reconcile([want({ onServer: true })], [inStremio()]);
  expect(r.remove.map((p) => p.tmdbId)).toEqual([278]);
});

it('does not remove an available title already gone from Stremio', () => {
  const r = reconcile([want({ onServer: true, droppedAt: 111 })], [inStremio({ removed: true })]);
  expect(r.remove).toEqual([]);
  expect(r.clearDropped).toEqual([]);
});

it('imports a title present in Stremio that pulse does not know', () => {
  const r = reconcile([], [inStremio({ imdbId: 'tt99' })]);
  expect(r.importItems.map((s) => s.imdbId)).toEqual(['tt99']);
});

it('does not import a removed stremio item', () => {
  expect(reconcile([], [inStremio({ imdbId: 'tt99', removed: true })]).importItems).toEqual([]);
});

it('deletes a pulse row the viewer removed in Stremio', () => {
  const r = reconcile([want()], [inStremio({ removed: true })]);
  expect(r.deleteItems.map((p) => p.tmdbId)).toEqual([278]);
});

it('IGNORES a removal pulse itself performed', () => {
  const r = reconcile([want({ onServer: true, droppedAt: 999 })], [inStremio({ removed: true })]);
  expect(r.deleteItems).toEqual([]);
  expect(r.clearDropped).toEqual([]);
});

it('never deletes a pulse row that pulse itself dropped, even after it left the server', () => {
  // onServer:false is the case that actually reaches the deleteItems guard (onServer:true exits
  // earlier, at the `if (p.onServer)` branch, and never gets near the guard at all).
  const r = reconcile([want({ onServer: false, droppedAt: 999 })], [inStremio({ removed: true })]);
  expect(r.deleteItems).toEqual([]);
  expect(r.clearDropped).toEqual([]);
  expect(r.push).toHaveLength(1); // it is wanted again, so re-push it despite the tombstone
});

it('clears the dropped stamp when the viewer re-adds the title', () => {
  const r = reconcile([want({ droppedAt: 999 })], [inStremio({ removed: false })]);
  expect(r.clearDropped.map((p) => p.tmdbId)).toEqual([278]);
  expect(r.deleteItems).toEqual([]);
});

it('matches series type to pulse tv rows', () => {
  const r = reconcile([want({ mediaType: 'tv', imdbId: 'tt0903747' })], [{ imdbId: 'tt0903747', type: 'series', removed: false }]);
  expect(r.push).toEqual([]);
});

it('maps pulse mediaType to the Stremio type vocabulary', () => {
  expect(stremioType('tv')).toBe('series');
  expect(stremioType('movie')).toBe('movie');
});

it('the drop -> re-add -> drop cycle converges instead of oscillating forever', () => {
  // Mutable simulation state: this is what Task 5's sync runner will actually persist and feed
  // back in on each pass — pulse's own onServer/droppedAt columns, and whatever Stremio currently
  // reports for this imdbId (absent / present / tombstoned).
  let onServer = false;
  let droppedAt: number | null = null;
  let stremio: 'absent' | 'present' | 'tombstone' = 'absent';
  let stamp = 0;

  const stremioList = (): StremioItem[] =>
    stremio === 'absent' ? [] : [inStremio({ removed: stremio === 'tombstone' })];

  // Applies one reconcile cycle to the simulated state the way a real sync runner would:
  // push/remove touch Stremio, remove/clearDropped touch pulse's own droppedAt column.
  const step = () => {
    const r = reconcile([want({ onServer, droppedAt })], stremioList());
    expect(r.deleteItems).toEqual([]); // safety invariant: never delete what pulse itself dropped
    if (r.push.length) stremio = 'present';
    if (r.remove.length) {
      stremio = 'tombstone';
      droppedAt = ++stamp;
    }
    if (r.clearDropped.length) droppedAt = null;
    return r;
  };

  // 1. Not yet pushed -> pulse pushes it.
  expect(step().push).toHaveLength(1);
  expect(stremio).toBe('present');

  // 2. Title becomes available on the media server -> pulse drops it from Stremio, stamping droppedAt.
  onServer = true;
  expect(step().remove).toHaveLength(1);
  expect(stremio).toBe('tombstone');
  expect(droppedAt).not.toBeNull();
  const firstStamp = droppedAt;

  // 3. Idle: nothing changes while it stays available and tombstoned.
  const idle = step();
  expect(idle.push).toEqual([]);
  expect(idle.remove).toEqual([]);
  expect(idle.clearDropped).toEqual([]);
  expect(droppedAt).toBe(firstStamp);

  // 4. Viewer re-adds it in Stremio anyway -> the stamp clears, and it is NOT deleted.
  stremio = 'present';
  expect(step().clearDropped).toHaveLength(1);
  expect(droppedAt).toBeNull();

  // 5. Still available -> pulse drops it once more (the cycle repeats, but never deletes).
  expect(step().remove).toHaveLength(1);
  expect(stremio).toBe('tombstone');
  expect(droppedAt).not.toBeNull();

  // 6. The title falls off the media server -> pulse wants it again -> re-push despite the
  //    tombstone (this is the fix for the case that used to strand the row forever).
  onServer = false;
  expect(step().push).toHaveLength(1);
  expect(stremio).toBe('present');

  // 7. Next cycle observes it present and clears the now-stale stamp.
  expect(step().clearDropped).toHaveLength(1);
  expect(droppedAt).toBeNull();

  // 8. Fixed point: several more cycles with no external change produce no further action at all.
  for (let i = 0; i < 5; i++) {
    const r = step();
    expect(r).toEqual({ push: [], remove: [], importItems: [], deleteItems: [], clearDropped: [] });
  }
});
