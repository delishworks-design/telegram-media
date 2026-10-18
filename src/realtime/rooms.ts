import { randomBytes } from "node:crypto";

export interface Member {
  id: string;
  username: string;
  joinedAt: number;
}

export interface PlaybackState {
  mediaId: string | null;
  isPlaying: boolean;
  /** Seconds into the media at `updatedAt`. */
  position: number;
  /** Server clock (ms) when `position` was true. */
  updatedAt: number;
  /** Monotonic per-room counter so clients can drop stale updates. */
  seq: number;
}

export interface RoomSnapshot {
  id: string;
  createdAt: number;
  members: Member[];
  playback: PlaybackState;
}

export interface PlaybackPatch {
  mediaId?: string | null;
  isPlaying?: boolean;
  position?: number;
}

interface Room {
  id: string;
  createdAt: number;
  closedAt: number | null;
  members: Map<string, Member>;
  playback: PlaybackState;
}

const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

function makeCode(length = 6): string {
  const bytes = randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i++) out += CODE_ALPHABET[bytes[i]! % CODE_ALPHABET.length];
  return out;
}

function freshPlayback(): PlaybackState {
  return { mediaId: null, isPlaying: false, position: 0, updatedAt: Date.now(), seq: 0 };
}

export class RoomManager {
  private readonly rooms = new Map<string, Room>();

  constructor(private readonly emptyGraceMs = 5 * 60 * 1000) {}

  create(id?: string): RoomSnapshot {
    let code = (id ?? "").trim().toUpperCase();
    if (!code) {
      do {
        code = makeCode();
      } while (this.rooms.has(code));
    }
    const room: Room = {
      id: code,
      createdAt: Date.now(),
      closedAt: null,
      members: new Map(),
      playback: freshPlayback(),
    };
    this.rooms.set(code, room);
    return this.snapshot(room);
  }

  get(id: string): RoomSnapshot | null {
    const room = this.rooms.get(id.toUpperCase());
    return room ? this.snapshot(room) : null;
  }

  list(): RoomSnapshot[] {
    return [...this.rooms.values()].map((r) => this.snapshot(r));
  }

  join(roomId: string, member: Member): RoomSnapshot | null {
    const room = this.rooms.get(roomId.toUpperCase());
    if (!room) return null;
    room.closedAt = null;
    room.members.set(member.id, member);
    return this.snapshot(room);
  }

  leave(roomId: string, memberId: string): { room: RoomSnapshot; left: Member } | null {
    const room = this.rooms.get(roomId.toUpperCase());
    if (!room) return null;
    const left = room.members.get(memberId);
    if (!left) return null;
    room.members.delete(memberId);
    if (room.members.size === 0) room.closedAt = Date.now();
    return { room: this.snapshot(room), left };
  }

  setMedia(roomId: string, mediaId: string | null): PlaybackState | null {
    const room = this.rooms.get(roomId.toUpperCase());
    if (!room) return null;
    room.playback = {
      mediaId,
      isPlaying: false,
      position: 0,
      updatedAt: Date.now(),
      seq: room.playback.seq + 1,
    };
    return room.playback;
  }

  updatePlayback(roomId: string, patch: PlaybackPatch): PlaybackState | null {
    const room = this.rooms.get(roomId.toUpperCase());
    if (!room) return null;
    const next = { ...room.playback };
    if (patch.mediaId !== undefined) next.mediaId = patch.mediaId;
    if (patch.isPlaying !== undefined) next.isPlaying = patch.isPlaying;
    if (patch.position !== undefined && Number.isFinite(patch.position)) {
      next.position = Math.max(0, patch.position);
    }
    next.updatedAt = Date.now();
    next.seq = room.playback.seq + 1;
    room.playback = next;
    return next;
  }

  /** Removes rooms that have been empty past the grace period. Returns removed ids. */
  sweep(now = Date.now()): string[] {
    const removed: string[] = [];
    for (const [id, room] of this.rooms) {
      if (room.members.size === 0 && room.closedAt !== null && now - room.closedAt > this.emptyGraceMs) {
        this.rooms.delete(id);
        removed.push(id);
      }
    }
    return removed;
  }

  private snapshot(room: Room): RoomSnapshot {
    return {
      id: room.id,
      createdAt: room.createdAt,
      members: [...room.members.values()],
      playback: room.playback,
    };
  }
}

/** Current playback position for a client at wall-clock time `now`. */
export function currentPosition(state: PlaybackState, now = Date.now()): number {
  if (!state.isPlaying) return state.position;
  return state.position + Math.max(0, now - state.updatedAt) / 1000;
}
