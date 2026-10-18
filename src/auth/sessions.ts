import { randomToken, sha256Hex } from "../util/crypto.js";
import type { Db } from "../db/index.js";

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

export async function createSession(
  db: Db,
  input: { username: string; ttlSeconds: number; ip?: string; userAgent?: string },
): Promise<{ token: string; session: AuthenticatedSession }> {
  const token = randomToken(32);
  const id = randomToken(16);
  const now = Date.now();
  const expiresAt = now + input.ttlSeconds * 1000;
  await db.run(
    `INSERT INTO sessions (id, token_hash, username, created_at, expires_at, last_seen_at, user_agent, ip)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      sha256Hex(token),
      input.username,
      now,
      expiresAt,
      now,
      input.userAgent?.slice(0, 256) ?? null,
      input.ip?.slice(0, 64) ?? null,
    ],
  );
  return { token, session: { id, username: input.username, expiresAt } };
}

export async function verifySession(db: Db, token: string | undefined): Promise<AuthenticatedSession | null> {
  if (!token) return null;
  const row = await db.get<SessionRow>(
    `SELECT id, username, created_at, expires_at, revoked_at FROM sessions WHERE token_hash = ?`,
    [sha256Hex(token)],
  );
  if (!row) return null;
  const now = Date.now();
  if (row.revoked_at !== null || row.expires_at <= now) return null;
  await db.run(`UPDATE sessions SET last_seen_at = ? WHERE id = ?`, [now, row.id]);
  return { id: row.id, username: row.username, expiresAt: row.expires_at };
}

export async function revokeSession(db: Db, token: string | undefined): Promise<void> {
  if (!token) return;
  await db.run(`UPDATE sessions SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL`, [
    Date.now(),
    sha256Hex(token),
  ]);
}

export async function revokeSessionById(db: Db, id: string): Promise<void> {
  await db.run(`UPDATE sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL`, [Date.now(), id]);
}

export async function revokeAllForUser(db: Db, username: string): Promise<number> {
  const res = await db.run(`UPDATE sessions SET revoked_at = ? WHERE username = ? AND revoked_at IS NULL`, [
    Date.now(),
    username,
  ]);
  return res.changes;
}

export async function listSessions(
  db: Db,
  username: string,
): Promise<Array<Omit<SessionRow, "revoked_at"> & { last_seen_at: number | null; user_agent: string | null }>> {
  return db.all(
    `SELECT id, username, created_at, expires_at, last_seen_at, user_agent
     FROM sessions WHERE username = ? AND revoked_at IS NULL AND expires_at > ?
     ORDER BY last_seen_at DESC`,
    [username, Date.now()],
  );
}

export async function purgeExpiredSessions(db: Db): Promise<number> {
  const res = await db.run(
    `DELETE FROM sessions WHERE expires_at < ? OR (revoked_at IS NOT NULL AND revoked_at < ?)`,
    [Date.now(), Date.now() - 24 * 60 * 60 * 1000],
  );
  return res.changes;
}
