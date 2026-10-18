import { Router } from "express";
import type { AppDeps } from "../app.js";
import { requireAuth, readSessionToken } from "../auth/middleware.js";
import { verifySession } from "../auth/sessions.js";
import { issuePlaybackToken, verifyPlaybackToken } from "../media/tokens.js";
import { streamMedia } from "../media/streaming.js";
import type { MediaCategory, MediaRecord } from "../media/repository.js";
import { asyncHandler, notFound, requireString } from "./helpers.js";

const CATEGORIES = new Set<MediaCategory>(["video", "audio", "image", "other"]);
const SORTS = new Set(["date_desc", "date_asc", "name_asc", "size_desc"]);

function publicMedia(record: MediaRecord) {
  const r = record;
  return {
    id: r.id,
    name: r.name,
    size: r.size,
    mime: r.mime,
    category: r.mime.startsWith("video/")
      ? "video"
      : r.mime.startsWith("audio/")
        ? "audio"
        : r.mime.startsWith("image/")
          ? "image"
          : "other",
    duration: r.duration,
    width: r.width,
    height: r.height,
    uploadedAt: r.uploadedAt,
    updatedAt: r.updatedAt,
    createdBy: r.createdBy,
    status: r.status,
    streamUrl: `/api/media/${r.id}/stream`,
  };
}

export function mediaRoutes(deps: AppDeps): Router {
  const router = Router();
  const { db, repo, config } = deps;

  router.get("/api/media", requireAuth(db), (req, res) => {
    const q = typeof req.query.q === "string" ? req.query.q : undefined;
    const categoryRaw = typeof req.query.category === "string" ? req.query.category : undefined;
    const sortRaw = typeof req.query.sort === "string" ? req.query.sort : undefined;
    const limit = req.query.limit ? Number(req.query.limit) : undefined;
    const offset = req.query.offset ? Number(req.query.offset) : undefined;

    const category = categoryRaw && CATEGORIES.has(categoryRaw as MediaCategory)
      ? (categoryRaw as MediaCategory)
      : undefined;
    const sort = sortRaw && SORTS.has(sortRaw) ? (sortRaw as "date_desc") : undefined;

    const { items, total } = repo.list({ q, category, sort, limit, offset });
    res.json({
      items: items.map((m) => publicMedia(m)),
      total,
      limit: Math.min(Math.max(limit ?? 100, 1), 500),
      offset: offset ?? 0,
    });
  });

  router.get("/api/media/:id", requireAuth(db), (req, res) => {
    const record = repo.get(req.params.id!);
    if (!record) throw notFound("Media not found");
    res.json({ item: publicMedia(record) });
  });

  router.patch("/api/media/:id", requireAuth(db), (req, res) => {
    const name = requireString(req.body?.name, "name", 255);
    const updated = repo.rename(req.params.id!, name);
    if (!updated) throw notFound("Media not found");
    res.json({ item: publicMedia(updated) });
  });

  router.delete("/api/media/:id", asyncHandler(async (req, res) => {
    const record = repo.get(req.params.id!);
    if (!record) throw notFound("Media not found");
    const telegram = req.query.telegram !== "false";
    if (telegram) {
      try {
        await deps.store.delete(repo.ref(record));
      } catch (err) {
        deps.logger.error("telegram delete failed", { mediaId: record.id, error: (err as Error).message });
        res.status(502).json({
          error: "telegram_delete_failed",
          message: "The file could not be deleted from Telegram; the library entry was kept.",
          explanation: deps.store.describeDelete(),
        });
        return;
      }
    }
    repo.delete(record.id);
    deps.logger.info("media deleted", { mediaId: record.id, telegramDeleted: telegram });
    res.json({ deleted: true, telegramDeleted: telegram, explanation: deps.store.describeDelete() });
  }));

  // Issues a short-lived, signed URL. Lets another app (e.g. Watch Together)
  // embed playback without sharing the session cookie.
  router.post("/api/media/:id/playback-token", requireAuth(db), (req, res) => {
    const record = repo.get(req.params.id!);
    if (!record) throw notFound("Media not found");
    const room = typeof req.body?.room === "string" ? req.body.room.slice(0, 120) : undefined;
    const user = (res.locals as { user?: { username: string } }).user;
    const token = issuePlaybackToken(
      config.playbackSecret,
      { mediaId: record.id, room, sub: user?.username },
      config.playbackTokenTtl,
    );
    const base = config.publicBaseUrl || "";
    res.json({
      token,
      url: `${base}/api/media/${record.id}/stream?token=${encodeURIComponent(token)}`,
      expiresIn: config.playbackTokenTtl,
      item: publicMedia(record),
    });
  });

  // Authenticated playback. Accepts a session cookie *or* a signed playback
  // token, supports HEAD and HTTP Range (206 Partial Content).
  router.all("/api/media/:id/stream", asyncHandler(async (req, res) => {
    const id = req.params.id!;
    const record = repo.get(id);
    if (!record) throw notFound("Media not found");

    const session = verifySession(db, readSessionToken(req));
    let granted = Boolean(session);
    if (!granted) {
      const token = typeof req.query.token === "string" ? req.query.token : undefined;
      const grant = verifyPlaybackToken(config.playbackSecret, token);
      granted = Boolean(grant && grant.mediaId === id);
    }
    if (!granted) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.status(405).json({ error: "method_not_allowed" });
      return;
    }

    const controller = new AbortController();
    req.on("close", () => controller.abort());

    const etag = `"${record.id}-${record.uploadedAt}"`;
    const ifNoneMatch = req.get("if-none-match");
    if (ifNoneMatch && ifNoneMatch === etag && !req.get("range")) {
      res.status(304).end();
      return;
    }

    await streamMedia(res, {
      store: deps.store,
      ref: repo.ref(record),
      size: record.size,
      mime: record.mime,
      name: record.name,
      rangeHeader: req.get("range"),
      etag,
      headOnly: req.method === "HEAD",
      signal: controller.signal,
      logger: deps.logger,
    });
  }));

  return router;
}
