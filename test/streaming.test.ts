import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { parseRange } from "../src/media/streaming.js";
import { buildTestContext, seedMedia, type TestContext } from "./helpers.js";

let ctx: TestContext;
const CONTENT = Buffer.from("0123456789abcdefghijklmnopqrstuvwxyz-END");
let mediaId = "";

before(async () => {
  ctx = await buildTestContext();
  await ctx.client.login();
  mediaId = seedMedia(ctx, "movie.mp4", "video/mp4", CONTENT).id;
});
after(async () => {
  await ctx.close();
});

describe("parseRange", () => {
  test("absent header means full body", () => {
    assert.equal(parseRange(undefined, 100), null);
  });
  test("start-end", () => {
    assert.deepEqual(parseRange("bytes=0-9", 100), { start: 0, end: 9 });
  });
  test("open-ended", () => {
    assert.deepEqual(parseRange("bytes=90-", 100), { start: 90, end: 99 });
  });
  test("suffix", () => {
    assert.deepEqual(parseRange("bytes=-10", 100), { start: 90, end: 99 });
  });
  test("clamps end beyond size", () => {
    assert.deepEqual(parseRange("bytes=0-999", 100), { start: 0, end: 99 });
  });
  test("out of bounds is unsatisfiable", () => {
    assert.equal(parseRange("bytes=200-300", 100), "unsatisfiable");
  });
  test("reversed range is unsatisfiable", () => {
    assert.equal(parseRange("bytes=50-10", 100), "unsatisfiable");
  });
});

describe("HTTP range streaming", () => {
  test("full request returns 200 with the whole body", async () => {
    const res = await ctx.client.request(`/api/media/${mediaId}/stream`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("accept-ranges"), "bytes");
    assert.equal(res.headers.get("content-length"), String(CONTENT.length));
    const body = Buffer.from(await res.arrayBuffer());
    assert.deepEqual(body, CONTENT);
  });

  test("range request returns 206 with Content-Range", async () => {
    const res = await ctx.client.request(`/api/media/${mediaId}/stream`, { headers: { range: "bytes=10-19" } });
    assert.equal(res.status, 206);
    assert.equal(res.headers.get("content-range"), `bytes 10-19/${CONTENT.length}`);
    assert.equal(res.headers.get("content-length"), "10");
    const body = Buffer.from(await res.arrayBuffer());
    assert.deepEqual(body, CONTENT.subarray(10, 20));
  });

  test("suffix range returns the tail", async () => {
    const res = await ctx.client.request(`/api/media/${mediaId}/stream`, { headers: { range: "bytes=-4" } });
    assert.equal(res.status, 206);
    const body = Buffer.from(await res.arrayBuffer());
    assert.deepEqual(body, CONTENT.subarray(CONTENT.length - 4));
  });

  test("unsatisfiable range returns 416", async () => {
    const res = await ctx.client.request(`/api/media/${mediaId}/stream`, { headers: { range: "bytes=9999-" } });
    assert.equal(res.status, 416);
    assert.equal(res.headers.get("content-range"), `bytes */${CONTENT.length}`);
  });

  test("HEAD returns headers with no body", async () => {
    const res = await ctx.client.request(`/api/media/${mediaId}/stream`, { method: "HEAD" });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-length"), String(CONTENT.length));
    const body = Buffer.from(await res.arrayBuffer());
    assert.equal(body.length, 0);
  });

  test("matching ETag short-circuits with 304", async () => {
    const first = await ctx.client.request(`/api/media/${mediaId}/stream`, { method: "HEAD" });
    const etag = first.headers.get("etag");
    assert.ok(etag);
    const res = await ctx.client.request(`/api/media/${mediaId}/stream`, { headers: { "if-none-match": etag } });
    assert.equal(res.status, 304);
  });

  test("stream requires authentication without a token", async () => {
    const res = await fetch(`${ctx.baseUrl}/api/media/${mediaId}/stream`);
    assert.equal(res.status, 401);
  });
});

describe("signed playback tokens (Watch Together integration)", () => {
  test("token grants range access without a cookie", async () => {
    const tokenRes = await ctx.client.json<{ token: string; url: string }>(
      `/api/media/${mediaId}/playback-token`,
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ room: "room-42" }) },
    );
    assert.equal(tokenRes.status, 200);
    const url = tokenRes.body.url.replace("http://localhost", "");
    // No cookie on this request — the token alone authorizes it.
    const res = await fetch(`${ctx.baseUrl}${url}`, { headers: { range: "bytes=0-3" } });
    assert.equal(res.status, 206);
    const body = Buffer.from(await res.arrayBuffer());
    assert.deepEqual(body, CONTENT.subarray(0, 4));
  });

  test("a token for one file cannot stream another", async () => {
    const other = seedMedia(ctx, "other.mp4", "video/mp4", Buffer.from("other-file-bytes")).id;
    const tokenRes = await ctx.client.json<{ token: string }>(`/api/media/${mediaId}/playback-token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    const res = await fetch(`${ctx.baseUrl}/api/media/${other}/stream?token=${tokenRes.body.token}`);
    assert.equal(res.status, 401);
  });

  test("issues an absolute URL when PUBLIC_BASE_URL is set", async () => {
    const tokenRes = await ctx.client.json<{ url: string }>(`/api/media/${mediaId}/playback-token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.match(tokenRes.body.url, /^http:\/\/localhost\/api\/media\//);
  });
});
