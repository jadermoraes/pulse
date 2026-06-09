/**
 * YAML config import/export helpers.
 * Kept in lib/server so they can be imported by both the +server.ts endpoint
 * and the unit tests without violating SvelteKit's +server.ts export rules.
 */
import { error } from '@sveltejs/kit';
import { parse as parseYaml } from 'yaml';
import type { DB } from './db';
import { listConnections, createConnection, updateConnection } from './connections';
import { setSetting } from './settings';

const LAYOUT_KEY = 'dashboard_layout';

export interface ConfigConnection {
  type: string;
  name: string;
  baseUrl: string;
  enabled?: boolean;
  options?: Record<string, unknown>;
  secret?: string | null;
}

export interface ParsedConfig {
  version: number;
  connections: ConfigConnection[];
  layout?: unknown[];
}

export interface ImportResult {
  ok: boolean;
  created: number;
  updated: number;
  layoutApplied: boolean;
}

/**
 * Parse and validate the config body (YAML or JSON string).
 * Throws a SvelteKit `error(400, ...)` on invalid input.
 */
export function parseAndValidate(body: string): ParsedConfig {
  let parsed: unknown;
  try {
    // YAML is a superset of JSON — try YAML first
    parsed = parseYaml(body);
  } catch {
    throw error(400, 'Invalid YAML/JSON: could not parse body');
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw error(400, 'Invalid config: expected an object');
  }

  const doc = parsed as Record<string, unknown>;

  // Version check
  if (!('version' in doc)) {
    throw error(400, 'Invalid config: missing "version" field');
  }
  const version = Number(doc.version);
  if (version !== 1) {
    throw error(400, `Unsupported config version: ${doc.version}`);
  }

  // Connections
  if (!('connections' in doc)) {
    throw error(400, 'Invalid config: missing "connections" field');
  }
  if (!Array.isArray(doc.connections)) {
    throw error(400, 'Invalid config: "connections" must be an array');
  }

  const connections: ConfigConnection[] = [];
  for (let i = 0; i < doc.connections.length; i++) {
    const c = doc.connections[i];
    if (!c || typeof c !== 'object' || Array.isArray(c)) {
      throw error(400, `Invalid config: connections[${i}] must be an object`);
    }
    const ci = c as Record<string, unknown>;
    if (typeof ci.type !== 'string' || !ci.type) {
      throw error(400, `Invalid config: connections[${i}].type must be a non-empty string`);
    }
    if (typeof ci.name !== 'string' || !ci.name) {
      throw error(400, `Invalid config: connections[${i}].name must be a non-empty string`);
    }
    if (typeof ci.baseUrl !== 'string' || !ci.baseUrl) {
      throw error(400, `Invalid config: connections[${i}].baseUrl must be a non-empty string`);
    }
    connections.push({
      type: ci.type,
      name: ci.name,
      baseUrl: ci.baseUrl,
      enabled: ci.enabled !== false,
      options:
        ci.options && typeof ci.options === 'object' && !Array.isArray(ci.options)
          ? (ci.options as Record<string, unknown>)
          : {},
      secret: typeof ci.secret === 'string' && ci.secret ? ci.secret : null
    });
  }

  // Layout (optional)
  let layout: unknown[] | undefined;
  if ('layout' in doc && Array.isArray(doc.layout)) {
    layout = doc.layout;
  }

  return { version, connections, layout };
}

/**
 * Apply a validated config to the database.
 * Returns the import summary.
 */
export function applyConfig(db: DB, config: ParsedConfig): ImportResult {
  const existing = listConnections(db);

  let created = 0;
  let updated = 0;

  for (const importedConn of config.connections) {
    // Match by (type + baseUrl) first, fallback to (type + name)
    const match =
      existing.find((e) => e.type === importedConn.type && e.baseUrl === importedConn.baseUrl) ??
      existing.find((e) => e.type === importedConn.type && e.name === importedConn.name);

    if (match) {
      // Only update secret when the import entry explicitly includes one
      const secret = importedConn.secret ? importedConn.secret : match.secret;
      updateConnection(db, match.id, {
        name: importedConn.name,
        baseUrl: importedConn.baseUrl,
        options: importedConn.options ?? {},
        enabled: importedConn.enabled !== false,
        secret
      });
      updated++;
    } else {
      createConnection(db, {
        type: importedConn.type,
        name: importedConn.name,
        baseUrl: importedConn.baseUrl,
        options: importedConn.options ?? {},
        enabled: importedConn.enabled !== false,
        secret: importedConn.secret ?? null
      });
      created++;
    }
  }

  let layoutApplied = false;
  if (config.layout && config.layout.length > 0) {
    setSetting(db, LAYOUT_KEY, JSON.stringify(config.layout));
    layoutApplied = true;
  }

  return { ok: true, created, updated, layoutApplied };
}
