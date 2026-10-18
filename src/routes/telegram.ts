import { Router } from "express";
import type { AppDeps } from "../app.js";
import { requireAuth } from "../auth/middleware.js";
import { rateLimit } from "../util/ratelimit.js";
import { NotConfiguredError, TelegramFloodError } from "../telegram/service.js";
import { asyncHandler, HttpError, requireString } from "./helpers.js";

export function telegramRoutes(deps: AppDeps): Router {
  const router = Router();
  // Scoped to this prefix so the middleware never leaks onto other routers.
  router.use("/api/telegram", requireAuth(deps.db));

  router.get(
    "/api/telegram/status",
    asyncHandler(async (_req, res) => {
      res.json(await deps.telegram.getStatus());
    }),
  );

  router.post(
    "/api/telegram/login/start",
    rateLimit({ windowMs: 10 * 60 * 1000, max: 8, keyPrefix: "tg-start" }),
    asyncHandler(async (req, res) => {
      const phone = requireString(req.body?.phone, "phone", 32);
      const apiId = req.body?.apiId !== undefined ? Number(req.body.apiId) : undefined;
      const apiHash = typeof req.body?.apiHash === "string" ? req.body.apiHash : undefined;
      if (apiId !== undefined && !Number.isInteger(apiId)) throw new HttpError(400, "apiId must be an integer");
      const result = await deps.telegram.startLogin({ phone, apiId, apiHash });
      res.json(result);
    }),
  );

  router.post(
    "/api/telegram/login/code",
    rateLimit({ windowMs: 10 * 60 * 1000, max: 20, keyPrefix: "tg-code" }),
    asyncHandler(async (req, res) => {
      const loginId = requireString(req.body?.loginId, "loginId", 200);
      const code = requireString(req.body?.code, "code", 20);
      const phone = typeof req.body?.phone === "string" ? req.body.phone : undefined;
      res.json(await deps.telegram.submitCode(loginId, code, phone));
    }),
  );

  router.post(
    "/api/telegram/login/password",
    rateLimit({ windowMs: 10 * 60 * 1000, max: 20, keyPrefix: "tg-pw" }),
    asyncHandler(async (req, res) => {
      const loginId = requireString(req.body?.loginId, "loginId", 200);
      const password = requireString(req.body?.password, "password", 400);
      res.json(await deps.telegram.submitPassword(loginId, password));
    }),
  );

  router.post(
    "/api/telegram/channel",
    asyncHandler(async (req, res) => {
      const channel = typeof req.body?.channel === "string" ? req.body.channel : undefined;
      res.json(await deps.telegram.setChannel(channel));
    }),
  );

  router.post(
    "/api/telegram/logout",
    asyncHandler(async (_req, res) => {
      await deps.telegram.logoutTelegram();
      res.json({ ok: true });
    }),
  );

  return router;
}

export function isTelegramConfiguredError(err: unknown): boolean {
  return err instanceof NotConfiguredError || err instanceof TelegramFloodError;
}
