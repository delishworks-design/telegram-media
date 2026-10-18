import { Router } from "express";
import type { AppDeps } from "../app.js";
import { requireAuth, currentUser } from "../auth/middleware.js";
import {
  SESSION_COOKIE,
  createSession,
  listSessions,
  revokeAllForUser,
  revokeSession,
  revokeSessionById,
} from "../auth/sessions.js";
import { verifyPassword } from "../util/crypto.js";
import { rateLimit } from "../util/ratelimit.js";
import { asyncHandler, requireString } from "./helpers.js";

export function authRoutes(deps: AppDeps): Router {
  const router = Router();
  const { db, config } = deps;

  const cookieOptions = {
    httpOnly: true,
    sameSite: "strict" as const,
    secure: config.cookieSecure,
    path: "/",
    maxAge: config.sessionTtlSeconds * 1000,
  };

  router.post(
    "/api/auth/login",
    rateLimit({ windowMs: 15 * 60 * 1000, max: 10, keyPrefix: "login" }),
    asyncHandler(async (req, res) => {
      const username = requireString(req.body?.username, "username", 100);
      const password = requireString(req.body?.password, "password", 400);
      const user = config.authUsers.find((u) => u.username === username);
      // Always run a verification to avoid a cheap user-enumeration timing signal.
      const candidate = user?.passwordHash ?? config.authUsers[0]?.passwordHash ?? "scrypt$16384$8$1$AA==$AA==";
      const ok = verifyPassword(password, candidate) && Boolean(user);
      if (!ok) {
        deps.logger.warn("login failed", { username });
        res.status(401).json({ error: "invalid_credentials" });
        return;
      }
      const { token, session } = await createSession(db, {
        username,
        ttlSeconds: config.sessionTtlSeconds,
        ip: req.ip,
        userAgent: req.get("user-agent") ?? undefined,
      });
      deps.logger.info("login ok", { username, sessionId: session.id });
      res.cookie(SESSION_COOKIE, token, cookieOptions);
      res.json({ user: { username }, expiresAt: session.expiresAt });
    }),
  );

  router.post(
    "/api/auth/logout",
    requireAuth(db),
    asyncHandler(async (req, res) => {
      await revokeSession(db, req.cookies?.[SESSION_COOKIE]);
      res.clearCookie(SESSION_COOKIE, { ...cookieOptions, maxAge: undefined });
      res.json({ ok: true });
    }),
  );

  router.get("/api/auth/me", requireAuth(db), (_req, res) => {
    const user = currentUser(res)!;
    res.json({ user: { username: user.username }, sessionId: user.id, expiresAt: user.expiresAt });
  });

  router.get(
    "/api/auth/sessions",
    requireAuth(db),
    asyncHandler(async (_req, res) => {
      const user = currentUser(res)!;
      res.json({ sessions: await listSessions(db, user.username) });
    }),
  );

  router.delete(
    "/api/auth/sessions/:id",
    requireAuth(db),
    asyncHandler(async (req, res) => {
      const user = currentUser(res)!;
      await revokeSessionById(db, req.params.id!);
      res.json({ ok: true, current: req.params.id === user.id });
    }),
  );

  router.post(
    "/api/auth/logout-all",
    requireAuth(db),
    asyncHandler(async (_req, res) => {
      const user = currentUser(res)!;
      const revoked = await revokeAllForUser(db, user.username);
      res.clearCookie(SESSION_COOKIE, { ...cookieOptions, maxAge: undefined });
      res.json({ ok: true, revoked });
    }),
  );

  return router;
}
