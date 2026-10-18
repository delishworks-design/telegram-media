import { createServer } from "node:http";
import { loadEnvFile } from "./util/env.js";
import { assertProductionConfig, loadConfig } from "./config.js";
import { openDatabase, closeDatabase } from "./db/index.js";
import { createLogger } from "./util/logger.js";
import { purgeExpiredSessions } from "./auth/sessions.js";
import { TelegramService } from "./telegram/service.js";
import { MediaRepository } from "./media/repository.js";
import { UploadManager } from "./media/upload-manager.js";
import { RoomManager } from "./realtime/rooms.js";
import { attachRealtime } from "./realtime/server.js";
import { createApp } from "./app.js";

async function main(): Promise<void> {
  loadEnvFile();
  const config = loadConfig();
  assertProductionConfig(config);

  const logger = createLogger(config.logLevel);
  const db = openDatabase(config.databasePath);

  const telegram = new TelegramService(config, db, logger.child({ component: "telegram" }));
  telegram.seedFromEnv();

  const repo = new MediaRepository(db);
  const uploads = new UploadManager({
    config,
    db,
    store: telegram,
    repo,
    logger: logger.child({ component: "uploads" }),
  });
  await uploads.start();

  const rooms = new RoomManager();
  const app = createApp({
    config,
    db,
    logger,
    store: telegram,
    telegram,
    repo,
    uploads,
    rooms,
  });

  const server = createServer(app);
  const realtime = attachRealtime(server, {
    db,
    logger: logger.child({ component: "realtime" }),
    rooms,
  });

  const purge = setInterval(() => {
    try {
      const n = purgeExpiredSessions(db);
      if (n) logger.debug("purged expired sessions", { count: n });
    } catch (err) {
      logger.warn("session purge failed", { error: (err as Error).message });
    }
  }, 60 * 60 * 1000);
  purge.unref?.();

  server.listen(config.port, config.host, () => {
    logger.info("telegram-media listening", { host: config.host, port: config.port });
  });

  const shutdown = (signal: string) => {
    logger.info("shutting down", { signal });
    realtime.close();
    void uploads.close().then(() => {
      server.close(() => {
        closeDatabase(db);
        process.exit(0);
      });
    });
    setTimeout(() => process.exit(0), 5000).unref?.();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err) => {
  process.stderr.write(`${(err as Error)?.stack ?? String(err)}\n`);
  process.exit(1);
});
