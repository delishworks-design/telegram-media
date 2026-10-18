import { Router } from "express";
import type { AppDeps } from "../app.js";

export function healthRoutes(deps: AppDeps): Router {
  const router = Router();

  router.get("/healthz", (_req, res) => {
    res.json({ ok: true, uptime: Math.round(process.uptime()) });
  });

  router.get("/api/health", async (_req, res) => {
    const telegram = await deps.telegram.getStatus().catch(() => null);
    res.json({
      ok: true,
      service: "telegram-media",
      time: new Date().toISOString(),
      telegram: {
        configured: telegram?.configured ?? false,
        authorized: telegram?.authorized ?? false,
        channelSet: telegram?.channel.set ?? false,
        storeReady: telegram?.storeReady ?? false,
      },
      storageKind: deps.store.kind,
    });
  });

  return router;
}
