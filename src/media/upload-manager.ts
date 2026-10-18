import { EventEmitter } from "node:events";
import { promises as fsp } from "node:fs";
import { join } from "node:path";
import { randomToken } from "../util/crypto.js";
import type { AppConfig } from "../config.js";
import type { Database } from "../db/index.js";
import type { Logger } from "../util/logger.js";
import { floodWaitSeconds, TelegramFloodError } from "../telegram/service.js";
import type { MediaStore } from "./store.js";
import type { MediaRepository } from "./repository.js";

export type UploadStatus =
  | "uploading"
  | "pending"
  | "processing"
  | "done"
  | "error"
  | "cancelled";

export interface UploadRecord {
  id: string;
  name: string;
  size: number;
  mime: string;
  received: number;
  expectedChunks: number | null;
  status: UploadStatus;
  error: string | null;
  mediaId: string | null;
  progress: number;
  createdBy: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface UploadEvent {
  type: "created" | "progress" | "pending" | "done" | "error" | "cancelled" | "retry";
  uploadId: string;
  record: UploadRecord;
  message?: string;
}

interface Row {
  id: string;
  name: string;
  size: number;
  mime: string;
  received: number;
  expected_chunks: number | null;
  status: string;
  error: string | null;
  media_id: string | null;
  tmp_path: string | null;
  created_by: string | null;
  attempts: number;
  created_at: number;
  updated_at: number;
}

export class UploadManager {
  private readonly events = new EventEmitter();
  private readonly active = new Map<string, { abort: AbortController; progress: number }>();
  private readonly notBefore = new Map<string, number>();
  private workers = 0;
  private stopped = false;
  private readonly activePromises = new Set<Promise<void>>();

  constructor(
    private readonly deps: {
      config: AppConfig;
      db: Database;
      store: MediaStore;
      repo: MediaRepository;
      logger: Logger;
    },
  ) {
    this.events.setMaxListeners(50);
  }

  async start(): Promise<void> {
    await fsp.mkdir(this.deps.config.uploadTmpDir, { recursive: true });
    // Any "processing" rows are leftovers from a crash; requeue them.
    this.deps.db
      .prepare("UPDATE uploads SET status = 'pending', updated_at = ? WHERE status = 'processing'")
      .run(Date.now());
    this.pump();
  }

  stop(): void {
    this.stopped = true;
    for (const { abort } of this.active.values()) abort.abort();
  }

  // Stops accepting work and waits for in-flight uploads to unwind. Call before
  // closing the database so a finishing upload never writes to a dead handle.
  async close(): Promise<void> {
    this.stop();
    await Promise.allSettled([...this.activePromises]);
  }

  subscribe(listener: (event: UploadEvent) => void): () => void {
    this.events.on("event", listener);
    return () => this.events.off("event", listener);
  }

  private emit(event: UploadEvent): void {
    this.events.emit("event", event);
  }

  // --- client-facing operations --------------------------------------------

  async create(input: { name: string; size: number; mime: string; createdBy: string | null }): Promise<{
    id: string;
    chunkSize: number;
    expectedChunks: number;
    upload: UploadRecord;
  }> {
    const { config } = this.deps;
    if (!Number.isFinite(input.size) || input.size <= 0) throw new Error("size must be a positive number");
    if (input.size > config.maxUploadBytes) {
      throw Object.assign(new Error(`File exceeds the ${config.maxUploadBytes} byte upload limit`), {
        statusCode: 413,
      });
    }
    const name = (input.name || "untitled").replace(/[\u0000-\u001f/\\]/g, "_").slice(0, 255);
    const id = randomToken(16);
    const expectedChunks = Math.ceil(input.size / config.chunkSizeBytes);
    const tmpPath = join(config.uploadTmpDir, `${id}.part`);
    await fsp.mkdir(config.uploadTmpDir, { recursive: true });
    const handle = await fsp.open(tmpPath, "w");
    await handle.truncate(input.size);
    await handle.close();

    const now = Date.now();
    this.deps.db
      .prepare(
        `INSERT INTO uploads (id, name, size, mime, received, expected_chunks, status, tmp_path, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, 0, ?, 'uploading', ?, ?, ?, ?)`,
      )
      .run(id, name, input.size, input.mime, expectedChunks, tmpPath, input.createdBy, now, now);

    const upload = this.get(id)!;
    this.emit({ type: "created", uploadId: id, record: upload });
    return { id, chunkSize: config.chunkSizeBytes, expectedChunks, upload };
  }

  async appendChunk(id: string, index: number, data: Buffer): Promise<UploadRecord> {
    const row = this.raw(id);
    if (!row) throw Object.assign(new Error("Unknown upload"), { statusCode: 404 });
    if (row.status !== "uploading") {
      throw Object.assign(new Error(`Upload is ${row.status}`), { statusCode: 409 });
    }
    const expected = row.expected_chunks ?? 0;
    if (!Number.isInteger(index) || index < 0 || index >= expected) {
      throw Object.assign(new Error("Chunk index out of range"), { statusCode: 416 });
    }
    const offset = index * this.deps.config.chunkSizeBytes;
    if (offset + data.length > row.size) {
      throw Object.assign(new Error("Chunk overruns declared file size"), { statusCode: 416 });
    }

    const existing = this.deps.db
      .prepare("SELECT size FROM upload_chunks WHERE upload_id = ? AND idx = ?")
      .get(id, index) as { size: number } | undefined;
    const handle = await fsp.open(row.tmp_path!, "r+");
    try {
      await handle.write(data, 0, data.length, offset);
    } finally {
      await handle.close();
    }

    if (existing) {
      this.deps.db
        .prepare("UPDATE upload_chunks SET size = ? WHERE upload_id = ? AND idx = ?")
        .run(data.length, id, index);
    } else {
      this.deps.db
        .prepare("INSERT INTO upload_chunks (upload_id, idx, size) VALUES (?, ?, ?)")
        .run(id, index, data.length);
    }

    const agg = this.deps.db
      .prepare("SELECT COUNT(*) AS c, COALESCE(SUM(size), 0) AS s FROM upload_chunks WHERE upload_id = ?")
      .get(id) as { c: number; s: number };
    this.deps.db
      .prepare("UPDATE uploads SET received = ?, updated_at = ? WHERE id = ?")
      .run(agg.s, Date.now(), id);

    if (agg.c >= expected && agg.s >= row.size) {
      await this.finalize(id);
    } else {
      const rec = this.get(id)!;
      this.emit({ type: "progress", uploadId: id, record: rec });
    }
    return this.get(id)!;
  }

  async finalize(id: string): Promise<UploadRecord> {
    const row = this.raw(id);
    if (!row) throw Object.assign(new Error("Unknown upload"), { statusCode: 404 });
    if (row.received < row.size && !(row.expected_chunks && row.status === "uploading")) {
      // fall through; handled below
    }
    const agg = this.deps.db
      .prepare("SELECT COUNT(*) AS c, COALESCE(SUM(size), 0) AS s FROM upload_chunks WHERE upload_id = ?")
      .get(id) as { c: number; s: number };
    if (agg.s < row.size || agg.c < (row.expected_chunks ?? 0)) {
      throw Object.assign(
        new Error(`Upload incomplete: received ${agg.s} of ${row.size} bytes`),
        { statusCode: 400 },
      );
    }
    if (row.status === "uploading" || row.status === "error") {
      this.deps.db
        .prepare("UPDATE uploads SET status = 'pending', error = NULL, updated_at = ? WHERE id = ?")
        .run(Date.now(), id);
      const rec = this.get(id)!;
      this.emit({ type: "pending", uploadId: id, record: rec });
      this.pump();
    }
    return this.get(id)!;
  }

  cancel(id: string): UploadRecord | null {
    const row = this.raw(id);
    if (!row) return null;
    if (row.status === "done" || row.status === "cancelled") return this.get(id);
    const active = this.active.get(id);
    if (active) active.abort.abort();
    this.deps.db
      .prepare("UPDATE uploads SET status = 'cancelled', updated_at = ? WHERE id = ?")
      .run(Date.now(), id);
    void this.removeTmp(row.tmp_path);
    const rec = this.get(id)!;
    this.emit({ type: "cancelled", uploadId: id, record: rec });
    return rec;
  }

  retry(id: string): UploadRecord | null {
    const row = this.raw(id);
    if (!row) return null;
    if (row.status === "error") {
      this.deps.db
        .prepare("UPDATE uploads SET status = 'pending', error = NULL, updated_at = ? WHERE id = ?")
        .run(Date.now(), id);
      this.pump();
    }
    return this.get(id);
  }

  get(id: string): UploadRecord | null {
    const row = this.raw(id);
    if (!row) return null;
    const progress =
      row.status === "done" || row.status === "pending" || row.status === "error" || row.status === "cancelled"
        ? row.status === "done"
          ? 1
          : row.size
            ? row.received / row.size
            : 0
        : this.active.get(id)?.progress ?? (row.size ? row.received / row.size : 0);
    return {
      id: row.id,
      name: row.name,
      size: row.size,
      mime: row.mime,
      received: row.received,
      expectedChunks: row.expected_chunks,
      status: row.status as UploadStatus,
      error: row.error,
      mediaId: row.media_id,
      progress: Math.max(0, Math.min(1, progress)),
      createdBy: row.created_by,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  list(createdBy?: string): UploadRecord[] {
    const rows = createdBy
      ? (this.deps.db
          .prepare("SELECT id FROM uploads WHERE created_by = ? ORDER BY created_at DESC LIMIT 100")
          .all(createdBy) as { id: string }[])
      : (this.deps.db.prepare("SELECT id FROM uploads ORDER BY created_at DESC LIMIT 100").all() as {
          id: string;
        }[]);
    return rows.map((r) => this.get(r.id)!).filter(Boolean);
  }

  private raw(id: string): Row | undefined {
    return this.deps.db.prepare("SELECT * FROM uploads WHERE id = ?").get(id) as Row | undefined;
  }

  private async removeTmp(path: string | null): Promise<void> {
    if (!path) return;
    await fsp.rm(path, { force: true }).catch(() => undefined);
  }

  // --- processing queue -----------------------------------------------------

  private pump(): void {
    if (this.stopped) return;
    const max = this.deps.config.uploadConcurrency;
    while (this.workers < max) {
      const next = this.nextPending();
      if (!next) return;
      this.workers++;
      const task = this.process(next)
        .catch((err) => this.deps.logger.error("queue worker crashed", { error: (err as Error).message }))
        .finally(() => {
          this.workers--;
          this.activePromises.delete(task);
          this.pump();
        });
      this.activePromises.add(task);
    }
  }

  private nextPending(): Row | undefined {
    const now = Date.now();
    const rows = this.deps.db
      .prepare("SELECT * FROM uploads WHERE status = 'pending' ORDER BY created_at ASC LIMIT 20")
      .all() as Row[];
    return rows.find((r) => (this.notBefore.get(r.id) ?? 0) <= now);
  }

  private async process(row: Row): Promise<void> {
    if (this.stopped) return;
    const abort = new AbortController();
    this.active.set(row.id, { abort, progress: 0 });
    this.deps.db
      .prepare("UPDATE uploads SET status = 'processing', attempts = attempts + 1, updated_at = ? WHERE id = ?")
      .run(Date.now(), row.id);
    this.emit({ type: "progress", uploadId: row.id, record: this.get(row.id)! });

    try {
      const stored = await this.deps.store.upload({
        path: row.tmp_path!,
        name: row.name,
        mime: row.mime,
        size: row.size,
        signal: abort.signal,
        onProgress: (fraction) => {
          const entry = this.active.get(row.id);
          if (entry) entry.progress = fraction;
          this.emit({ type: "progress", uploadId: row.id, record: this.get(row.id)! });
        },
      });

      if (this.stopped) {
        await this.removeTmp(row.tmp_path);
        return;
      }
      // If it was cancelled mid-flight, do not persist a media row.
      const current = this.raw(row.id);
      if (!current || current.status === "cancelled") {
        await this.removeTmp(row.tmp_path);
        return;
      }

      const mediaId = randomToken(16);
      this.deps.repo.insert({ id: mediaId, name: row.name, stored, createdBy: row.created_by });
      this.deps.db
        .prepare("UPDATE uploads SET status = 'done', media_id = ?, received = size, updated_at = ? WHERE id = ?")
        .run(mediaId, Date.now(), row.id);
      await this.removeTmp(row.tmp_path);
      this.emit({ type: "done", uploadId: row.id, record: this.get(row.id)! });
      this.deps.logger.info("upload complete", { uploadId: row.id, mediaId, size: row.size });
    } catch (err) {
      const current = this.raw(row.id);
      if (current?.status === "cancelled" || (err as Error)?.name === "AbortError" || abort.signal.aborted) {
        this.emit({ type: "cancelled", uploadId: row.id, record: this.get(row.id)! });
        return;
      }
      if (this.stopped) return;
      const wait = err instanceof TelegramFloodError ? err.seconds : floodWaitSeconds(err);
      if (wait > 0) {
        const delay = Math.min(wait, 600) * 1000 + 1000;
        this.notBefore.set(row.id, Date.now() + delay);
        this.deps.db
          .prepare("UPDATE uploads SET status = 'pending', updated_at = ? WHERE id = ?")
          .run(Date.now(), row.id);
        this.deps.logger.warn("telegram flood wait, will retry", { uploadId: row.id, seconds: wait });
        this.emit({ type: "retry", uploadId: row.id, record: this.get(row.id)!, message: `Rate limited by Telegram; retrying in ${wait}s` });
        setTimeout(() => this.pump(), delay).unref?.();
        return;
      }
      const message = (err as Error)?.message ?? "upload failed";
      this.deps.db
        .prepare("UPDATE uploads SET status = 'error', error = ?, updated_at = ? WHERE id = ?")
        .run(message.slice(0, 500), Date.now(), row.id);
      this.deps.logger.error("upload failed", { uploadId: row.id, error: message });
      this.emit({ type: "error", uploadId: row.id, record: this.get(row.id)!, message });
    } finally {
      this.active.delete(row.id);
    }
  }
}
