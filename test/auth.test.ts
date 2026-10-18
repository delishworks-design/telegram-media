import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { buildTestContext, TEST_PASSWORD, type TestContext } from "./helpers.js";

let ctx: TestContext;
before(async () => {
  ctx = await buildTestContext();
});
after(async () => {
  await ctx.close();
});

describe("authentication", () => {
  test("rejects missing credentials", async () => {
    const res = await ctx.client.json("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "owner", password: "wrong" }),
    });
    assert.equal(res.status, 401);
  });

  test("rejects unknown user", async () => {
    const res = await ctx.client.json("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "nobody", password: TEST_PASSWORD }),
    });
    assert.equal(res.status, 401);
  });

  test("accepts valid credentials and sets an httpOnly cookie", async () => {
    const res = await ctx.client.request("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "owner", password: TEST_PASSWORD }),
    });
    assert.equal(res.status, 200);
    const setCookie = res.headers.getSetCookie().join(";");
    assert.match(setCookie, /HttpOnly/i);
    assert.match(setCookie, /SameSite=Strict/i);
  });

  test("unauthenticated request is rejected", async () => {
    const res = await fetch(`${ctx.baseUrl}/api/media`);
    assert.equal(res.status, 401);
  });

  test("me returns the signed-in user", async () => {
    const res = await ctx.client.json<{ user: { username: string } }>("/api/auth/me");
    assert.equal(res.status, 200);
    assert.equal(res.body.user.username, "owner");
  });

  test("logout revokes the session", async () => {
    const out = await ctx.client.json("/api/auth/logout", { method: "POST" });
    assert.equal(out.status, 200);
    const after = await ctx.client.json("/api/auth/me");
    assert.equal(after.status, 401);
    await ctx.client.login();
  });

  test("logout-all revokes every session", async () => {
    await ctx.client.login();
    const res = await ctx.client.json("/api/auth/logout-all", { method: "POST" });
    assert.equal(res.status, 200);
    const after = await ctx.client.json("/api/auth/me");
    assert.equal(after.status, 401);
    await ctx.client.login();
  });
});
