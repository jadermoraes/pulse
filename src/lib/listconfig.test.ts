import { describe, it, expect } from 'vitest';
import { listConfig, sortRows } from './listconfig';

describe('listConfig', () => {
  it('returns config for a known type:widget', () => {
    const c = listConfig('seerr', 'requests');
    expect(c?.title).toBe('Requests');
    expect(c?.grid).toBe(false);
    expect(c?.sorts.length).toBeGreaterThan(0);
  });
  it('media library config enables the grid toggle', () => {
    expect(listConfig('jellyfin', 'recentlyAdded')?.grid).toBe(true);
  });
  it('returns null for an unknown combination', () => {
    expect(listConfig('nope', 'nope')).toBeNull();
  });
  it('sortRows sorts by the chosen key ascending/descending', () => {
    const rows = [{ title: 'B', n: 2 }, { title: 'A', n: 1 }, { title: 'C', n: 3 }];
    expect(sortRows(rows, (r: any) => r.title, 'asc').map((r: any) => r.title)).toEqual(['A', 'B', 'C']);
    expect(sortRows(rows, (r: any) => r.n, 'desc').map((r: any) => r.n)).toEqual([3, 2, 1]);
  });
});
