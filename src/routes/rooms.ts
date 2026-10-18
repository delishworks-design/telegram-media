import { Router } from "express";
import type { AppDeps } from "../app.js";
import { requireAuth } from "../auth/middleware.js";
import { notFound } from "./helpers.js";

export function roomRoutes(deps: AppDeps): Router {
  const router = Router();
  router.use("/api/rooms", requireAuth(deps.db));

  router.post("/api/rooms", (req, res) => {
    const requested = typeof req.body?.room === "string" ? req.body.room : undefined;
    const mediaId = typeof req.body?.mediaId === "string" ? req.body.mediaId : undefined;
    const snapshot = deps.rooms.create(requested);
    if (mediaId) deps.rooms.setMedia(snapshot.id, mediaId);
    res.status(201).json({ id: snapshot.id, room: deps.rooms.get(snapshot.id) });
  });

  router.get("/api/rooms", (_req, res) => {
    res.json({ rooms: deps.rooms.list() });
  });

  router.get("/api/rooms/:id", (req, res) => {
    const snapshot = deps.rooms.get(req.params.id!);
    if (!snapshot) throw notFound("Room not found");
    res.json({ room: snapshot });
  });

  return router;
}
