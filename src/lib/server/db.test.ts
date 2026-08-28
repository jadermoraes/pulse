import { describe, it, expect } from 'vitest';
import { openDb, migrate } from './db';

describe('db', () => {
  it('creates the schema with required tables', () => {
    const db = openDb(':memory:');
    migrate(db);
    const tables = db.prepare(
      "select name from sqlite_master where type='table' order by name"
    ).all().map((r: any) => r.name);
    expect(tables).toEqual(expect.arrayContaining(['connections', 'sessions', 'settings', 'users']));
  });
});

describe('agent-core schema', () => {
  it('creates ai_conversations, ai_messages, agent_actions, events', () => {
    const db = openDb(':memory:');
    migrate(db);
    const tables = db.prepare("select name from sqlite_master where type='table'")
      .all().map((r: any) => r.name);
    expect(tables).toEqual(expect.arrayContaining([
      'ai_conversations', 'ai_messages', 'agent_actions', 'events'
    ]));
    // column smoke-checks
    const evCols = db.prepare('pragma table_info(events)').all().map((r: any) => r.name);
    expect(evCols).toEqual(expect.arrayContaining([
      'id', 'ts', 'source', 'type', 'severity', 'title', 'body', 'entity_ref', 'suggested_actions', 'read', 'dedupe_key'
    ]));
    const aaCols = db.prepare('pragma table_info(agent_actions)').all().map((r: any) => r.name);
    expect(aaCols).toEqual(expect.arrayContaining([
      'id', 'conversation_id', 'ts', 'actor', 'tool', 'args', 'result', 'confirmed', 'undo_token'
    ]));
  });
});

import { describe as dD, it as iD, expect as eD } from 'vitest';
import { openDb as openDbD, migrate as migrateD } from './db';

dD('consumer PWA schema (sub-project D)', () => {
  iD('creates push_subscriptions + consumer_requests (+ index) and is idempotent', () => {
    const db = openDbD(':memory:'); migrateD(db); migrateD(db); // twice
    const tables = db.prepare("select name from sqlite_master where type='table'")
      .all().map((r: any) => r.name);
    eD(tables).toEqual(expect.arrayContaining(['push_subscriptions', 'consumer_requests']));
    const idx = db.prepare("select name from sqlite_master where type='index'")
      .all().map((r: any) => r.name);
    eD(idx).toContain('idx_consumer_requests_consumer');
    const ps = db.prepare('pragma table_info(push_subscriptions)').all().map((r: any) => r.name);
    eD(ps).toEqual(expect.arrayContaining(['id', 'consumer_id', 'endpoint', 'p256dh', 'auth', 'created_at']));
    const cr = db.prepare('pragma table_info(consumer_requests)').all().map((r: any) => r.name);
    eD(cr).toEqual(expect.arrayContaining([
      'id', 'consumer_id', 'seerr_request_id', 'tmdb_id', 'media_type', 'title', 'status', 'notified', 'created_at'
    ]));
  });

  iD('adds nullable plan_name to roles (guarded ALTER, idempotent)', () => {
    const db = openDbD(':memory:'); migrateD(db); migrateD(db);
    const rc = db.prepare('pragma table_info(roles)').all().map((r: any) => r.name);
    eD(rc).toContain('plan_name');
  });
});

import { describe as dAi, it as iAi, expect as eAi } from 'vitest';
import { openDb as openDbAi, migrate as migrateAi } from './db';

dAi('ai_connections schema', () => {
  iAi('creates ai_connections with the expected columns and is idempotent', () => {
    const db = openDbAi(':memory:'); migrateAi(db); migrateAi(db); // twice
    const tables = db.prepare("select name from sqlite_master where type='table'")
      .all().map((r: any) => r.name);
    eAi(tables).toContain('ai_connections');
    const cols = db.prepare('pragma table_info(ai_connections)').all().map((r: any) => r.name);
    eAi(cols).toEqual(expect.arrayContaining([
      'id', 'label', 'provider', 'base_url', 'secret', 'created_at'
    ]));
  });
});

import { describe as dPR, it as iPR, expect as ePR } from 'vitest';
import { openDb as openDbPR, migrate as migratePR } from './db';

dPR('password_resets + access_events schema', () => {
  iPR('creates password_resets and access_events tables', () => {
    const d = openDbPR(':memory:'); migratePR(d);
    const tables = (d.prepare("select name from sqlite_master where type='table'").all() as Array<{ name: string }>)
      .map((r) => r.name);
    ePR(tables).toContain('password_resets');
    ePR(tables).toContain('access_events');
    const arCols = (d.prepare('pragma table_info(access_events)').all() as Array<{ name: string }>).map((c) => c.name);
    ePR(arCols).toEqual(expect.arrayContaining(['consumer_id', 'ts', 'type', 'ip', 'user_agent', 'detail']));
  });
});

import { describe as dTG, it as iTG, expect as eTG } from 'vitest';
import { openDb as openDbTG, migrate as migrateTG } from './db';

dTG('telegram schema', () => {
  iTG('creates telegram_bindings + telegram_link_tokens tables', () => {
    const d = openDbTG(':memory:'); migrateTG(d);
    const tables = (d.prepare("select name from sqlite_master where type='table'").all() as Array<{ name: string }>).map((r) => r.name);
    eTG(tables).toEqual(expect.arrayContaining(['telegram_bindings', 'telegram_link_tokens']));
    const cols = (d.prepare('pragma table_info(telegram_bindings)').all() as Array<{ name: string }>).map((c) => c.name);
    eTG(cols).toEqual(expect.arrayContaining(['chat_id', 'kind', 'subject_id', 'username', 'conversation_id', 'created_at']));
  });
});

import { describe as dB, it as iB, expect as eB } from 'vitest';
import { openDb as openDbB, migrate as migrateB } from './db';

dB('accounts schema (sub-project B)', () => {
  iB('creates roles, consumer_users, consumer_sessions, invites, usage_counters', () => {
    const db = openDbB(':memory:'); migrateB(db);
    const tables = db.prepare("select name from sqlite_master where type='table'")
      .all().map((r: any) => r.name);
    eB(tables).toEqual(expect.arrayContaining([
      'roles', 'consumer_users', 'consumer_sessions', 'invites', 'usage_counters'
    ]));
    const rc = db.prepare('pragma table_info(roles)').all().map((r: any) => r.name);
    eB(rc).toEqual(expect.arrayContaining([
      'id', 'name', 'allow_list', 'monthly_token_cap', 'auto_approve', 'seerr_quota',
      'is_admin', 'editable', 'created_at'
    ]));
    const cu = db.prepare('pragma table_info(consumer_users)').all().map((r: any) => r.name);
    eB(cu).toEqual(expect.arrayContaining([
      'id', 'role_id', 'display_name', 'jellyfin_user_id', 'seerr_user_id', 'plex_account_id',
      'language', 'cap_override', 'allow_override', 'status', 'created_at'
    ]));
  });

  iB('seeds exactly one immutable admin role and is idempotent', () => {
    const db = openDbB(':memory:'); migrateB(db); migrateB(db); // run twice
    const admins = db.prepare('select id,name,is_admin,editable from roles where is_admin=1').all() as any[];
    eB(admins.length).toBe(1);
    eB(admins[0].editable).toBe(0);
  });

  iB('adds nullable consumer_id to ai_messages and agent_actions', () => {
    const db = openDbB(':memory:'); migrateB(db);
    const mc = db.prepare('pragma table_info(ai_messages)').all().map((r: any) => r.name);
    const ac = db.prepare('pragma table_info(agent_actions)').all().map((r: any) => r.name);
    eB(mc).toContain('consumer_id');
    eB(ac).toContain('consumer_id');
  });

  iB('adds nullable jellyfin_username to consumer_users (guarded ALTER, idempotent)', () => {
    const db = openDbB(':memory:'); migrateB(db); migrateB(db); // run twice — idempotency
    const cu = db.prepare('pragma table_info(consumer_users)').all().map((r: any) => r.name);
    eB(cu).toContain('jellyfin_username');
  });
});

import { describe as dSH, it as iSH, expect as eSH } from 'vitest';
import { openDb as openDbSH, migrate as migrateSH } from './db';

dSH('sync hub schema', () => {
  iSH('migrate creates the sync hub tables', () => {
    const db = openDbSH(':memory:');
    migrateSH(db);
    const names = (db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table'"
    ).all() as Array<{ name: string }>).map((r) => r.name);
    eSH(names).toContain('watch_plays');
    eSH(names).toContain('spoke_credentials');
    eSH(names).toContain('sync_state');
    eSH(names).toContain('consumer_ratings');
  });

  iSH('watch_plays rejects a duplicate (consumer, source, source_row)', () => {
    const db = openDbSH(':memory:');
    migrateSH(db);
    // Seed a consumer_users row for the foreign key constraint
    db.prepare('INSERT INTO consumer_users(role_id, display_name, created_at) VALUES(?, ?, ?)')
      .run(1, 'Test Consumer', Date.now());
    const ins = db.prepare(
      `INSERT INTO watch_plays(consumer_id,tmdb_id,imdb_id,media_type,season,episode,watched_at,source,source_row)
       VALUES (?,?,?,?,?,?,?,?,?)`
    );
    ins.run(1, 550, 'tt0137523', 'movie', null, null, 1000, 'tautulli', 42);
    eSH(() => ins.run(1, 550, 'tt0137523', 'movie', null, null, 2000, 'tautulli', 42)).toThrow();
  });
});
