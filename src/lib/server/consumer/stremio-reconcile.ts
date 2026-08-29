export interface PulseItem {
  tmdbId: number;
  mediaType: 'movie' | 'tv';
  imdbId: string | null;
  title: string;
  onServer: boolean;
  /** Set ONLY when pulse itself removed the item from Stremio. Never set by a viewer action. */
  droppedAt: number | null;
}

export interface StremioItem {
  imdbId: string;
  type: string;
  removed: boolean;
}

export interface ReconcileResult {
  push: PulseItem[];
  remove: PulseItem[];
  importItems: StremioItem[];
  deleteItems: PulseItem[];
  clearDropped: PulseItem[];
}

export function stremioType(mediaType: 'movie' | 'tv'): 'movie' | 'series' {
  return mediaType === 'tv' ? 'series' : 'movie';
}

/**
 * Pure. No DB, no network, no clock.
 *
 * The guard that matters: pulse stamps `droppedAt` when IT removes an item (because the title
 * became available on the server). The pull direction must never read that disappearance as
 * "the viewer deleted this" — otherwise the two directions fight and silently eat watchlist
 * rows. Seeing the item present again clears the stamp and re-arms removal detection.
 */
export function reconcile(pulseItems: PulseItem[], stremioItems: StremioItem[]): ReconcileResult {
  const byImdb = new Map<string, StremioItem>();
  for (const s of stremioItems) byImdb.set(s.imdbId, s);

  const knownImdb = new Set(pulseItems.map((p) => p.imdbId).filter((v): v is string => !!v));

  const push: PulseItem[] = [];
  const remove: PulseItem[] = [];
  const deleteItems: PulseItem[] = [];
  const clearDropped: PulseItem[] = [];

  for (const p of pulseItems) {
    if (!p.imdbId) continue; // unresolvable: never syncs, not an error
    const s = byImdb.get(p.imdbId);
    const presentInStremio = !!s && !s.removed;

    if (p.droppedAt !== null && presentInStremio) { clearDropped.push(p); continue; }

    if (p.onServer) {
      if (presentInStremio) remove.push(p);
      continue;
    }

    if (!s) { push.push(p); continue; }

    if (s.removed) {
      // Absent because the viewer removed it -> delete. Absent because pulse dropped it,
      // but pulse wants it again -> re-push; the stamp clears next cycle when we see it present.
      if (p.droppedAt === null) deleteItems.push(p);
      else push.push(p);
    }
  }

  const importItems = stremioItems.filter((s) => !s.removed && !knownImdb.has(s.imdbId));

  return { push, remove, importItems, deleteItems, clearDropped };
}
