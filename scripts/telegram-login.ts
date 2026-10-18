import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { loadEnvFile } from "../src/util/env.js";
import { loadConfig } from "../src/config.js";
import { openDatabase, closeDatabase } from "../src/db/index.js";
import { createLogger } from "../src/util/logger.js";
import { TelegramService } from "../src/telegram/service.js";

// One-time interactive MTProto login. Writes the encrypted session to the
// database, then exits. Never prints the session/secret material.
async function main(): Promise<void> {
  loadEnvFile();
  const config = loadConfig();
  if (config.masterKey.equals(Buffer.alloc(32))) {
    throw new Error("MASTER_KEY must be set before logging in (it encrypts the session at rest)");
  }
  const db = await openDatabase(config.databasePath);
  const service = new TelegramService(config, db, createLogger("info").child({ component: "cli" }));
  await service.seedFromEnv();

  const rl = createInterface({ input: stdin, output: stdout });
  try {
    const phone = (await rl.question("Telegram phone (+1555…): ")).trim();
    const { loginId } = await service.startLogin({
      phone,
      apiId: config.telegram.apiId,
      apiHash: config.telegram.apiHash,
    });
    const code = (await rl.question("Login code: ")).trim();
    let step = (await service.submitCode(loginId, code)).step;
    if (step === "awaiting_password") {
      const password = await rl.question("Two-step (2FA) password: ");
      step = (await service.submitPassword(loginId, password)).step;
    }
    if (step !== "ok") throw new Error(`login did not complete (step=${step})`);

    const channel = (await rl.question("Channel @username or id (blank = create private channel): ")).trim();
    const resolved = await service.setChannel(channel || undefined);
    stdout.write(`\nSigned in. Storage channel: ${resolved.title ?? "(untitled)"} [${resolved.id}]\n`);
  } finally {
    rl.close();
    await closeDatabase(db);
  }
}

main().catch((err) => {
  process.stderr.write(`${(err as Error)?.message ?? String(err)}\n`);
  process.exit(1);
});
