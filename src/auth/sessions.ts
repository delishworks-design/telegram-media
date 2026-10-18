import { randomToken, sha256Hex } from "../util/crypto.js";
import type { Database } from "../db/index.js";

export const SESSION_COOKIE = "tm_session";

export interface SessionRow {
  id: string;
  username: string;
  created_at: number;
  expires_at: number;
  revoked_at: number | null;
}

export interface AuthenticatedSession {
  id: string;
  username: string;
  expiresAt: number;
}

export function createSession(
  db: Database,
  input: { username: string; ttlSeconds: number; ip?: string; userAgent?: string },
): { token: string; session: AuthenticatedSession } {
  const token = randomToken(32);
  const id = randomToken(16);
  const now = Date.now();
  const expiresAt = now + input.ttlSeconds * 1000;
  db.prepare(
    `INSERT INTO sessions (id, token_hash, username, created_at, expires_at, last_seen_at, user_agent, ip)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    sha256Hex(token),
    input.username,
    now,
    expiresAt,
    now,
    input.userAgent?.slice(0, 256) ?? null,
    input.ip?.slice(0, 64) ?? null,
  );
  return { token, session: { id, username: input.username, expiresAt } };
}

export function verifySession(db: Database, token: string | undefined): AuthenticatedSession | null {
  if (!token) return null;
  const row = db
    .prepare(
      `SELECT id, username, created_at, expires_at, revoked_at FROM sessions WHERE token_hash = ?`,
    )
    .get(sha256Hex(token)) as SessionRow | undefined;
  if (!row) return null;
  const now = Date.now();
  if (row.revoked_at !== null || row.expires_at <= now) return null;
  db.prepare(`UPDATE sessions SET last_seen_at = ? WHERE id = ?`).run(now, row.id);
  return { id: row.id, username: row.username, expiresAt: row.expires_at };
}

export function revokeSession(db: Database, token: string | undefined): void {
  if (!token) return;
  db.prepare(`UPDATE sessions SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL`).run(
    Date.now(),
    sha256Hex(token),
  );
}

export function revokeSessionById(db: Database, id: string): void {
  db.prepare(`UPDATE sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL`).run(
    Date.now(),
    id,
  );
}

export function revokeAllForUser(db: Database, username: string): number {
  const res = db
    .prepare(`UPDATE sessions SET revoked_at = ? WHERE username = ? AND revoked_at IS NULL`)
    .run(Date.now(), username);
  return res.changes;
}

export function listSessions(db: Database, username: string): Array<Omit<SessionRow, "revoked_at"> & { last_seen_at: number | null; user_agent: string | null }> {
  return db
    .prepare(
      `SELECT id, username, created_at, expires_at, last_seen_at, user_agent
       FROM sessions WHERE username = ? AND revoked_at IS NULL AND expires_at > ?
       ORDER BY last_seen_at DESC`,
    )
    .all(username, Date.now()) as ReturnType<typeof listSessions>;
}

export function purgeExpiredSessions(db: Database): number {
  const res = db
    .prepare(`DELETE FROM sessions WHERE expires_at < ? OR (revoked_at IS NOT NULL AND revoked_at < ?)`)
    .run(Date.now(), Date.now() - 24 * 60 * 60 * 1000);
  return res.changes;
}
