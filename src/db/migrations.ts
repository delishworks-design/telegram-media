export interface Migration {
  id: number;
  name: string;
  sql: string;
}

// Migrations are embedded (not read from disk) so a compiled dist/ build is
// self-contained. Each runs once, in order, inside a transaction.
export const MIGRATIONS: Migration[] = [
  {
    id: 1,
    name: "init",
    sql: `
      -- Login sessions. Tokens are stored only as SHA-256 hashes.
      CREATE TABLE sessions (
        id           TEXT PRIMARY KEY,
        token_hash   TEXT NOT NULL UNIQUE,
        username     TEXT NOT NULL,
        created_at   INTEGER NOT NULL,
        expires_at   INTEGER NOT NULL,
        revoked_at   INTEGER,
        last_seen_at INTEGER,
        user_agent   TEXT,
        ip           TEXT
      );
      CREATE INDEX idx_sessions_token_hash ON sessions(token_hash);
      CREATE INDEX idx_sessions_expires ON sessions(expires_at);

      -- Single-row Telegram account configuration. api_hash is sealed at rest.
      CREATE TABLE telegram_config (
        id               INTEGER PRIMARY KEY CHECK (id = 1),
        api_id           INTEGER,
        api_hash_enc     TEXT,
        phone            TEXT,
        channel_id       TEXT,
        channel_title    TEXT,
        channel_access_hash TEXT,
        updated_at       INTEGER NOT NULL
      );

      -- Single-row encrypted MTProto session string.
      CREATE TABLE telegram_session (
        id          INTEGER PRIMARY KEY CHECK (id = 1),
        session_enc TEXT NOT NULL,
        updated_at  INTEGER NOT NULL
      );

      -- Pending interactive login state (phoneCodeHash etc.), sealed at rest.
      CREATE TABLE telegram_login (
        id          TEXT PRIMARY KEY,
        state_enc   TEXT NOT NULL,
        updated_at  INTEGER NOT NULL
      );

      -- Media library metadata. No binaries — those live in Telegram.
      CREATE TABLE media (
        id             TEXT PRIMARY KEY,
        name           TEXT NOT NULL,
        search_name    TEXT NOT NULL,
        size           INTEGER NOT NULL,
        mime           TEXT NOT NULL,
        duration       REAL,
        width          INTEGER,
        height         INTEGER,
        message_id     INTEGER NOT NULL,
        channel_id     TEXT NOT NULL,
        file_reference TEXT,
        thumb_reference TEXT,
        thumb_message_id INTEGER,
        status         TEXT NOT NULL DEFAULT 'ready',
        error          TEXT,
        created_by     TEXT,
        uploaded_at    INTEGER NOT NULL,
        updated_at     INTEGER NOT NULL
      );
      CREATE INDEX idx_media_search ON media(search_name);
      CREATE INDEX idx_media_uploaded ON media(uploaded_at DESC);

      -- Resumable upload sessions and their received chunks.
      CREATE TABLE uploads (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        size        INTEGER NOT NULL,
        mime        TEXT NOT NULL,
        received    INTEGER NOT NULL DEFAULT 0,
        expected_chunks INTEGER,
        status      TEXT NOT NULL,
        error       TEXT,
        media_id    TEXT,
        tmp_path    TEXT,
        created_by  TEXT,
        attempts    INTEGER NOT NULL DEFAULT 0,
        created_at  INTEGER NOT NULL,
        updated_at  INTEGER NOT NULL
      );
      CREATE INDEX idx_uploads_status ON uploads(status);

      CREATE TABLE upload_chunks (
        upload_id TEXT NOT NULL,
        idx       INTEGER NOT NULL,
        size      INTEGER NOT NULL,
        PRIMARY KEY (upload_id, idx),
        FOREIGN KEY (upload_id) REFERENCES uploads(id) ON DELETE CASCADE
      );
    `,
  },
];

export function applyMigrations(db: {
  exec(sql: string): unknown;
  prepare(sql: string): { get(...args: unknown[]): unknown; run(...args: unknown[]): unknown };
}): number {
  db.exec(`CREATE TABLE IF NOT EXISTS _migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)`);
  const has = db.prepare(`SELECT id FROM _migrations WHERE id = ?`);
  let applied = 0;
  for (const m of MIGRATIONS) {
    if (has.get(m.id)) continue;
    db.exec("BEGIN");
    try {
      db.exec(m.sql);
      db.prepare(`INSERT INTO _migrations (id, name, applied_at) VALUES (?, ?, ?)`).run(
        m.id,
        m.name,
        Date.now(),
      );
      db.exec("COMMIT");
      applied++;
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }
  return applied;
}
