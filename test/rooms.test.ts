import test from "node:test";
import assert from "node:assert/strict";
import { currentPosition, RoomManager } from "../src/realtime/rooms.js";

test("create returns an empty room with default playback state", () => {
  const rooms = new RoomManager();
  const room = rooms.create();
  assert.match(room.id, /^[A-Z2-9]{6}$/);
  assert.equal(room.members.length, 0);
  assert.deepEqual(
    { mediaId: room.playback.mediaId, isPlaying: room.playback.isPlaying, position: room.playback.position },
    { mediaId: null, isPlaying: false, position: 0 },
  );
});

test("create honours a requested code and uppercases it", () => {
  const rooms = new RoomManager();
  assert.equal(rooms.create("movie").id, "MOVIE");
  assert.equal(rooms.get("movie")?.id, "MOVIE");
});

test("join on an unknown room returns null", () => {
  const rooms = new RoomManager();
  assert.equal(rooms.join("NOPE", { id: "a", username: "u", joinedAt: Date.now() }), null);
});

test("join and leave track membership and close empty rooms", () => {
  const rooms = new RoomManager();
  rooms.create("R1");
  rooms.join("R1", { id: "a", username: "alice", joinedAt: 1 });
  rooms.join("R1", { id: "b", username: "bob", joinedAt: 2 });
  assert.equal(rooms.get("R1")?.members.length, 2);

  rooms.leave("R1", "a");
  assert.equal(rooms.get("R1")?.members.length, 1);
  assert.deepEqual(rooms.sweep(), [], "keep room while it still has members");

  rooms.leave("R1", "b");
  assert.equal(rooms.get("R1")?.members.length, 0);
  assert.deepEqual(rooms.sweep(), [], "room kept during grace period");
  assert.deepEqual(rooms.sweep(Date.now() + 10 * 60 * 1000), ["R1"]);
  assert.equal(rooms.get("R1"), null);
});

test("setMedia resets playback and bumps the sequence", () => {
  const rooms = new RoomManager();
  rooms.create("R");
  rooms.updatePlayback("R", { isPlaying: true, position: 42 });
  const after = rooms.setMedia("R", "media-7");
  assert.equal(after?.mediaId, "media-7");
  assert.equal(after?.isPlaying, false);
  assert.equal(after?.position, 0);
  assert.equal(after?.seq, 2);
});

test("updatePlayback clamps position and advances seq", () => {
  const rooms = new RoomManager();
  rooms.create("R");
  const first = rooms.updatePlayback("R", { position: -10, isPlaying: true });
  assert.equal(first?.position, 0);
  const second = rooms.updatePlayback("R", { position: 12.5 });
  assert.equal(second?.position, 12.5);
  assert.equal(second?.seq, 2);
});

test("currentPosition advances only while playing", () => {
  assert.equal(currentPosition({ mediaId: null, isPlaying: false, position: 10, updatedAt: 1000, seq: 1 }, 9000), 10);
  assert.equal(currentPosition({ mediaId: null, isPlaying: true, position: 10, updatedAt: 1000, seq: 1 }, 4000), 13);
});
