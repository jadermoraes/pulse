/**
 * Unit tests for YAML config import parse/validate/apply logic.
 * The DB layer is real (in-memory SQLite) but isolated per test.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, migrate, type DB } from './db';
import { getConnection, listConnections, createConnection } from './connections';
import { getSetting } from './settings';
import { parseAndValidate, applyConfig } from './config';

let db: DB;
beforeEach(() => {
  db = openDb(':memory:');
  migrate(db);
});

// ── parseAndValidate ────────────────────────────────────────────────────────

describe('parseAndValidate', () => {
  it('parses a valid YAML config', () => {
    const yaml = `
version: 1
connections:
  - type: jellyfin
    name: My JF
    baseUrl: http://localhost:8096
    enabled: true
    options: {}
layout:
  - key: jellyfin
    x: 0
    y: 0
    w: 4
    h: 3
    visible: true
    collapsed: false
`;
    const result = parseAndValidate(yaml);
    expect(result.version).toBe(1);
    expect(result.connections).toHaveLength(1);
    expect(result.connections[0].name).toBe('My JF');
    expect(result.layout).toHaveLength(1);
  });

  it('parses a valid JSON config (YAML is a superset of JSON)', () => {
    const json = JSON.stringify({
      version: 1,
      connections: [{ type: 'radarr', name: 'Radarr', baseUrl: 'http://localhost:7878', options: {} }],
      layout: []
    });
    const result = parseAndValidate(json);
    expect(result.connections[0].type).toBe('radarr');
  });

  it('throws 400 on completely invalid YAML', () => {
    // A tab character in non-indented position is a YAML error
    const badYaml = 'version: 1\nconnections: [\nkey: }\n\t{broken';
    expect(() => parseAndValidate(badYaml)).toThrow();
  });

  it('throws 400 when version is missing', () => {
    const yaml = 'connections: []\n';
    expect(() => parseAndValidate(yaml)).toThrow();
  });

  it('throws 400 when version is not 1', () => {
    const yaml = 'version: 2\nconnections: []\n';
    expect(() => parseAndValidate(yaml)).toThrow();
  });

  it('throws 400 when connections is missing', () => {
    const yaml = 'version: 1\n';
    expect(() => parseAndValidate(yaml)).toThrow();
  });

  it('throws 400 when a connection entry is missing required type', () => {
    const yaml = `
version: 1
connections:
  - name: NoType
    baseUrl: http://x
`;
    expect(() => parseAndValidate(yaml)).toThrow();
  });

  it('throws 400 when a connection entry is missing required name', () => {
    const yaml = `
version: 1
connections:
  - type: jellyfin
    baseUrl: http://x
`;
    expect(() => parseAndValidate(yaml)).toThrow();
  });

  it('throws 400 when a connection entry is missing required baseUrl', () => {
    const yaml = `
version: 1
connections:
  - type: jellyfin
    name: JF
`;
    expect(() => parseAndValidate(yaml)).toThrow();
  });

  it('defaults enabled to true when not specified', () => {
    const yaml = `
version: 1
connections:
  - type: jellyfin
    name: JF
    baseUrl: http://x
`;
    const result = parseAndValidate(yaml);
    expect(result.connections[0].enabled).toBe(true);
  });

  it('preserves secret when present', () => {
    const yaml = `
version: 1
connections:
  - type: jellyfin
    name: JF
    baseUrl: http://x
    secret: my-api-key
`;
    const result = parseAndValidate(yaml);
    expect(result.connections[0].secret).toBe('my-api-key');
  });

  it('sets secret to null when absent', () => {
    const yaml = `
version: 1
connections:
  - type: jellyfin
    name: JF
    baseUrl: http://x
`;
    const result = parseAndValidate(yaml);
    expect(result.connections[0].secret).toBeNull();
  });
});

// ── applyConfig ─────────────────────────────────────────────────────────────

describe('applyConfig', () => {
  it('creates new connections when none exist', () => {
    const config = parseAndValidate(`
version: 1
connections:
  - type: jellyfin
    name: JF
    baseUrl: http://localhost:8096
    options: {}
`);
    const result = applyConfig(db, config);
    expect(result.ok).toBe(true);
    expect(result.created).toBe(1);
    expect(result.updated).toBe(0);
    expect(listConnections(db)).toHaveLength(1);
  });

  it('updates an existing connection matched by type+baseUrl', () => {
    // Pre-create with the same type + baseUrl
    const id = createConnection(db, {
      type: 'jellyfin',
      name: 'Old JF',
      baseUrl: 'http://localhost:8096',
      secret: 'original-secret',
      options: {}
    });

    const config = parseAndValidate(`
version: 1
connections:
  - type: jellyfin
    name: New JF Name
    baseUrl: http://localhost:8096
    options: {}
`);
    const result = applyConfig(db, config);
    expect(result.created).toBe(0);
    expect(result.updated).toBe(1);

    const conn = getConnection(db, id);
    expect(conn?.name).toBe('New JF Name');
  });

  it('keeps existing secret when import entry has no secret (secret-less GitOps file)', () => {
    const id = createConnection(db, {
      type: 'radarr',
      name: 'Radarr',
      baseUrl: 'http://localhost:7878',
      secret: 'precious-api-key',
      options: {}
    });

    const config = parseAndValidate(`
version: 1
connections:
  - type: radarr
    name: Radarr
    baseUrl: http://localhost:7878
    options: {}
`);
    applyConfig(db, config);

    const conn = getConnection(db, id);
    // Secret must be preserved — not wiped
    expect(conn?.secret).toBe('precious-api-key');
  });

  it('updates secret when import entry includes a non-empty secret', () => {
    const id = createConnection(db, {
      type: 'radarr',
      name: 'Radarr',
      baseUrl: 'http://localhost:7878',
      secret: 'old-key',
      options: {}
    });

    const config = parseAndValidate(`
version: 1
connections:
  - type: radarr
    name: Radarr
    baseUrl: http://localhost:7878
    secret: new-key
    options: {}
`);
    applyConfig(db, config);

    const conn = getConnection(db, id);
    expect(conn?.secret).toBe('new-key');
  });

  it('falls back to type+name match when baseUrl differs', () => {
    const id = createConnection(db, {
      type: 'sonarr',
      name: 'Sonarr',
      baseUrl: 'http://old-host:8989',
      secret: null,
      options: {}
    });

    const config = parseAndValidate(`
version: 1
connections:
  - type: sonarr
    name: Sonarr
    baseUrl: http://new-host:8989
    options: {}
`);
    const result = applyConfig(db, config);
    // Should UPDATE (matched by type+name), not create
    expect(result.created).toBe(0);
    expect(result.updated).toBe(1);
    const conn = getConnection(db, id);
    expect(conn?.baseUrl).toBe('http://new-host:8989');
  });

  it('applies layout when present', () => {
    const config = parseAndValidate(`
version: 1
connections: []
layout:
  - key: jellyfin
    x: 0
    y: 0
    w: 4
    h: 3
    visible: true
    collapsed: false
`);
    const result = applyConfig(db, config);
    expect(result.layoutApplied).toBe(true);
    const stored = getSetting(db, 'dashboard_layout');
    expect(stored).not.toBeNull();
    const parsed = JSON.parse(stored!);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].key).toBe('jellyfin');
  });

  it('does not apply layout when layout is absent or empty', () => {
    const config = parseAndValidate(`
version: 1
connections: []
`);
    const result = applyConfig(db, config);
    expect(result.layoutApplied).toBe(false);
    expect(getSetting(db, 'dashboard_layout')).toBeNull();
  });

  it('creates multiple connections from a full import', () => {
    const config = parseAndValidate(`
version: 1
connections:
  - type: jellyfin
    name: JF
    baseUrl: http://localhost:8096
    options: {}
  - type: radarr
    name: Radarr
    baseUrl: http://localhost:7878
    options: {}
  - type: sonarr
    name: Sonarr
    baseUrl: http://localhost:8989
    options: {}
`);
    const result = applyConfig(db, config);
    expect(result.created).toBe(3);
    expect(result.updated).toBe(0);
    expect(listConnections(db)).toHaveLength(3);
  });
});
