import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { hashPassword } from "../src/util/crypto.js";

async function main(): Promise<void> {
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    const user = await rl.question("username (for reference only): ");
    const pass = await rl.question("password (input is visible): ");
    if (!pass.trim()) throw new Error("password cannot be empty");
    const hash = hashPassword(pass);
    stdout.write(
      `\nAdd this to AUTH_USERS (JSON escapes handled):\n` +
        JSON.stringify({ username: user.trim() || "user", passwordHash: hash }) +
        "\n",
    );
  } finally {
    rl.close();
  }
}

main().catch((err) => {
  process.stderr.write(`${(err as Error).message}\n`);
  process.exit(1);
});
