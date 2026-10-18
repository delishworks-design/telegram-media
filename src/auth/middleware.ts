import type { Request, RequestHandler, Response } from "express";
import type { Database } from "../db/index.js";
import { SESSION_COOKIE, verifySession, type AuthenticatedSession } from "./sessions.js";

export function readSessionToken(req: Request): string | undefined {
  const cookie = (req.cookies as Record<string, string> | undefined)?.[SESSION_COOKIE];
  if (cookie) return cookie;
  const header = req.get("authorization");
  if (header?.toLowerCase().startsWith("bearer ")) return header.slice(7).trim();
  return undefined;
}

export function currentUser(res: Response): AuthenticatedSession | undefined {
  return (res.locals as { user?: AuthenticatedSession }).user;
}

// Rejects the request unless a valid, unrevoked, unexpired session is present.
export function requireAuth(db: Database): RequestHandler {
  return (req, res, next) => {
    const session = verifySession(db, readSessionToken(req));
    if (!session) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    (res.locals as { user?: AuthenticatedSession }).user = session;
    next();
  };
}
