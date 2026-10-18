import { fileURLToPath } from "node:url";
import cookieParser from "cookie-parser";
import express, { type NextFunction, type Request, type Response } from "express";
import type { AppConfig } from "./config.js";
import type { Database } from "./db/index.js";
import type { Logger } from "./util/logger.js";
import type { MediaStore } from "./media/store.js";
import type { TelegramBackend } from "./telegram/types.js";
import type { MediaRepository } from "./media/repository.js";
import type { UploadManager } from "./media/upload-manager.js";
import type { RoomManager } from "./realtime/rooms.js";
import { authRoutes } from "./routes/auth.js";
import { telegramRoutes } from "./routes/telegram.js";
import { mediaRoutes } from "./routes/media.js";
import { uploadRoutes } from "./routes/uploads.js";
import { roomRoutes } from "./routes/rooms.js";
import { healthRoutes } from "./routes/health.js";
import { HttpError } from "./routes/helpers.js";

export interface AppDeps {
  config: AppConfig;
  db: Database;
  logger: Logger;
  store: MediaStore;
  telegram: TelegramBackend;
  repo: MediaRepository;
  uploads: UploadManager;
  rooms: RoomManager;
}

// The class token is the file → its location is stable across src/ and dist/.
const publicDir = fileURLToPath(new URL("../public", import.meta.url));

export function createApp(deps: AppDeps): express.Express {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", deps.config.trustProxy);

  app.use((_req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
    next();
  });

  app.use(corsMiddleware(deps.config));
  app.use(cookieParser());
  app.use(express.json({ limit: "1mb" }));

  app.use(healthRoutes(deps));
  app.use(authRoutes(deps));
  app.use(telegramRoutes(deps));
  app.use(uploadRoutes(deps));
  app.use(mediaRoutes(deps));
  app.use(roomRoutes(deps));

  app.use(express.static(publicDir, { index: "index.html", extensions: ["html"] }));

  app.use("/api", (_req, res) => {
    res.status(404).json({ error: "not_found" });
  });

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const status =
      err instanceof HttpError
        ? err.statusCode
        : typeof (err as { statusCode?: number })?.statusCode === "number"
          ? (err as { statusCode: number }).statusCode
          : 500;
    const message = (err as Error)?.message ?? "internal_error";
    if (status >= 500) deps.logger.error("request failed", { error: message, status });
    else deps.logger.warn("request rejected", { error: message, status });
    res.status(status).json({ error: status >= 500 ? "internal_error" : "request_error", message: status >= 500 ? undefined : message });
  });

  return app;
}

function corsMiddleware(config: AppConfig): express.RequestHandler {
  return (req, res, next) => {
    const origin = req.get("origin");
    if (origin && (config.corsOrigins.includes(origin) || config.corsOrigins.includes("*"))) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Access-Control-Allow-Credentials", "true");
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,HEAD,OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
      res.setHeader("Access-Control-Expose-Headers", "Content-Range, Accept-Ranges, Content-Length, ETag");
    }
    if (req.method === "OPTIONS") {
      res.status(204).end();
      return;
    }
    next();
  };
}
