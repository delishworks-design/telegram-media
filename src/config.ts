import { resolve } from "node:path";

export interface AuthUser {
  username: string;
  passwordHash: string;
}

export interface AppConfig {
  port: number;
  host: string;
  publicBaseUrl: string;
  cookieSecure: boolean;
  corsOrigins: string[];
  trustProxy: number | false;
  logLevel: "error" | "warn" | "info" | "debug";

  masterKey: Buffer;
  playbackSecret: Buffer;

  authUsers: AuthUser[];
  sessionTtlSeconds: number;

  telegram: {
    apiId?: number;
    apiHash?: string;
    phone?: string;
    channel?: string;
    channelTitle: string;
  };

  databasePath: string;
  uploadTmpDir: string;
  maxUploadBytes: number;
  chunkSizeBytes: number;
  uploadConcurrency: number;
  streamChunkBytes: number;
  playbackTokenTtl: number;
}

type Env = Record<string, string | undefined>;

function num(env: Env, key: string, fallback: number): number {
  const raw = env[key];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`env ${key} must be a number, got "${raw}"`);
  return n;
}

function bool(env: Env, key: string, fallback: boolean): boolean {
  const raw = env[key];
  if (raw === undefined || raw === "") return fallback;
  return /^(1|true|yes|on)$/i.test(raw);
}

function decodeKey(env: Env, key: string, required: boolean): Buffer {
  const raw = env[key];
  if (!raw) {
    if (required) throw new Error(`env ${key} is required`);
    return Buffer.alloc(32);
  }
  let buf: Buffer;
  try {
    buf = Buffer.from(raw, "base64");
  } catch {
    throw new Error(`env ${key} must be base64`);
  }
  if (buf.length !== 32) {
    throw new Error(`env ${key} must decode to exactly 32 bytes (got ${buf.length})`);
  }
  return buf;
}

function parseUsers(env: Env): AuthUser[] {
  const raw = env.AUTH_USERS;
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("env AUTH_USERS must be valid JSON");
  }
  if (!Array.isArray(parsed)) throw new Error("env AUTH_USERS must be a JSON array");
  const users: AuthUser[] = [];
  for (const entry of parsed) {
    if (
      entry &&
      typeof entry === "object" &&
      typeof (entry as AuthUser).username === "string" &&
      typeof (entry as AuthUser).passwordHash === "string"
    ) {
      users.push({
        username: (entry as AuthUser).username,
        passwordHash: (entry as AuthUser).passwordHash,
      });
    } else {
      throw new Error("each AUTH_USERS entry needs string username and passwordHash");
    }
  }
  return users;
}

export function loadConfig(env: Env = process.env): AppConfig {
  const publicBaseUrl = (env.PUBLIC_BASE_URL ?? "").replace(/\/+$/, "");
  const corsOrigins = (env.CORS_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const apiIdRaw = env.TELEGRAM_API_ID;

  const config: AppConfig = {
    port: num(env, "PORT", 8787),
    host: env.HOST ?? "0.0.0.0",
    publicBaseUrl,
    cookieSecure: bool(env, "COOKIE_SECURE", publicBaseUrl.startsWith("https://")),
    corsOrigins,
    trustProxy: env.TRUST_PROXY ? num(env, "TRUST_PROXY", 1) : false,
    logLevel: (env.LOG_LEVEL as AppConfig["logLevel"]) ?? "info",

    masterKey: decodeKey(env, "MASTER_KEY", false),
    playbackSecret: decodeKey(env, "PLAYBACK_TOKEN_SECRET", false),

    authUsers: parseUsers(env),
    sessionTtlSeconds: num(env, "SESSION_TTL", 60 * 60 * 24 * 14),

    telegram: {
      apiId: apiIdRaw ? num(env, "TELEGRAM_API_ID", 0) : undefined,
      apiHash: env.TELEGRAM_API_HASH || undefined,
      phone: env.TELEGRAM_PHONE || undefined,
      channel: env.TELEGRAM_CHANNEL || undefined,
      channelTitle: env.TELEGRAM_CHANNEL_TITLE || "Media Vault",
    },

    databasePath: resolve(env.DATABASE_PATH ?? "./data/media.sqlite"),
    uploadTmpDir: resolve(env.UPLOAD_TMP_DIR ?? "./tmp/uploads"),
    maxUploadBytes: num(env, "MAX_UPLOAD_BYTES", 2 * 1024 * 1024 * 1024),
    chunkSizeBytes: num(env, "CHUNK_SIZE_BYTES", 8 * 1024 * 1024),
    uploadConcurrency: Math.max(1, num(env, "UPLOAD_CONCURRENCY", 1)),
    streamChunkBytes: num(env, "STREAM_CHUNK_BYTES", 1024 * 1024),
    playbackTokenTtl: num(env, "PLAYBACK_TOKEN_TTL", 3600),
  };

  return config;
}

// Fails fast with a readable message when a mandatory secret is unset. Called by
// the server entrypoint, not by unit tests (which inject their own config).
export function assertProductionConfig(config: AppConfig): void {
  const problems: string[] = [];
  if (config.masterKey.equals(Buffer.alloc(32))) problems.push("MASTER_KEY is not set");
  if (config.playbackSecret.equals(Buffer.alloc(32))) problems.push("PLAYBACK_TOKEN_SECRET is not set");
  if (config.authUsers.length === 0) problems.push("AUTH_USERS has no users");
  if (config.authUsers.some((u) => !u.passwordHash)) problems.push("AUTH_USERS has a user without passwordHash");
  if (problems.length) {
    throw new Error(`Invalid configuration:\n  - ${problems.join("\n  - ")}`);
  }
}
