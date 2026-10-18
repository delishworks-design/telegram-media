import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { buildTestContext, waitFor, type TestContext } from "./helpers.js";

let ctx: TestContext;
before(async () => {
  ctx = await buildTestContext();
  await ctx.client.login();
});
after(async () => {
  await ctx.close();
});

async function createUpload(name: string, size: number, mime = "video/mp4") {
  const res = await ctx.client.json<{ id: string; chunkSize: number; expectedChunks: number }>("/api/uploads", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, size, mime }),
  });
  assert.equal(res.status, 201);
  return res.body;
}

async function putChunk(id: string, index: number, data: Buffer) {
  return ctx.client.json(`/api/uploads/${id}/chunk/${index}`, {
    method: "PUT",
    headers: { "content-type": "application/octet-stream" },
    body: data,
  });
}

describe("chunked uploads", () => {
  test("upload completes and creates a media row", async () => {
    const size = 1000;
    const created = await createUpload("clip.mp4", size);
    const data = Buffer.alloc(size, 0xab);
    // one chunk (chunkSize is 8 MiB)
    const chunk = await putChunk(created.id, 0, data);
    assert.equal(chunk.status, 200);
    const queued = (chunk.body as { upload: { status: string } }).upload.status;
    assert.ok(["pending", "processing", "done"].includes(queued), `unexpected status ${queued}`);

    const done = await ctx.client.json(`/api/uploads/${created.id}/complete`, { method: "POST" });
    assert.equal(done.status, 200);

    const media = await waitFor(async () => {
      const list = await ctx.client.json<{ items: Array<{ name: string; size: number; id: string }> }>(
        "/api/media",
      );
      return list.body.items.find((m) => m.name === "clip.mp4") ?? null;
    });
    assert.equal(media.size, size);

    const status = await ctx.client.json<{ upload: { status: string; mediaId: string } }>(
      `/api/uploads/${created.id}`,
    );
    assert.equal(status.body.upload.status, "done");
    assert.ok(status.body.upload.mediaId);
  });

  test("rejects a chunk index out of range", async () => {
    const created = await createUpload("small.bin", 100, "application/octet-stream");
    const res = await putChunk(created.id, 5, Buffer.alloc(10));
    assert.equal(res.status, 416);
  });

  test("finalize rejects an incomplete upload", async () => {
    const created = await createUpload("partial.bin", 100, "application/octet-stream");
    // Send fewer bytes than declared by sending a short chunk.
    await putChunk(created.id, 0, Buffer.alloc(40));
    const res = await ctx.client.json(`/api/uploads/${created.id}/complete`, { method: "POST" });
    assert.equal(res.status, 400);
  });

  test("supports out-of-order chunks", async () => {
    const chunkSize = ctx.config.chunkSizeBytes;
    const size = chunkSize + 500;
    const created = await createUpload("big.bin", size, "application/octet-stream");
    const first = Buffer.alloc(chunkSize, 1);
    const second = Buffer.alloc(500, 2);
    // second chunk first
    await putChunk(created.id, 1, second);
    const state = await putChunk(created.id, 0, first);
    const status = (state.body as { upload: { status: string; received: number } }).upload.status;
    assert.ok(["pending", "processing", "done"].includes(status), `unexpected status ${status}`);
    assert.equal((state.body as { upload: { received: number } }).upload.received, size);
  });

  test("cancelling removes the upload", async () => {
    const created = await createUpload("cancelme.bin", 100, "application/octet-stream");
    const res = await ctx.client.json<{ upload: { status: string } }>(`/api/uploads/${created.id}`, {
      method: "DELETE",
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.upload.status, "cancelled");
  });

  test("rejects an upload larger than the configured limit", async () => {
    const res = await ctx.client.json("/api/uploads", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "huge.bin", size: ctx.config.maxUploadBytes + 1, mime: "application/octet-stream" }),
    });
    assert.equal(res.status, 413);
  });

  test("uploads endpoint requires authentication", async () => {
    const res = await fetch(`${ctx.baseUrl}/api/uploads`);
    assert.equal(res.status, 401);
  });
});
