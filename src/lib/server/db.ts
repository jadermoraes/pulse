import Database from 'better-sqlite3';
import { encryptSecret } from './crypto';
export type DB = Database.Database;

export function openDb(file = process.env.PULSE_DB ?? '/data/pulse.sqlite'): DB {
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db;
}

export function migrate(db: DB): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY, email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id),
      expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS connections (
      id INTEGER PRIMARY KEY, type TEXT NOT NULL, name TEXT NOT NULL,
      base_url TEXT NOT NULL, secret TEXT, options TEXT NOT NULL DEFAULT '{}',
      enabled INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS ai_conversations (
      id INTEGER PRIMARY KEY, title TEXT, created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS ai_messages (
      id INTEGER PRIMARY KEY,
      conversation_id INTEGER NOT NULL REFERENCES ai_conversations(id) ON DELETE CASCADE,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      tokens INTEGER NOT NULL DEFAULT 0,
      ts INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS agent_actions (
      id INTEGER PRIMARY KEY,
      conversation_id INTEGER,
      ts INTEGER NOT NULL,
      actor INTEGER NOT NULL,
      tool TEXT NOT NULL,
      args TEXT NOT NULL,
      result TEXT,
      confirmed INTEGER NOT NULL DEFAULT 0,
      undo_token TEXT
    );
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY,
      ts INTEGER NOT NULL,
      source TEXT NOT NULL,
      type TEXT NOT NULL,
      severity TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT,
      entity_ref TEXT,
      suggested_actions TEXT,
      read INTEGER NOT NULL DEFAULT 0,
      dedupe_key TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_events_dedupe ON events(dedupe_key);
    CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);
    CREATE TABLE IF NOT EXISTS seen_events (
      dedupe_key TEXT PRIMARY KEY,
      first_ts INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_messages_conv ON ai_messages(conversation_id);
    CREATE TABLE IF NOT EXISTS roles (
      id INTEGER PRIMARY KEY, name TEXT UNIQUE NOT NULL,
      allow_list TEXT NOT NULL DEFAULT '[]',
      monthly_token_cap INTEGER,
      auto_approve INTEGER NOT NULL DEFAULT 0,
      seerr_quota TEXT NOT NULL DEFAULT '{}',
      is_admin INTEGER NOT NULL DEFAULT 0,
      editable INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS consumer_users (
      id INTEGER PRIMARY KEY,
      role_id INTEGER NOT NULL REFERENCES roles(id),
      display_name TEXT NOT NULL,
      jellyfin_user_id TEXT,
      seerr_user_id INTEGER,
      plex_account_id TEXT,
      language TEXT NOT NULL DEFAULT 'en',
      cap_override INTEGER,
      allow_override TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS consumer_sessions (
      id TEXT PRIMARY KEY,
      consumer_id INTEGER NOT NULL REFERENCES consumer_users(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS invites (
      id INTEGER PRIMARY KEY, token TEXT UNIQUE NOT NULL,
      role_id INTEGER NOT NULL REFERENCES roles(id),
      created_by INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      accepted_at INTEGER, accepted_consumer_id INTEGER,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS usage_counters (
      consumer_id INTEGER NOT NULL REFERENCES consumer_users(id) ON DELETE CASCADE,
      period TEXT NOT NULL,
      tokens_used INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (consumer_id, period)
    );
    CREATE INDEX IF NOT EXISTS idx_consumer_sessions_exp ON consumer_sessions(expires_at);
    CREATE INDEX IF NOT EXISTS idx_invites_token ON invites(token);
    CREATE TABLE IF NOT EXISTS push_subscriptions (
      id INTEGER PRIMARY KEY,
      consumer_id INTEGER NOT NULL REFERENCES consumer_users(id) ON DELETE CASCADE,
      endpoint TEXT NOT NULL,
      p256dh TEXT NOT NULL,
      auth TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      UNIQUE(consumer_id, endpoint)
    );
    CREATE TABLE IF NOT EXISTS consumer_requests (
      id INTEGER PRIMARY KEY,
      consumer_id INTEGER NOT NULL REFERENCES consumer_users(id) ON DELETE CASCADE,
      seerr_request_id INTEGER,
      tmdb_id INTEGER NOT NULL,
      media_type TEXT NOT NULL,
      title TEXT NOT NULL,
      status TEXT NOT NULL,
      notified INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_consumer_requests_consumer ON consumer_requests(consumer_id);
    CREATE TABLE IF NOT EXISTS ai_connections (
      id INTEGER PRIMARY KEY,
      label TEXT NOT NULL,
      provider TEXT NOT NULL,
      base_url TEXT,
      secret TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS ai_usage_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      model TEXT NOT NULL,
      input_tokens INTEGER NOT NULL,
      output_tokens INTEGER NOT NULL,
      cost_usd REAL NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_ai_usage_log_ts ON ai_usage_log(ts);
    CREATE TABLE IF NOT EXISTS password_resets (
      id INTEGER PRIMARY KEY,
      token TEXT NOT NULL UNIQUE,
      consumer_id INTEGER NOT NULL REFERENCES consumer_users(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL,
      used_at INTEGER,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS access_events (
      id INTEGER PRIMARY KEY,
      consumer_id INTEGER,
      ts INTEGER NOT NULL,
      type TEXT NOT NULL,
      ip TEXT,
      user_agent TEXT,
      detail TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_access_events_consumer ON access_events(consumer_id, ts);
    CREATE INDEX IF NOT EXISTS idx_access_events_ts ON access_events(ts);
    CREATE TABLE IF NOT EXISTS telegram_bindings (
      chat_id INTEGER PRIMARY KEY,
      kind TEXT NOT NULL,
      subject_id INTEGER NOT NULL,
      username TEXT,
      conversation_id INTEGER,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS telegram_link_tokens (
      token TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      subject_id INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      used_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS consumer_watchlist (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      consumer_id INTEGER NOT NULL,
      tmdb_id INTEGER NOT NULL,
      media_type TEXT NOT NULL,
      title TEXT NOT NULL,
      on_server INTEGER NOT NULL DEFAULT 0,
      notify_on_available INTEGER NOT NULL DEFAULT 1,
      jellyfin_item_id TEXT,
      added_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_watchlist_consumer_item
      ON consumer_watchlist(consumer_id, tmdb_id, media_type);
    CREATE INDEX IF NOT EXISTS idx_watchlist_consumer ON consumer_watchlist(consumer_id);
    CREATE TABLE IF NOT EXISTS consumer_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      consumer_id INTEGER NOT NULL,
      body TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      reply_body TEXT,
      replied_at INTEGER,
      read_by_consumer INTEGER NOT NULL DEFAULT 0,
      read_by_admin INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_consumer_messages_consumer ON consumer_messages(consumer_id, created_at);
    CREATE TABLE IF NOT EXISTS tg_admin_message_refs (
      chat_id INTEGER NOT NULL,
      message_id INTEGER NOT NULL,
      consumer_message_id INTEGER NOT NULL,
      PRIMARY KEY (chat_id, message_id)
    );
    CREATE TABLE IF NOT EXISTS watch_plays (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      consumer_id  INTEGER NOT NULL REFERENCES consumer_users(id) ON DELETE CASCADE,
      tmdb_id      INTEGER,
      imdb_id      TEXT,
      media_type   TEXT NOT NULL,
      season       INTEGER,
      episode      INTEGER,
      watched_at   INTEGER NOT NULL,
      source       TEXT NOT NULL,
      source_row   INTEGER,
      UNIQUE(consumer_id, source, source_row)
    );
    CREATE INDEX IF NOT EXISTS idx_watch_plays_consumer ON watch_plays(consumer_id, watched_at);
    CREATE TABLE IF NOT EXISTS spoke_credentials (
      consumer_id  INTEGER NOT NULL REFERENCES consumer_users(id) ON DELETE CASCADE,
      spoke        TEXT NOT NULL,
      secret       TEXT NOT NULL,
      refresh      TEXT,
      expires_at   INTEGER,
      enabled      INTEGER NOT NULL DEFAULT 1,
      fail_count   INTEGER NOT NULL DEFAULT 0,
      last_sync_at INTEGER,
      last_error   TEXT,
      created_at   INTEGER NOT NULL,
      PRIMARY KEY (consumer_id, spoke)
    );
    CREATE TABLE IF NOT EXISTS sync_state (
      consumer_id  INTEGER NOT NULL REFERENCES consumer_users(id) ON DELETE CASCADE,
      spoke        TEXT NOT NULL,
      entity       TEXT NOT NULL,
      tmdb_id      INTEGER NOT NULL,
      media_type   TEXT NOT NULL,
      synced_at    INTEGER,
      dropped_at   INTEGER,
      PRIMARY KEY (consumer_id, spoke, entity, tmdb_id, media_type)
    );
    CREATE TABLE IF NOT EXISTS consumer_ratings (
      consumer_id  INTEGER NOT NULL REFERENCES consumer_users(id) ON DELETE CASCADE,
      tmdb_id      INTEGER NOT NULL,
      media_type   TEXT NOT NULL,
      rating       INTEGER NOT NULL,
      rated_at     INTEGER NOT NULL,
      PRIMARY KEY (consumer_id, tmdb_id, media_type)
    );
    CREATE TABLE IF NOT EXISTS plex_guid_cache (
      rating_key   TEXT PRIMARY KEY,
      tmdb_id      INTEGER,
      imdb_id      TEXT,
      cached_at    INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS jellyfin_item_cache (
      item_id         TEXT PRIMARY KEY,
      item_type       TEXT,
      tmdb_id         INTEGER,
      imdb_id         TEXT,
      runtime_seconds INTEGER,
      cached_at       INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS imdb_meta_cache (
      imdb_id    TEXT NOT NULL,
      media_type TEXT NOT NULL,
      tmdb_id    INTEGER,
      name       TEXT,
      poster     TEXT,
      found      INTEGER NOT NULL,
      cached_at  INTEGER NOT NULL,
      PRIMARY KEY (imdb_id, media_type)
    );
    CREATE INDEX IF NOT EXISTS idx_imdb_meta_tmdb ON imdb_meta_cache(tmdb_id, media_type);
  `);

  // Seed the built-in, immutable Admin role exactly once (idempotent: name is UNIQUE).
  db.prepare(
    `INSERT INTO roles (name, allow_list, monthly_token_cap, auto_approve, seerr_quota, is_admin, editable, created_at)
     SELECT 'Admin', '[]', NULL, 1, '{}', 1, 0, ?
     WHERE NOT EXISTS (SELECT 1 FROM roles WHERE is_admin=1)`
  ).run(Date.now());

  // Enforce 1 Plex account → 1 consumer: partial unique index (NULLs are excluded, so multiple
  // consumers without Plex are fine). CREATE … IF NOT EXISTS is idempotent on existing DBs.
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_consumer_plex
    ON consumer_users(plex_account_id) WHERE plex_account_id IS NOT NULL
  `);

  // Enforce 1 Jellyfin user → 1 consumer, mirroring idx_consumer_plex above: without this, two
  // consumers sharing a jellyfin_user_id would let the Jellystat ingest's user map silently
  // resolve to whichever row SQLite returns last, routing one viewer's Jellyfin history to
  // another viewer's public Trakt profile. NULL and '' are both excluded (a blank id, like a
  // NULL one, means "not linked" and must never collide).
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_consumer_jellyfin
    ON consumer_users(jellyfin_user_id) WHERE jellyfin_user_id IS NOT NULL AND jellyfin_user_id <> ''
  `);

  // Add nullable consumer_id to the agent tables only if it does not already exist
  // (the tables exist in deployed DBs, so a bare ALTER would throw "duplicate column").
  const hasCol = (table: string, col: string): boolean =>
    (db.prepare(`pragma table_info(${table})`).all() as Array<{ name: string }>)
      .some((c) => c.name === col);
  if (!hasCol('ai_messages', 'consumer_id'))
    db.exec('ALTER TABLE ai_messages ADD COLUMN consumer_id INTEGER');
  if (!hasCol('agent_actions', 'consumer_id'))
    db.exec('ALTER TABLE agent_actions ADD COLUMN consumer_id INTEGER');
  // Owner of a conversation: NULL for admin-agent threads, the consumer id for consumer threads.
  // Used to enforce conversation ownership (IDOR fix) in the consumer chat endpoint.
  if (!hasCol('ai_conversations', 'consumer_id'))
    db.exec('ALTER TABLE ai_conversations ADD COLUMN consumer_id INTEGER');
  if (!hasCol('roles', 'plan_name'))
    db.exec('ALTER TABLE roles ADD COLUMN plan_name TEXT');
  if (!hasCol('consumer_users', 'jellyfin_username'))
    db.exec('ALTER TABLE consumer_users ADD COLUMN jellyfin_username TEXT');
  if (!hasCol('consumer_sessions', 'created_at'))
    db.exec('ALTER TABLE consumer_sessions ADD COLUMN created_at INTEGER');
  if (!hasCol('consumer_sessions', 'ip'))
    db.exec('ALTER TABLE consumer_sessions ADD COLUMN ip TEXT');
  if (!hasCol('consumer_sessions', 'user_agent'))
    db.exec('ALTER TABLE consumer_sessions ADD COLUMN user_agent TEXT');

  // One-time migration: re-encrypt any plaintext secrets in place.
  // Rows already encrypted start with 'v1:' and are skipped (idempotent).
  const rows = db.prepare(
    "SELECT id, secret FROM connections WHERE secret IS NOT NULL AND secret NOT LIKE 'v1:%'"
  ).all() as Array<{ id: number; secret: string }>;
  const update = db.prepare('UPDATE connections SET secret=? WHERE id=?');
  for (const r of rows) {
    update.run(encryptSecret(r.secret), r.id);
  }
}

let _db: DB | null = null;
export function getDb(): DB {
  if (!_db) { _db = openDb(); migrate(_db); }
  return _db;
}
