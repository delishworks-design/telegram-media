import express, { Router } from "express";
import type { AppDeps } from "../app.js";
import { requireAuth, currentUser } from "../auth/middleware.js";
import { asyncHandler, badRequest, notFound, requireString } from "./helpers.js";

export function uploadRoutes(deps: AppDeps): Router {
  const router = Router();
  const { db, uploads, config } = deps;

  router.use("/api/uploads", requireAuth(db));

  // Server-sent events: live progress for the whole queue.
  router.get(
    "/api/uploads/events",
    asyncHandler(async (req, res) => {
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache, no-transform");
      res.setHeader("Connection", "keep-alive");
      res.setHeader("X-Accel-Buffering", "no");
      res.flushHeaders?.();

      const send = (event: unknown) => {
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      };
      send({ type: "hello", records: await uploads.list() });

      const unsubscribe = uploads.subscribe(send);
      const ping = setInterval(() => res.write(`: ping\n\n`), 20000);
      req.on("close", () => {
        clearInterval(ping);
        unsubscribe();
      });
    }),
  );

  router.get(
    "/api/uploads",
    asyncHandler(async (_req, res) => {
      res.json({ items: await uploads.list() });
    }),
  );

  router.post(
    "/api/uploads",
    asyncHandler(async (req, res) => {
      const user = currentUser(res)!;
      const name = requireString(req.body?.name, "name", 255);
      const size = Number(req.body?.size);
      const mime = typeof req.body?.mime === "string" && req.body.mime ? req.body.mime : "application/octet-stream";
      if (!Number.isFinite(size) || size <= 0) throw badRequest("size must be a positive number");
      const result = await uploads.create({ name, size, mime, createdBy: user.username });
      res.status(201).json({
        id: result.id,
        chunkSize: result.chunkSize,
        expectedChunks: result.expectedChunks,
        upload: result.upload,
      });
    }),
  );

  // Chunk body arrives as a raw octet-stream at offset index*chunkSize.
  router.put(
    "/api/uploads/:id/chunk/:index",
    express.raw({ type: () => true, limit: config.chunkSizeBytes + 1024 * 1024 }),
    asyncHandler(async (req, res) => {
      const body = req.body as Buffer;
      if (!Buffer.isBuffer(body) || body.length === 0) throw badRequest("empty chunk");
      if (body.length > config.chunkSizeBytes) throw badRequest("chunk larger than configured chunk size");
      const index = Number(req.params.index);
      const record = await uploads.appendChunk(req.params.id!, index, body);
      res.json({ upload: record });
    }),
  );

  router.post(
    "/api/uploads/:id/complete",
    asyncHandler(async (req, res) => {
      res.json({ upload: await uploads.finalize(req.params.id!) });
    }),
  );

  router.get(
    "/api/uploads/:id",
    asyncHandler(async (req, res) => {
      const record = await uploads.get(req.params.id!);
      if (!record) throw notFound("Upload not found");
      res.json({ upload: record });
    }),
  );

  router.delete(
    "/api/uploads/:id",
    asyncHandler(async (req, res) => {
      const record = await uploads.cancel(req.params.id!);
      if (!record) throw notFound("Upload not found");
      res.json({ upload: record });
    }),
  );

  router.post(
    "/api/uploads/:id/retry",
    asyncHandler(async (req, res) => {
      const record = await uploads.retry(req.params.id!);
      if (!record) throw notFound("Upload not found");
      res.json({ upload: record });
    }),
  );

  return router;
}
