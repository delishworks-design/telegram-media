import type { IncomingMessage, Server as HttpServer } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { randomToken } from "../util/crypto.js";
import { SESSION_COOKIE, verifySession, type AuthenticatedSession } from "../auth/sessions.js";
import type { Database } from "../db/index.js";
import type { Logger } from "../util/logger.js";
import { currentPosition, RoomManager } from "./rooms.js";
import { decode, encode, type ServerMessage } from "./protocol.js";

export interface RealtimeDeps {
  db: Database;
  logger: Logger;
  rooms: RoomManager;
}

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0) out[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
  }
  return out;
}

export function attachRealtime(server: HttpServer, deps: RealtimeDeps): { close(): void } {
  const { db, logger, rooms } = deps;
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });

  const sockets = new Map<string, WebSocket>();
  const meta = new Map<WebSocket, { memberId: string; roomId: string | null; username: string }>();

  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== "/ws") {
      socket.destroy();
      return;
    }
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    const session = verifySession(db, token);
    if (!session) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      handleConnection(ws, req, session, url);
    });
  });

  function handleConnection(ws: WebSocket, _req: IncomingMessage, session: AuthenticatedSession, url: URL): void {
    const memberId = randomToken(8);
    sockets.set(memberId, ws);
    meta.set(ws, { memberId, roomId: null, username: session.username });

    const send = (message: ServerMessage) => {
      if (ws.readyState === ws.OPEN) ws.send(encode(message));
    };

    const broadcast = (roomId: string, message: ServerMessage, except?: string) => {
      const room = rooms.get(roomId);
      if (!room) return;
      const text = encode(message);
      for (const member of room.members) {
        if (member.id === except) continue;
        const peer = sockets.get(member.id);
        if (peer && peer.readyState === peer.OPEN) peer.send(text);
      }
    };

    const joinRoom = (rawRoom: string) => {
      const code = rawRoom.trim().toUpperCase();
      if (!code) return;
      if (!rooms.get(code)) rooms.create(code);
      const snapshot = rooms.join(code, { id: memberId, username: session.username, joinedAt: Date.now() });
      if (!snapshot) return;
      const record = meta.get(ws)!;
      record.roomId = code;
      send({
        type: "welcome",
        selfId: memberId,
        room: code,
        members: snapshot.members,
        playback: snapshot.playback,
        serverTime: Date.now(),
      });
      broadcast(code, {
        type: "peer:join",
        member: { id: memberId, username: session.username, joinedAt: Date.now() },
      }, memberId);
      logger.info("realtime join", { room: code });
    };

    const leaveRoom = () => {
      const record = meta.get(ws);
      if (!record?.roomId) return;
      const result = rooms.leave(record.roomId, memberId);
      if (result) broadcast(result.room.id, { type: "peer:leave", memberId });
      record.roomId = null;
    };

    ws.on("message", (data) => {
      const message = decode(data.toString());
      if (!message) return;
      const record = meta.get(ws)!;

      switch (message.type) {
        case "join":
          joinRoom(message.room);
          break;
        case "leave":
          leaveRoom();
          break;
        case "media": {
          if (!record.roomId) return;
          const playback = rooms.setMedia(record.roomId, message.mediaId);
          if (playback) broadcast(record.roomId, { type: "media", mediaId: message.mediaId, playback, by: memberId });
          break;
        }
        case "playback": {
          if (!record.roomId) return;
          const room = rooms.get(record.roomId);
          if (!room) return;
          const patch: { isPlaying?: boolean; position?: number } = {};
          if (typeof message.isPlaying === "boolean") patch.isPlaying = message.isPlaying;
          if (typeof message.position === "number") patch.position = message.position;
          else patch.position = currentPosition(room.playback);
          const playback = rooms.updatePlayback(record.roomId, patch);
          if (playback) broadcast(record.roomId, { type: "playback", playback, by: memberId });
          break;
        }
        case "signal": {
          const target = sockets.get(message.to);
          if (target && target.readyState === target.OPEN) {
            target.send(encode({ type: "signal", from: memberId, data: message.data }));
          }
          break;
        }
        case "ping":
          send({ type: "pong" });
          break;
        default:
          break;
      }
    });

    ws.on("close", () => {
      leaveRoom();
      sockets.delete(memberId);
      meta.delete(ws);
    });

    ws.on("error", (err) => {
      logger.warn("realtime socket error", { error: (err as Error).message });
    });

    // Auto-join when the page passes ?room=CODE.
    const roomParam = url.searchParams.get("room");
    if (roomParam) joinRoom(roomParam);
  }

  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.readyState === ws.OPEN) ws.ping();
    }
    rooms.sweep();
  }, 30_000);
  heartbeat.unref?.();

  return {
    close: () => {
      clearInterval(heartbeat);
      for (const ws of wss.clients) ws.terminate();
      wss.close();
    },
  };
}
