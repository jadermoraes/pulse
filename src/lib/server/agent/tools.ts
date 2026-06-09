import { z } from 'zod';
import { tool, jsonSchema, type Tool } from 'ai';
import { listConnections, getConnection } from '../connections';
import { getIntegration } from '../integrations';
import { resolveWidget } from '../../widgets';
import { resolveAction, resolveDetail } from '../actions';
import { collectStats } from '../metrics';
import { listContainers, containerStats, containerLogs } from '../docker';
import { aggregateNowPlaying, aggregateWatchHistory } from '../watch';
import { listEvents } from './events';
import { getJsonWithKey, joinUrl } from '../http';
import { SEERR_PATHS } from '../consumer/types';
import { scrub } from './scrub';
import { connectionApiRequest } from './api-passthrough';
import { getConsumer } from '../identity/consumers';
import { addWatchlist, listWatchlist, removeWatchlist } from '../consumer/watchlist';
import { listMyRequests, cancelMyRequest } from '../consumer/my-requests';
import { mirrorFavorite } from '../consumer/jellyfin-favorite';
import { submitConsumerMessage } from '../consumer/submit-message';
import type { DB } from '../db';
import type { AgentContext, ToolSpec } from './types';

// Disk mounts to report (mirrors /api/server/stats).
function mounts(): string[] {
  const raw = process.env.PULSE_DISK_MOUNTS;
  return raw ? raw.split(',').map((m) => m.trim()).filter(Boolean) : ['/'];
}

/** True if seerr reports this title's mediaInfo.status === 5 (available / on server). Best-effort. */
async function titleOnServer(db: DB, tmdbId: number, mediaType: string): Promise<boolean> {
  const seerr = listConnections(db).find((c) => c.type === 'seerr' && c.enabled);
  if (!seerr) return false;
  try {
    const path = mediaType === 'tv' ? `/api/v1/tv/${tmdbId}` : `/api/v1/movie/${tmdbId}`;
    const d = await getJsonWithKey(joinUrl(seerr.baseUrl, path), seerr.secret);
    return d?.mediaInfo?.status === 5;
  } catch { return false; }
}

/**
 * Build the per-request tool specs from the current connections.
 * READ tools wrap the existing read layer; WRITE tools wrap resolveAction / docker writes.
 * Every result is scrubbed before it can reach the model.
 */
export async function buildToolSpecs(ctx: AgentContext): Promise<ToolSpec[]> {
  const specs: ToolSpec[] = [];
  const conns = listConnections(ctx.db).filter((c) => c.enabled);

  // ---- universal READ tools ---------------------------------------------
  specs.push({
    name: 'listConnections', risk: 'read', category: 'system',
    description:
      'List the homelab service connections configured in Pulse (id, type, name). ' +
      'Call this first to learn which services exist and their numeric ids.',
    async run(ctx) {
      return scrub(listConnections(ctx.db).map((c) => ({
        id: c.id, type: c.type, name: c.name, enabled: c.enabled
      })));
    }
  });

  specs.push({
    name: 'getServerStats', risk: 'read', category: 'system',
    description: 'Host metrics: CPU %, RAM %, disk usage per mount, uptime, load average.',
    async run() { return scrub(await collectStats({ mounts: mounts(), sampleMs: 200 })); }
  });

  specs.push({
    name: 'listContainers', risk: 'read', category: 'system',
    description: 'List Docker containers with id, name, image, and state (running/exited).',
    async run() { return scrub(await listContainers()); }
  });

  specs.push({
    name: 'getContainerStats', risk: 'read', category: 'system',
    description: 'CPU % and memory % for one Docker container by id.',
    async run(_ctx, args) { return scrub(await containerStats(String(args.id))); }
  });

  specs.push({
    name: 'getContainerLogs', risk: 'read', category: 'system',
    description: 'Recent log lines (tail) for one Docker container by id.',
    async run(_ctx, args) {
      const tail = typeof args.tail === 'number' ? args.tail : 200;
      return scrub(await containerLogs(String(args.id), tail));
    }
  });

  specs.push({
    name: 'getWidget', risk: 'read', category: 'media',
    description:
      'Read a widget for a connection: live data such as Jellyfin nowPlaying/recentlyAdded, ' +
      'seerr requests, radarr/sonarr queue/wanted, qbittorrent torrents/transfers. ' +
      'Args: { connectionId, widget }. Use listConnections to find valid widget names per type.',
    async run(ctx, args) {
      const r = await resolveWidget(ctx.db, Number(args.connectionId), String(args.widget));
      return scrub(r);
    }
  });

  specs.push({
    name: 'getMediaDetail', risk: 'read', category: 'media',
    description: 'Rich detail for one media item. Args: { connectionId, params } (e.g. { id, kind }).',
    async run(ctx, args) {
      const r = await resolveDetail(ctx.db, Number(args.connectionId),
        (args.params as Record<string, unknown>) ?? {});
      return scrub(r);
    }
  });

  specs.push({
    name: 'searchMedia', risk: 'read', category: 'requests',
    description:
      'Search for a movie or TV show by title to get its exact tmdbId, year, and mediaType. ' +
      'ALWAYS use this to resolve a title before requesting — never guess a tmdbId. ' +
      'Each result also carries `onServer` (true = the title is ALREADY in the library / available ' +
      'to watch) and `requested` (true = a request is pending/processing). Use `onServer` to answer ' +
      '"do I have X?" — it is authoritative; do NOT instead guess from radarr/sonarr queues or ' +
      'recently-added lists (those miss already-imported titles).',
    async run(ctx, args) {
      const seerr = listConnections(ctx.db).find((c) => c.type === 'seerr' && c.enabled);
      if (!seerr) return { results: [], error: 'No request service configured' };
      // seerr rejects '+' in the query (it requires %20), so percent-encode explicitly
      // instead of going through joinUrl/URLSearchParams (which encodes spaces as '+').
      const q = String(args.query ?? '');
      const searchUrl =
        `${seerr.baseUrl.replace(/\/$/, '')}${SEERR_PATHS.search}?query=${encodeURIComponent(q)}`;
      const d = await getJsonWithKey(searchUrl, seerr.secret);
      const results = ((d.results ?? []) as any[])
        .filter((r) => (r.mediaType === 'movie' || r.mediaType === 'tv') && r.id != null)
        .slice(0, 6)
        .map((r) => {
          const mediaType: 'movie' | 'tv' = r.mediaType === 'tv' ? 'tv' : 'movie';
          const title: string = (mediaType === 'tv' ? r.name : r.title) ?? `#${r.id}`;
          const date: string | undefined = mediaType === 'tv' ? r.firstAirDate : r.releaseDate;
          // seerr mediaInfo.status: 5 = Available (on server / in the library), 1–4 = pending/
          // processing/partial (requested but not yet available), absent = not requested.
          const status: number | undefined =
            typeof r.mediaInfo?.status === 'number' ? r.mediaInfo.status : undefined;
          return {
            title,
            year: date ? Number(String(date).slice(0, 4)) || undefined : undefined,
            tmdbId: r.id,
            mediaType,
            overview: r.overview || undefined,
            onServer: status === 5,
            requested: status != null && status >= 1 && status < 5
          };
        });
      return scrub({ results });
    }
  });

  specs.push({
    name: 'getNowPlaying', risk: 'read', category: 'media',
    description: 'Currently-streaming sessions across all Jellyfin/Plex connections.',
    async run(ctx) { return scrub(await aggregateNowPlaying(listConnections(ctx.db))); }
  });

  specs.push({
    name: 'getWatchHistory', risk: 'read', category: 'media',
    description: 'Recently-watched items across all watch sources.',
    async run(ctx) { return scrub(await aggregateWatchHistory(listConnections(ctx.db), 15)); }
  });

  specs.push({
    name: 'getEvents', risk: 'read', category: 'events',
    description:
      'The in-app event feed ("what is wrong right now?"): downloads done/stalled, ' +
      'requests available, containers down, disk pressure, connectivity drops. ' +
      'Args: { unreadOnly?: boolean, limit?: number }.',
    async run(ctx, args) {
      return scrub(listEvents(ctx.db, {
        unreadOnly: Boolean(args.unreadOnly),
        limit: typeof args.limit === 'number' ? args.limit : 30
      }));
    }
  });

  // ---- per-connection WRITE tools (only if any integration exposes actions)
  const anyActions = conns.some((c) => getIntegration(c.type)?.actions);
  if (anyActions) {
    specs.push({
      name: 'runAction', risk: 'write', category: 'media',
      description:
        'Perform a write action on a service: request media (create a seerr request), ' +
        'approve/decline/research a seerr request, ' +
        're-search or remove a radarr/sonarr queue item, pause/resume/delete a qbittorrent torrent, ' +
        'or a Jellyfin deep link. Args: { connectionId, action, params }. ' +
        'To request a title use action "request" with params { mediaType: "movie"|"tv", tmdbId }. ' +
        'This is a WRITE.',
      async run(ctx, args) {
        const params = { ...((args.params as Record<string, unknown>) ?? {}) };
        // Consumer attribution: a viewer's request is attributed to THEIR seerr user, not the owner.
        if (ctx.consumer && args.action === 'request') {
          const seerrUserId = getConsumer(ctx.db, ctx.consumer.id)?.seerrUserId;
          if (seerrUserId != null) params.userId = seerrUserId;
        }
        const r = await resolveAction(ctx.db, Number(args.connectionId), String(args.action), params);
        return scrub(r);
      },
      summarize(ctx, args) {
        const conn = listConnections(ctx.db).find((c) => c.id === Number(args.connectionId));
        return `Run "${args.action}" on ${conn?.name ?? `connection ${args.connectionId}`} ` +
          `(${JSON.stringify(scrub(args.params ?? {}))})`;
      }
    });
  }

  // ---- Docker WRITE tools -----------------------------------------------
  specs.push({
    name: 'restartContainer', risk: 'write', category: 'system',
    description: 'Restart a Docker container by id. WRITE — requires confirmation.',
    async run(_ctx, args) {
      const { restartContainer } = await import('../docker');
      return scrub(await restartContainer(String(args.id)));
    },
    summarize(_ctx, args) { return `Restart container ${args.id}`; },
    undo(_ctx, _args) { return null; } // restart has no clean inverse
  });

  specs.push({
    name: 'stopContainer', risk: 'write', category: 'system',
    description: 'Stop a running Docker container by id. WRITE — requires confirmation.',
    async run(_ctx, args) {
      const { stopContainer } = await import('../docker');
      return scrub(await stopContainer(String(args.id)));
    },
    summarize(_ctx, args) { return `Stop container ${args.id}`; },
    // Inverse of stop is start; modeled as a runAction-less docker start in undo (Task 7 maps it).
    undo(_ctx, args) { return { tool: 'restartContainer', args: { id: args.id }, label: 'Start container' }; }
  });

  // ---- Generic API passthrough (ADMIN agent only; consumer turns never get these) -------------
  if (!ctx.consumer) {
    specs.push({
      name: 'apiRead', risk: 'read', category: 'system',
      description:
        'Make a GET request to ANY endpoint of a configured service\'s API (use listConnections for ids). ' +
        'Use this for anything the curated read tools do not cover. Base paths: radarr/sonarr /api/v3, ' +
        'seerr /api/v1, qbittorrent /api/v2, jellyfin its API, proxmox /api2/json, tautulli /api/v2?cmd=. ' +
        'Args: { connectionId, path, query? }. The server injects auth — you never handle secrets.',
      async run(ctx, args) {
        const conn = getConnection(ctx.db, Number(args.connectionId));
        if (!conn || !conn.enabled) return { status: 0, data: { error: 'No such connection' } };
        return scrub(await connectionApiRequest(conn, {
          method: 'GET', path: String(args.path),
          query: (args.query as Record<string, string | number>) ?? undefined
        }));
      }
    });
    specs.push({
      name: 'apiWrite', risk: 'write', category: 'system',
      description:
        'Make a write request (POST/PUT/PATCH/DELETE) to a configured service\'s API — add/search/grab/' +
        'monitor/quality/remove, qbittorrent control, proxmox VM/LXC actions, etc. Args: { connectionId, ' +
        'method, path, body?, query?, summary }. `summary` MUST be a clear plain-English description of the ' +
        'real-world effect — the admin approves based on it. This is a WRITE (requires confirmation).',
      async run(ctx, args) {
        const conn = getConnection(ctx.db, Number(args.connectionId));
        if (!conn || !conn.enabled) return { status: 0, data: { error: 'No such connection' } };
        const method = String(args.method).toUpperCase();
        if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
          return { status: 0, data: { error: 'apiWrite only allows POST/PUT/PATCH/DELETE' } };
        }
        return scrub(await connectionApiRequest(conn, {
          method: method as 'POST' | 'PUT' | 'PATCH' | 'DELETE',
          path: String(args.path), body: args.body,
          query: (args.query as Record<string, string | number>) ?? undefined
        }));
      },
      summarize(ctx, args) {
        const conn = getConnection(ctx.db, Number(args.connectionId));
        return String(args.summary || `${args.method} ${args.path} on ${conn?.name ?? `connection ${args.connectionId}`}`);
      }
    });

    // ---- Docker Engine API passthrough (read + write; never container exec) -----------------
    specs.push({
      name: 'dockerApi', risk: 'read', category: 'system',
      description:
        'GET the Docker Engine API (e.g. /containers/json?all=1, /images/json, /info). Args: { path, query? }.',
      async run(_ctx, args) {
        const { dockerRequest } = await import('../docker');
        return scrub(await dockerRequest('GET', dockerPath(String(args.path), args.query as Record<string, string | number> | undefined)));
      }
    });
    specs.push({
      name: 'dockerWrite', risk: 'write', category: 'system',
      description:
        'Write to the Docker Engine API (POST/PUT/DELETE) — start/stop/restart/create/remove containers, ' +
        'networks, volumes. Args: { method, path, body?, summary }. `summary` MUST be a clear plain-English ' +
        'description of the real-world effect. WRITE — requires confirmation. (No container exec / shell.)',
      async run(_ctx, args) {
        const method = String(args.method).toUpperCase();
        if (!['POST', 'PUT', 'DELETE'].includes(method)) {
          return { status: 0, data: { error: 'dockerWrite only allows POST/PUT/DELETE' } };
        }
        if (/\/exec\b/i.test(String(args.path))) {
          return { status: 0, data: { error: 'Container exec (shell) is not permitted.' } };
        }
        const { dockerRequest } = await import('../docker');
        return scrub(await dockerRequest(method as 'POST' | 'PUT' | 'DELETE', String(args.path), args.body));
      },
      summarize(_ctx, args) { return String(args.summary || `Docker ${args.method} ${args.path}`); }
    });
  }

  // ---- Consumer-only tools (watchlist / my-requests / message-admin). Built only on consumer
  //      turns; each is mapped in TOOL_CAPABILITY so scopeConsumerSpecs gates them per role. ------
  if (ctx.consumer) {
    const consumerId = ctx.consumer.id;
    specs.push({
      name: 'watchlistList', risk: 'read', category: 'requests',
      description: 'List the titles on THIS viewer\'s watchlist (save-for-later), with on-server + notify status. Args: {}.',
      async run(ctx) { return scrub({ items: listWatchlist(ctx.db, consumerId) }); }
    });
    specs.push({
      name: 'watchlistAdd', risk: 'write', category: 'requests',
      description:
        'Save a title to the viewer\'s watchlist. Use searchMedia first to get tmdbId + mediaType. ' +
        'Args: { tmdbId, mediaType: "movie"|"tv", title, notifyOnAvailable? }. If the title is not yet on ' +
        'the server, the viewer is notified when it arrives (notifyOnAvailable defaults true for missing ' +
        'titles). On-server titles are mirrored into their Jellyfin Favorites.',
      async run(ctx, args) {
        const tmdbId = Number(args.tmdbId);
        const mediaType = args.mediaType === 'tv' ? 'tv' : 'movie';
        const title = String(args.title ?? `#${tmdbId}`);
        const onServer = await titleOnServer(ctx.db, tmdbId, mediaType);
        const notifyOnAvailable = args.notifyOnAvailable != null ? Boolean(args.notifyOnAvailable) : !onServer;
        addWatchlist(ctx.db, { consumerId, tmdbId, mediaType, title, onServer, notifyOnAvailable });
        if (onServer) await mirrorFavorite(ctx.db, consumerId, tmdbId, mediaType, true);
        return scrub({ ok: true, title, onServer, notifyOnAvailable });
      }
    });
    specs.push({
      name: 'watchlistRemove', risk: 'write', category: 'requests',
      description: 'Remove a title from the viewer\'s watchlist. Args: { tmdbId, mediaType }.',
      async run(ctx, args) {
        const tmdbId = Number(args.tmdbId);
        const mediaType = args.mediaType === 'tv' ? 'tv' : 'movie';
        const removed = removeWatchlist(ctx.db, consumerId, tmdbId, mediaType);
        if (removed?.jellyfinItemId) await mirrorFavorite(ctx.db, consumerId, tmdbId, mediaType, false);
        return scrub({ ok: !!removed });
      }
    });
    specs.push({
      name: 'myRequests', risk: 'read', category: 'requests',
      description: 'List THIS viewer\'s own media requests with their status (pending/approved/processing/available/declined). Args: {}.',
      async run(ctx) {
        const seerrUserId = getConsumer(ctx.db, consumerId)?.seerrUserId;
        if (seerrUserId == null) return { items: [], note: 'No linked request account' };
        return scrub({ items: await listMyRequests(ctx.db, seerrUserId) });
      }
    });
    specs.push({
      name: 'cancelRequest', risk: 'write', category: 'requests',
      description:
        'Cancel one of the VIEWER\'S OWN requests. Args: { requestId } or { tmdbId, mediaType }. ' +
        'Only the viewer\'s own requests can be cancelled.',
      async run(ctx, args) {
        const seerrUserId = getConsumer(ctx.db, consumerId)?.seerrUserId;
        if (seerrUserId == null) return { ok: false, error: 'No linked request account' };
        return scrub(await cancelMyRequest(ctx.db, seerrUserId, {
          requestId: args.requestId != null ? Number(args.requestId) : undefined,
          tmdbId: args.tmdbId != null ? Number(args.tmdbId) : undefined,
          mediaType: args.mediaType != null ? String(args.mediaType) : undefined
        }));
      }
    });
    specs.push({
      name: 'messageAdmin', risk: 'write', category: 'requests',
      description: 'Send a short message or problem report to the server admin. Args: { message }.',
      async run(ctx, args) {
        const message = String(args.message ?? '').trim();
        if (!message) return { ok: false, error: 'Empty message' };
        const who = getConsumer(ctx.db, consumerId)?.displayName ?? `consumer ${consumerId}`;
        const id = await submitConsumerMessage(ctx.db, consumerId, message, who);
        return scrub({ ok: id > 0 });
      }
    });
  }

  return specs;
}

/** Append a query object to a Docker Engine API path as a query string (path as-is if none). */
function dockerPath(path: string, query?: Record<string, string | number>): string {
  if (!query || Object.keys(query).length === 0) return path;
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) qs.set(k, String(v));
  const sep = path.includes('?') ? '&' : '?';
  return `${path}${sep}${qs.toString()}`;
}

// zod input schema per tool name (kept here so descriptions + schemas live together).
function schemaFor(name: string): z.ZodType {
  switch (name) {
    case 'getWidget':
      return z.object({ connectionId: z.number(), widget: z.string() });
    case 'getMediaDetail':
      return z.object({ connectionId: z.number(), params: z.record(z.string(), z.unknown()).optional() });
    case 'getContainerStats':
    case 'restartContainer':
    case 'stopContainer':
      return z.object({ id: z.string() });
    case 'getContainerLogs':
      return z.object({ id: z.string(), tail: z.number().optional() });
    case 'getEvents':
      return z.object({ unreadOnly: z.boolean().optional(), limit: z.number().optional() });
    case 'searchMedia':
      return z.object({ query: z.string() });
    case 'runAction':
      return z.object({
        connectionId: z.number(), action: z.string(),
        params: z.record(z.string(), z.unknown()).optional()
      });
    case 'apiRead':
      return z.object({
        connectionId: z.number(), path: z.string(),
        query: z.record(z.string(), z.union([z.string(), z.number()])).optional()
      });
    case 'apiWrite':
      return z.object({
        connectionId: z.number(), method: z.string(), path: z.string(),
        body: z.unknown().optional(),
        query: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
        summary: z.string()
      });
    case 'dockerApi':
      return z.object({
        path: z.string(),
        query: z.record(z.string(), z.union([z.string(), z.number()])).optional()
      });
    case 'dockerWrite':
      return z.object({
        method: z.string(), path: z.string(),
        body: z.unknown().optional(),
        summary: z.string()
      });
    case 'watchlistList':
      return z.object({});
    case 'watchlistAdd':
      return z.object({ tmdbId: z.number(), mediaType: z.string(), title: z.string(), notifyOnAvailable: z.boolean().optional() });
    case 'watchlistRemove':
      return z.object({ tmdbId: z.number(), mediaType: z.string() });
    case 'myRequests':
      return z.object({});
    case 'cancelRequest':
      return z.object({ requestId: z.number().optional(), tmdbId: z.number().optional(), mediaType: z.string().optional() });
    case 'messageAdmin':
      return z.object({ message: z.string() });
    default:
      return z.object({}); // listConnections, getServerStats, listContainers, getNowPlaying, getWatchHistory
  }
}

// The symbol the AI SDK stamps on a Schema produced by jsonSchema()/zodSchema().
const AI_SCHEMA_SYMBOL = Symbol.for('vercel.ai.schema');

/** True when `s` is already an AI-SDK Schema object (not a raw JSON-schema or zod type). */
function isAiSchema(s: unknown): boolean {
  return typeof s === 'object' && s !== null && (s as Record<symbol, unknown>)[AI_SCHEMA_SYMBOL] === true;
}

/**
 * Pick the input schema a tool should expose to the model.
 *  - MCP specs carry their own schema (an AI-SDK Schema the MCP client produced, or a raw
 *    JSON schema). Use it so the model sees the tool's real parameters; without this MCP
 *    read tools would get z.object({}) and the SDK would strip every property → execute({}).
 *  - Built-in tools keep their hand-written zod schema via schemaFor().
 */
function inputSchemaFor(spec: ToolSpec): z.ZodType | ReturnType<typeof jsonSchema> {
  if (spec.category === 'mcp' && spec.inputSchema != null) {
    const s = spec.inputSchema;
    // Already an AI-SDK Schema (the common MCP case) → use as-is; else wrap a raw JSON schema.
    return (isAiSchema(s) ? s : jsonSchema(s as Parameters<typeof jsonSchema>[0])) as ReturnType<typeof jsonSchema>;
  }
  return schemaFor(spec.name);
}

/**
 * Convert ToolSpecs into an AI-SDK toolset.
 *  - READ tools get an `execute` (run inline; SDK feeds the result back).
 *  - WRITE tools get NO `execute` — streamText surfaces the call and pauses (the confirmation gate).
 */
export function toAiTools(ctx: AgentContext, specs: ToolSpec[]): Record<string, Tool> {
  const out: Record<string, Tool> = {};
  for (const spec of specs) {
    const inputSchema = inputSchemaFor(spec);
    if (spec.risk === 'read') {
      out[spec.name] = tool({
        description: spec.description,
        inputSchema,
        // NEVER let a read tool throw out of execute: a failing integration (e.g. Radarr down
        // while fetching releases) would otherwise error the stream and leave a dangling
        // tool-call in history that breaks every later turn. Return the error as the tool result
        // so the model can recover and tell the user what went wrong.
        async execute(args) {
          try {
            return await spec.run(ctx, args as Record<string, unknown>);
          } catch (e) {
            return { ok: false, error: `${spec.name} failed: ${(e as Error).message}` };
          }
        }
      });
    } else {
      // No execute → human-in-the-loop. The run.ts loop handles the surfaced call.
      out[spec.name] = tool({ description: spec.description, inputSchema });
    }
  }
  return out;
}
