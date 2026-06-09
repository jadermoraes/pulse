import type { Connection } from '../connections';

export interface ConfigField {
  key: string; label: string; type: 'url' | 'text' | 'password';
  required?: boolean; placeholder?: string;
}
export interface TestResult { ok: boolean; message: string; }
export interface WidgetResult { ok: boolean; data?: unknown; error?: string; }

// An action result is EITHER an API mutation outcome { ok, message? }
// OR a deep-link { ok: true, url } the dispatcher returns for the browser to open.
// No secret ever appears in this shape.
export interface ActionResult { ok: boolean; message?: string; url?: string; }

export interface ActionHandler {
  id: string;                 // 'approve', 'pause', 'playInJellyfin'
  label: string;              // human label for the drawer/list button
  kind: string;               // DrawerItem.kind this applies to, lowercased ('request'|'movie'|'download'|…)
  run(conn: Connection, params: Record<string, unknown>): Promise<ActionResult>;
}

// ---------------------------------------------------------------------------
// Rich media detail (the dynamic detail-drawer payload).
// No secret ever appears in this shape — posters are either full public URLs
// (TMDB) or proxied paths routed through /api/image/<connectionId>.
// ---------------------------------------------------------------------------

// state drives the status-pill colour in the drawer.
export type DetailState = 'ok' | 'proc' | 'bad' | 'idle';

export interface DetailStatus {
  label: string;              // 'Available', 'Pending', 'Unreleased', …
  state: DetailState;
}

// A drawer action button. `kind` selects the dispatch path:
//  - 'action'   → POST /api/actions/<conn>/<actionId> with `params`
//  - 'deeplink' → POST the same, then window.open(result.url)
//  - 'docker'   → POST /api/docker/containers/<id>/<dockerAction>
export interface DetailAction {
  id: string;                 // stable key for the button
  label: string;
  icon?: string;              // optional leading glyph
  kind: 'action' | 'deeplink' | 'docker';
  actionId?: string;          // for kind 'action'|'deeplink'
  dockerAction?: string;      // for kind 'docker'
  params?: Record<string, unknown>;
  variant?: 'p' | 's' | 'd';  // button style hint (primary/secondary/danger)
}

export interface MediaDetail {
  title: string;
  subtitle?: string;
  year?: number | string;
  poster?: string;            // full URL or proxied /api/image path
  overview?: string;
  runtimeMin?: number;
  rating?: number;            // 0-10
  releaseDate?: string;       // ISO / 'YYYY-MM-DD'
  imdbUrl?: string;
  genres?: string[];
  status: DetailStatus;
  actions: DetailAction[];
}

export interface ImageRequest {
  /** Fully-built upstream URL (may contain server-side auth in the query string). */
  url: string;
  /** Additional HTTP headers to send to the upstream server. */
  headers?: Record<string, string>;
}

export interface Integration {
  type: string;                 // 'jellyfin'
  label: string;                // 'Jellyfin'
  icon: string;                 // 'jellyfin'
  configSchema: ConfigField[];
  testConnection(conn: Connection): Promise<TestResult>;
  widgets: Record<string, (conn: Connection) => Promise<WidgetResult>>;
  actions?: Record<string, ActionHandler>;   // optional; key === ActionHandler.id
  // Optional rich detail for the drawer. Throwing is fine — the endpoint isolates it.
  detail?(conn: Connection, params: Record<string, unknown>): Promise<MediaDetail>;
  /**
   * Optional image proxy hook. Given a server-relative `path` (e.g. `/Items/123/Images/Primary`
   * for Jellyfin, or a Plex thumb path like `/library/metadata/123/thumb/456` for Tautulli),
   * returns the fully-built upstream URL + headers to fetch with.
   * The apikey/token MUST be embedded server-side here — the browser only ever sees the path.
   */
  imageRequest?(conn: Connection, path: string): ImageRequest;
}
