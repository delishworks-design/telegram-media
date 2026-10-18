import { promises as fs } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createApp, type AppDeps } from "../src/app.js";
import { loadConfig, type AppConfig } from "../src/config.js";
import { openDatabase, type Db } from "../src/db/index.js";
import { createLogger } from "../src/util/logger.js";
import { hashPassword } from "../src/util/crypto.js";
import { MediaRepository } from "../src/media/repository.js";
import { UploadManager } from "../src/media/upload-manager.js";
import { RoomManager } from "../src/realtime/rooms.js";
import { attachRealtime } from "../src/realtime/server.js";
import type { MediaStore, MessageRef, StoredMedia, UploadInput } from "../src/media/store.js";
import type { LoginStep, TelegramBackend, TelegramStatus } from "../src/telegram/types.js";

export const TEST_PASSWORD = "correct horse battery staple";

// In-memory stand-in for Telegram, so auth/upload/range logic is testable with
// no network and no credentials.
export class FakeStore implements MediaStore {
  readonly kind = "fake";
  private seq = 0;
  readonly files = new Map<number, { data: Buffer; mime: string }>();

  async ready(): Promise<boolean> {
    return true;
  }

  put(data: Buffer, mime = "application/octet-stream"): StoredMedia {
    const messageId = ++this.seq;
    this.files.set(messageId, { data, mime });
    return { messageId, channelId: "fake-channel", size: data.length, mime, fileReference: "ref" };
  }

  async upload(input: UploadInput): Promise<StoredMedia> {
    const data = await fs.readFile(input.path);
    input.onProgress?.(1, data.length);
    return this.put(data, input.mime);
  }

  async *readRange(ref: MessageRef, start: number, end: number): AsyncIterable<Buffer> {
    const file = this.files.get(ref.messageId);
    if (!file) throw new Error("no such message");
    yield file.data.subarray(start, end + 1);
  }

  async delete(ref: MessageRef): Promise<void> {
    this.files.delete(ref.messageId);
  }

  describeDelete(): string {
    return "Fake delete: removes the file from the fake channel.";
  }
}

export class FakeTelegram implements TelegramBackend {
  readonly kind = "fake";
  private authorized = true;
  private channelSet = true;
  constructor(private readonly store: FakeStore) {}
  async ready(): Promise<boolean> {
    return this.authorized && this.channelSet;
  }
  async upload(input: UploadInput): Promise<StoredMedia> {
    return this.store.upload(input);
  }
  readRange(ref: MessageRef, start: number, end: number): AsyncIterable<Buffer> {
    return this.store.readRange(ref, start, end);
  }
  async delete(ref: MessageRef): Promise<void> {
    return this.store.delete(ref);
  }
  describeDelete(): string {
    return this.store.describeDelete();
  }
  async getStatus(): Promise<TelegramStatus> {
    return {
      configured: true,
      authorized: this.authorized,
      channel: { set: this.channelSet, id: "fake-channel", title: "Fake Vault" },
      account: this.authorized ? { id: "1", username: "tester", firstName: "Test" } : null,
      storeReady: await this.ready(),
    };
  }
  async startLogin(): Promise<{ loginId: string; step: LoginStep }> {
    return { loginId: "login-1", step: "awaiting_code" };
  }
  async submitCode(): Promise<{ step: LoginStep }> {
    return { step: "ok" };
  }
  async submitPassword(): Promise<{ step: LoginStep }> {
    return { step: "ok" };
  }
  async setChannel(): Promise<{ id: string; title: string | null }> {
    this.channelSet = true;
    return { id: "fake-channel", title: "Fake Vault" };
  }
  async logoutTelegram(): Promise<void> {
    this.authorized = false;
  }
}

export interface TestContext {
  app: ReturnType<typeof createApp>;
  deps: AppDeps;
  config: AppConfig;
  db: Db;
  store: FakeStore;
  telegram: FakeTelegram;
  repo: MediaRepository;
  rooms: RoomManager;
  tmpDir: string;
  server: Server;
  baseUrl: string;
  client: TestClient;
  close: () => Promise<void>;
}

export async function buildTestContext(): Promise<TestContext> {
  const tmpDir = mkdtempSync(join(tmpdir(), "mv-test-"));
  const config = loadConfig({
    MASTER_KEY: Buffer.alloc(32, 7).toString("base64"),
    PLAYBACK_TOKEN_SECRET: Buffer.alloc(32, 9).toString("base64"),
    AUTH_USERS: JSON.stringify([{ username: "owner", passwordHash: hashPassword(TEST_PASSWORD) }]),
    DATABASE_PATH: ":memory:",
    UPLOAD_TMP_DIR: join(tmpDir, "uploads"),
    PUBLIC_BASE_URL: "http://localhost",
    COOKIE_SECURE: "false",
    PORT: "0",
  });

  const db = await openDatabase(":memory:");
  const logger = createLogger("error");
  const store = new FakeStore();
  const telegram = new FakeTelegram(store);
  const repo = new MediaRepository(db);
  const uploads = new UploadManager({ config, db, store, repo, logger });
  await uploads.start();

  const rooms = new RoomManager();
  const deps: AppDeps = { config, db, logger, store, telegram, repo, uploads, rooms };
  const app = createApp(deps);
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const realtime = attachRealtime(server, { db, logger, rooms });
  const { port } = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${port}`;

  return {
    app,
    deps,
    config,
    db,
    store,
    telegram,
    repo,
    rooms,
    tmpDir,
    server,
    baseUrl,
    client: new TestClient(baseUrl),
    close: async () => {
      realtime.close();
      await uploads.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await db.close();
      await fs.rm(tmpDir, { recursive: true, force: true });
    },
  };
}

export async function seedMedia(
  ctx: TestContext,
  name: string,
  mime: string,
  data: Buffer,
): Promise<{ id: string; stored: StoredMedia }> {
  const stored = ctx.store.put(data, mime);
  const id = `media-${stored.messageId}`;
  await ctx.repo.insert({ id, name, stored, createdBy: "owner" });
  return { id, stored };
}

// Minimal cookie-jar client.
export class TestClient {
  readonly cookies = new Map<string, string>();
  constructor(private readonly baseUrl: string) {}

  private cookieHeader(): string {
    return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
  }

  private capture(res: Response): void {
    const setCookie = res.headers.getSetCookie?.() ?? [];
    for (const c of setCookie) {
      const pair = c.split(";")[0] ?? "";
      const eq = pair.indexOf("=");
      if (eq > 0) this.cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
  }

  async request(path: string, options: RequestInit = {}): Promise<Response> {
    const headers = new Headers(options.headers || {});
    const cookie = this.cookieHeader();
    if (cookie) headers.set("cookie", cookie);
    const res = await fetch(`${this.baseUrl}${path}`, { ...options, headers, redirect: "manual" });
    this.capture(res);
    return res;
  }

  async json<T = unknown>(path: string, options: RequestInit = {}): Promise<{ status: number; body: T }> {
    const res = await this.request(path, options);
    const body = (await res.json().catch(() => ({}))) as T;
    return { status: res.status, body };
  }

  async login(): Promise<void> {
    const res = await this.json("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "owner", password: TEST_PASSWORD }),
    });
    if (res.status !== 200) throw new Error(`login failed: ${res.status}`);
  }
}

export async function waitFor<T>(fn: () => Promise<T | null>, timeoutMs = 4000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 25));
  }
}
