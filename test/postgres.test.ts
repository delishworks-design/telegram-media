import { beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { newDb } from "pg-mem";
import type { Pool } from "pg";
import { PgDb, translatePostgres } from "../src/db/index.js";
import { applyMigrations } from "../src/db/migrations.js";
import type { Db } from "../src/db/index.js";

describe("postgres placeholder translation", () => {
  test("rewrites positional ? to $n", () => {
    const { text, values } = translatePostgres("SELECT * FROM media WHERE id = ? AND name = ?", ["a", "b"]);
    assert.equal(text, "SELECT * FROM media WHERE id = $1 AND name = $2");
    assert.deepEqual(values, ["a", "b"]);
  });

  test("rewrites named @x to $n and reuses repeated names", () => {
    const { text, values } = translatePostgres(
      "INSERT INTO t (a, b) VALUES (@a, @b) ON CONFLICT(a) DO UPDATE SET a = @a",
      { a: 1, b: 2 },
    );
    assert.equal(text, "INSERT INTO t (a, b) VALUES ($1, $2) ON CONFLICT(a) DO UPDATE SET a = $1");
    assert.deepEqual(values, [1, 2]);
  });

  test("never touches placeholders inside string literals", () => {
    const { text, values } = translatePostgres(
      "SELECT * FROM media WHERE mime NOT LIKE 'video/%' AND mime NOT LIKE 'a@b?c' AND id = ?",
      ["x"],
    );
    assert.equal(text, "SELECT * FROM media WHERE mime NOT LIKE 'video/%' AND mime NOT LIKE 'a@b?c' AND id = $1");
    assert.deepEqual(values, ["x"]);
  });
});

async function makePg(): Promise<Db> {
  const mem = newDb();
  const { Pool: MemPool } = mem.adapters.createPg();
  const pool = new MemPool() as unknown as Pool;
  const db = new PgDb(pool);
  await applyMigrations(db);
  return db;
}

describe("postgres driver end to end", () => {
  let db: Db;
  beforeEach(async () => {
    db = await makePg();
  });

  test("migration bookkeeping records the applied migration", async () => {
    // pg-mem chokes on a second `CREATE TABLE IF NOT EXISTS`, so we assert the
    // bookkeeping rather than re-running the runner here (real Postgres re-runs
    // are idempotent by the `existing` guard in applyMigrations).
    const rows = await db.all<{ id: number }>("SELECT id FROM _migrations");
    assert.equal(rows.length, 1);
  });

  test("sessions insert / verify round-trip", async () => {
    const { token } = await import("../src/auth/sessions.js").then((m) =>
      m.createSession(db, { username: "owner", ttlSeconds: 3600 }),
    );
    const { verifySession } = await import("../src/auth/sessions.js");
    const session = await verifySession(db, token);
    assert.equal(session?.username, "owner");
    assert.equal(await verifySession(db, "not-a-token"), null);
  });

  test("media insert / list / rename / delete with named params", async () => {
    const { MediaRepository } = await import("../src/media/repository.js");
    const repo = new MediaRepository(db);
    const stored = {
      messageId: 42,
      channelId: "chan",
      size: 1234,
      mime: "video/mp4",
    };
    await repo.insert({ id: "m1", name: "Clip.MP4", stored, createdBy: "owner" });

    const listed = await repo.list({ q: "clip" });
    assert.equal(listed.total, 1);
    assert.equal(listed.items[0]!.name, "Clip.MP4");
    assert.equal(listed.items[0]!.size, 1234);

    const sorted = await repo.list({ sort: "name_asc" });
    assert.equal(sorted.items.length, 1);

    const renamed = await repo.rename("m1", "Renamed.mp4");
    assert.equal(renamed?.name, "Renamed.mp4");
    const afterRename = await repo.get("m1");
    assert.equal(afterRename?.name, "Renamed.mp4");

    assert.equal(await repo.delete("m1"), true);
    assert.equal(await repo.get("m1"), null);
  });

  test("telegram_config upsert (ON CONFLICT DO UPDATE) works", async () => {
    await db.run(
      `INSERT INTO telegram_config (id, api_id, api_hash_enc, phone, channel_id, channel_title, channel_access_hash, updated_at)
       VALUES (1, @api_id, @api_hash_enc, @phone, @channel_id, @channel_title, @channel_access_hash, @updated_at)
       ON CONFLICT(id) DO UPDATE SET
         api_id=@api_id, api_hash_enc=@api_hash_enc, phone=@phone,
         channel_id=@channel_id, channel_title=@channel_title,
         channel_access_hash=@channel_access_hash, updated_at=@updated_at`,
      { api_id: 7, api_hash_enc: "x", phone: "+1", channel_id: null, channel_title: null, channel_access_hash: null, updated_at: 1 },
    );
    await db.run(
      `INSERT INTO telegram_config (id, api_id, api_hash_enc, phone, channel_id, channel_title, channel_access_hash, updated_at)
       VALUES (1, @api_id, @api_hash_enc, @phone, @channel_id, @channel_title, @channel_access_hash, @updated_at)
       ON CONFLICT(id) DO UPDATE SET
         api_id=@api_id, api_hash_enc=@api_hash_enc, phone=@phone,
         channel_id=@channel_id, channel_title=@channel_title,
         channel_access_hash=@channel_access_hash, updated_at=@updated_at`,
      { api_id: 9, api_hash_enc: "y", phone: "+2", channel_id: "c", channel_title: "t", channel_access_hash: "h", updated_at: 2 },
    );
    const row = await db.get<{ api_id: number; channel_title: string }>(
      "SELECT api_id, channel_title FROM telegram_config WHERE id = 1",
    );
    assert.equal(Number(row!.api_id), 9);
    assert.equal(row!.channel_title, "t");
  });
});
