import type { DrawerItem } from '$lib/components/drawer-types';

export type SortDir = 'asc' | 'desc';
export interface SortOption { id: string; label: string; key: (row: any) => string | number; dir: SortDir; }
export interface ColumnSpec { label: string; cell: (row: any) => string; }

export interface ListConfig {
  widget: string;                 // fetch key for /api/widgets/{id}/{widget}
  title: string;
  grid: boolean;                  // show grid↔list toggle (media only)
  sorts: SortOption[];
  columns: ColumnSpec[];          // list-view columns
  // Map a raw row to a DrawerItem (carries connectionId + params for actions).
  toDrawerItem: (row: any, connectionId: number) => DrawerItem;
}

export function sortRows<T>(rows: T[], key: (row: T) => string | number, dir: SortDir): T[] {
  const out = [...rows].sort((a, b) => {
    const ka = key(a), kb = key(b);
    if (ka < kb) return -1;
    if (ka > kb) return 1;
    return 0;
  });
  return dir === 'desc' ? out.reverse() : out;
}

const byTitleAsc = (label = 'Title A–Z'): SortOption =>
  ({ id: 'title', label, key: (r) => String(r.title ?? r.name ?? '').toLowerCase(), dir: 'asc' });

const CONFIGS: Record<string, ListConfig> = {
  'jellyfin:recentlyAdded': {
    widget: 'recentlyAdded', title: 'Recently Added', grid: true,
    sorts: [
      byTitleAsc(),
      { id: 'year', label: 'Year (newest)', key: (r) => Number(r.year ?? 0), dir: 'desc' }
    ],
    columns: [
      { label: 'Title', cell: (r) => r.title },
      { label: 'Kind', cell: (r) => r.kind ?? '' },
      { label: 'Year', cell: (r) => String(r.year ?? '') }
    ],
    toDrawerItem: (r, connectionId) => ({
      id: String(r.id), title: r.title, year: r.year,
      kind: r.kind === 'Series' ? 'series' : 'movie', status: 'Available',
      connectionId, params: { id: r.id }
    })
  },
  'seerr:requests': {
    widget: 'requests', title: 'Requests', grid: false,
    sorts: [
      byTitleAsc(),
      { id: 'status', label: 'Status', key: (r) => String(r.status ?? ''), dir: 'asc' }
    ],
    columns: [
      { label: 'Title', cell: (r) => r.title },
      { label: 'By', cell: (r) => r.requestedBy ?? '' },
      { label: 'Status', cell: (r) => r.status ?? '' }
    ],
    toDrawerItem: (r, connectionId) => ({
      id: String(r.id), title: r.title, kind: 'request', status: r.status,
      meta: `Requested by ${r.requestedBy}`, connectionId, params: { id: r.id }
    })
  },
  'radarr:queue': {
    widget: 'queue', title: 'Radarr Queue', grid: false,
    sorts: [
      byTitleAsc(),
      { id: 'progress', label: 'Progress', key: (r) => Number(r.progress ?? 0), dir: 'desc' }
    ],
    columns: [
      { label: 'Title', cell: (r) => r.title },
      { label: 'Status', cell: (r) => r.status ?? '' },
      { label: 'Progress', cell: (r) => `${r.progress ?? 0}%` }
    ],
    toDrawerItem: (r, connectionId) => ({
      id: String(r.id), title: r.title, year: r.year, kind: 'movie', status: r.status,
      meta: `${r.progress ?? 0}%`, connectionId, params: { id: r.id }
    })
  },
  'sonarr:queue': {
    widget: 'queue', title: 'Sonarr Queue', grid: false,
    sorts: [
      byTitleAsc(),
      { id: 'progress', label: 'Progress', key: (r) => Number(r.progress ?? 0), dir: 'desc' }
    ],
    columns: [
      { label: 'Title', cell: (r) => r.title },
      { label: 'Status', cell: (r) => r.status ?? '' },
      { label: 'Progress', cell: (r) => `${r.progress ?? 0}%` }
    ],
    toDrawerItem: (r, connectionId) => ({
      id: String(r.id), title: r.title, kind: 'series', status: r.status,
      meta: `${r.progress ?? 0}%`, connectionId, params: { id: r.id }
    })
  },
  'radarr:wanted': {
    widget: 'wanted', title: 'Radarr Wanted', grid: true,
    sorts: [
      byTitleAsc(),
      { id: 'releaseDate', label: 'Release Date (newest)', key: (r) => String(r.releaseDate ?? ''), dir: 'desc' }
    ],
    columns: [
      { label: 'Title', cell: (r) => r.title },
      { label: 'Year', cell: (r) => String(r.year ?? '') },
      { label: 'Status', cell: (r) => r.status ?? '' },
      { label: 'Release', cell: (r) => r.releaseDate ? new Date(r.releaseDate).toLocaleDateString() : '' }
    ],
    toDrawerItem: (r, connectionId) => ({
      id: String(r.imdbId ?? r.title ?? ''), title: r.title, year: r.year, kind: 'movie',
      status: r.status ?? 'wanted', connectionId, params: {}
    })
  },
  'sonarr:wanted': {
    widget: 'wanted', title: 'Sonarr Wanted', grid: true,
    sorts: [
      byTitleAsc(),
      { id: 'releaseDate', label: 'Air Date (newest)', key: (r) => String(r.releaseDate ?? ''), dir: 'desc' }
    ],
    columns: [
      { label: 'Title', cell: (r) => r.title },
      { label: 'Year', cell: (r) => String(r.year ?? '') },
      { label: 'Air Date', cell: (r) => r.releaseDate ? new Date(r.releaseDate).toLocaleDateString() : '' }
    ],
    toDrawerItem: (r, connectionId) => ({
      id: String(r.title ?? ''), title: r.title, year: r.year, kind: 'series',
      status: r.status ?? 'wanted', connectionId, params: {}
    })
  },
  'qbittorrent:torrents': {
    widget: 'torrents', title: 'Torrents', grid: false,
    sorts: [
      { id: 'name', label: 'Name A–Z', key: (r) => String(r.name ?? '').toLowerCase(), dir: 'asc' },
      { id: 'progress', label: 'Progress', key: (r) => Number(r.progress ?? 0), dir: 'desc' }
    ],
    columns: [
      { label: 'Name', cell: (r) => r.name },
      { label: 'State', cell: (r) => r.state ?? '' },
      { label: 'Progress', cell: (r) => `${r.progress ?? 0}%` }
    ],
    toDrawerItem: (r, connectionId) => ({
      id: String(r.id), title: r.name, kind: 'download', status: r.state,
      connectionId, params: { hash: r.id }
    })
  }
};

export function listConfig(type: string, widget: string): ListConfig | null {
  return CONFIGS[`${type}:${widget}`] ?? null;
}
