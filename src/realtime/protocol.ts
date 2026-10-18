import type { Member, PlaybackState } from "./rooms.js";

// --- client -> server ---------------------------------------------------------

export type ClientMessage =
  | { type: "join"; room: string; name?: string }
  | { type: "leave" }
  | { type: "media"; mediaId: string | null }
  | { type: "playback"; isPlaying?: boolean; position?: number }
  | { type: "signal"; to: string; data: unknown }
  | { type: "ping" };

// --- server -> client ---------------------------------------------------------

export type ServerMessage =
  | {
      type: "welcome";
      selfId: string;
      room: string;
      members: Member[];
      playback: PlaybackState;
      serverTime: number;
    }
  | { type: "peer:join"; member: Member }
  | { type: "peer:leave"; memberId: string }
  | { type: "media"; mediaId: string | null; playback: PlaybackState; by: string }
  | { type: "playback"; playback: PlaybackState; by: string }
  | { type: "signal"; from: string; data: unknown }
  | { type: "error"; message: string }
  | { type: "pong" };

export function encode(message: ServerMessage): string {
  return JSON.stringify(message);
}

export function decode(raw: string): ClientMessage | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || typeof (value as { type?: unknown }).type !== "string") {
    return null;
  }
  return value as ClientMessage;
}
