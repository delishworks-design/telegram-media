import { signToken, verifyToken } from "../util/crypto.js";

export interface PlaybackGrant {
  mediaId: string;
  /** Optional room identifier when used inside Watch Together. */
  room?: string;
  sub?: string;
}

export function issuePlaybackToken(
  secret: Buffer,
  grant: PlaybackGrant,
  ttlSeconds: number,
): string {
  return signToken(secret, { scope: "playback", ...grant }, ttlSeconds);
}

export function verifyPlaybackToken(secret: Buffer, token: string | undefined): PlaybackGrant | null {
  const payload = verifyToken<{ scope: string; mediaId: string; room?: string; sub?: string }>(secret, token);
  if (!payload || payload.scope !== "playback" || typeof payload.mediaId !== "string") return null;
  return { mediaId: payload.mediaId, room: payload.room, sub: payload.sub };
}
