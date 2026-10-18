import test from "node:test";
import assert from "node:assert/strict";
import WebSocket from "ws";
import { buildTestContext, seedMedia, TestClient, waitFor, type TestContext } from "./helpers.js";

interface ServerMsg {
  type: string;
  [key: string]: unknown;
}

interface Peer {
  ws: WebSocket;
  messages: ServerMsg[];
  send: (msg: unknown) => void;
  expect: (type: string, pred?: (m: ServerMsg) => boolean) => Promise<ServerMsg>;
  close: () => void;
}

function connect(ctx: TestContext, cookie: string): Promise<Peer> {
  const url = `${ctx.baseUrl.replace(/^http/, "ws")}/ws`;
  const ws = new WebSocket(url, { headers: { cookie } });
  const messages: ServerMsg[] = [];
  ws.on("message", (data) => messages.push(JSON.parse(data.toString()) as ServerMsg));
  const peer: Peer = {
    ws,
    messages,
    send: (msg) => ws.send(JSON.stringify(msg)),
    expect: (type, pred) =>
      waitFor(async () => messages.find((m) => m.type === type && (!pred || pred(m))) ?? null),
    close: () => ws.close(),
  };
  return new Promise((resolve, reject) => {
    ws.once("open", () => resolve(peer));
    ws.once("error", reject);
  });
}

async function loggedInContext(): Promise<TestContext> {
  const ctx = await buildTestContext();
  await ctx.client.login();
  return ctx;
}

function cookieOf(client: TestClient): string {
  return `tm_session=${client.cookies.get("tm_session")}`;
}

test("websocket upgrade without a session is rejected", async () => {
  const ctx = await buildTestContext();
  const url = `${ctx.baseUrl.replace(/^http/, "ws")}/ws`;
  const ws = new WebSocket(url, { headers: { cookie: "tm_session=garbage" } });
  const failed = await new Promise<boolean>((resolve) => {
    ws.on("error", () => resolve(true));
    ws.on("open", () => resolve(false));
  });
  assert.equal(failed, true);
  ws.terminate();
  await ctx.close();
});

test("joining a room sends a welcome and notifies existing peers", async () => {
  const ctx = await loggedInContext();
  const a = await connect(ctx, cookieOf(ctx.client));
  const b = await connect(ctx, cookieOf(ctx.client));
  a.send({ type: "join", room: "ROOM42" });
  b.send({ type: "join", room: "ROOM42" });

  const welcomeA = await a.expect("welcome");
  assert.equal(welcomeA.room, "ROOM42");
  const welcomeB = await b.expect("welcome");
  const selfB = welcomeB.selfId as string;

  const peerJoin = await a.expect("peer:join", (m) => (m.member as { id: string }).id === selfB);
  assert.equal((peerJoin.member as { username: string }).username, "owner");

  a.close();
  b.close();
  await ctx.close();
});

test("playback and media updates broadcast to the room", async () => {
  const ctx = await loggedInContext();
  const a = await connect(ctx, cookieOf(ctx.client));
  const b = await connect(ctx, cookieOf(ctx.client));
  a.send({ type: "join", room: "SYNC01" });
  b.send({ type: "join", room: "SYNC01" });
  const welcomeB = await b.expect("welcome");
  const selfB = welcomeB.selfId as string;

  const { id: mediaId } = await seedMedia(ctx, "film.mp4", "video/mp4", Buffer.from("hello"));
  a.send({ type: "media", mediaId });
  const mediaMsg = await b.expect("media", (m) => m.mediaId === mediaId);
  assert.equal((mediaMsg.playback as { mediaId: string }).mediaId, mediaId);

  a.send({ type: "playback", isPlaying: true, position: 5 });
  const play = await b.expect("playback", (m) => (m.playback as { isPlaying: boolean }).isPlaying === true);
  assert.equal((play.playback as { position: number }).position, 5);

  b.send({ type: "playback", position: 30, isPlaying: false });
  const seek = await a.expect("playback", (m) => (m.playback as { position: number }).position === 30);
  assert.equal((seek.playback as { isPlaying: boolean }).isPlaying, false);
  assert.equal(seek.by, selfB);

  a.close();
  b.close();
  await ctx.close();
});

test("late joiners receive the current playback state", async () => {
  const ctx = await loggedInContext();
  const a = await connect(ctx, cookieOf(ctx.client));
  a.send({ type: "join", room: "LATE01" });
  await a.expect("welcome");
  a.send({ type: "media", mediaId: "media-late" });
  a.send({ type: "playback", isPlaying: true, position: 90 });

  const c = await connect(ctx, cookieOf(ctx.client));
  c.send({ type: "join", room: "LATE01" });
  const welcome = await c.expect("welcome");
  const playback = welcome.playback as { mediaId: string; isPlaying: boolean; position: number };
  assert.equal(playback.mediaId, "media-late");
  assert.equal(playback.isPlaying, true);
  assert.equal(playback.position, 90);

  a.close();
  c.close();
  await ctx.close();
});

test("signalling messages are relayed only to the target peer", async () => {
  const ctx = await loggedInContext();
  const a = await connect(ctx, cookieOf(ctx.client));
  const b = await connect(ctx, cookieOf(ctx.client));
  a.send({ type: "join", room: "CALL01" });
  const welcomeA = await a.expect("welcome");
  b.send({ type: "join", room: "CALL01" });
  const welcomeB = await b.expect("welcome");
  const selfA = welcomeA.selfId as string;
  const selfB = welcomeB.selfId as string;

  a.send({ type: "signal", to: selfB, data: { sdp: "offer" } });
  const relayed = await b.expect("signal", (m) => m.from === selfA);
  assert.deepEqual(relayed.data, { sdp: "offer" });

  a.close();
  b.close();
  await ctx.close();
});

test("rooms REST API creates, reads and lists rooms", async () => {
  const ctx = await loggedInContext();
  const { id } = await seedMedia(ctx, "clip.mp4", "video/mp4", Buffer.from("x"));
  const created = await ctx.client.json<{ id: string; room: { playback: { mediaId: string } } }>("/api/rooms", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mediaId: id }),
  });
  assert.equal(created.status, 201);
  assert.match(created.body.id, /^[A-Z2-9]{6}$/);
  assert.equal(created.body.room.playback.mediaId, id);

  const fetched = await ctx.client.json<{ room: { id: string } }>(`/api/rooms/${created.body.id}`);
  assert.equal(fetched.status, 200);
  assert.equal(fetched.body.room.id, created.body.id);

  const listed = await ctx.client.json<{ rooms: unknown[] }>("/api/rooms");
  assert.equal(listed.body.rooms.length, 1);

  const missing = await ctx.client.json("/api/rooms/NOPE99");
  assert.equal(missing.status, 404);

  await ctx.close();
});
