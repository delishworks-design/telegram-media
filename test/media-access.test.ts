import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { buildTestContext, seedMedia, type TestContext } from "./helpers.js";

let ctx: TestContext;
before(async () => {
  ctx = await buildTestContext();
  await ctx.client.login();
});
after(async () => {
  await ctx.close();
});

describe("media library access control and CRUD", () => {
  test("media endpoints require authentication", async () => {
    assert.equal((await fetch(`${ctx.baseUrl}/api/media`)).status, 401);
    assert.equal((await fetch(`${ctx.baseUrl}/api/telegram/status`)).status, 401);
    assert.equal((await fetch(`${ctx.baseUrl}/api/auth/sessions`)).status, 401);
  });

  test("listing, search and category filter", async () => {
    await seedMedia(ctx, "holiday.mp4", "video/mp4", Buffer.from("aaaa"));
    await seedMedia(ctx, "song.mp3", "audio/mpeg", Buffer.from("bbbb"));
    await seedMedia(ctx, "poster.png", "image/png", Buffer.from("cccc"));

    const all = await ctx.client.json<{ total: number }>("/api/media");
    assert.ok(all.body.total >= 3);

    const vids = await ctx.client.json<{ items: Array<{ category: string }> }>("/api/media?category=video");
    assert.ok(vids.body.items.every((m) => m.category === "video"));

    const search = await ctx.client.json<{ items: Array<{ name: string }> }>("/api/media?q=holiday");
    assert.equal(search.body.items.length, 1);
    assert.equal(search.body.items[0]!.name, "holiday.mp4");
  });

  test("rename updates the display name", async () => {
    const { id } = await seedMedia(ctx, "old-name.bin", "application/octet-stream", Buffer.from("x"));
    const res = await ctx.client.json<{ item: { name: string } }>(`/api/media/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "new-name.bin" }),
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.item.name, "new-name.bin");
  });

  test("rename rejects an empty name", async () => {
    const { id } = await seedMedia(ctx, "keep.bin", "application/octet-stream", Buffer.from("x"));
    const res = await ctx.client.json(`/api/media/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "   " }),
    });
    assert.equal(res.status, 400);
  });

  test("delete with telegram=false keeps the Telegram file", async () => {
    const { id, stored } = await seedMedia(ctx, "keep-in-tg.bin", "application/octet-stream", Buffer.from("x"));
    const res = await ctx.client.json<{ telegramDeleted: boolean }>(`/api/media/${id}?telegram=false`, {
      method: "DELETE",
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.telegramDeleted, false);
    assert.ok(ctx.store.files.has(stored.messageId), "file should remain in storage");
    assert.equal((await ctx.client.json(`/api/media/${id}`)).status, 404);
  });

  test("delete with telegram=true removes the Telegram file and explains it", async () => {
    const { id, stored } = await seedMedia(ctx, "delete-in-tg.bin", "application/octet-stream", Buffer.from("x"));
    const res = await ctx.client.json<{ telegramDeleted: boolean; explanation: string; deleted: boolean }>(
      `/api/media/${id}`,
      { method: "DELETE" },
    );
    assert.equal(res.status, 200);
    assert.equal(res.body.deleted, true);
    assert.equal(res.body.telegramDeleted, true);
    assert.ok(res.body.explanation.length > 10, "delete explanation should be present");
    assert.equal(ctx.store.files.has(stored.messageId), false, "file should be gone from storage");
  });

  test("renaming or deleting an unknown id returns 404", async () => {
    assert.equal((await ctx.client.json("/api/media/nope", { method: "DELETE" })).status, 404);
    assert.equal(
      (
        await ctx.client.json("/api/media/nope", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: "x" }),
        })
      ).status,
      404,
    );
  });
});
