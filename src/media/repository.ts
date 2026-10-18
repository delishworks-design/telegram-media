import type { Db } from "../db/index.js";
import type { MessageRef, StoredMedia } from "./store.js";

export type MediaStatus = "ready" | "error";

export interface MediaRecord {
  id: string;
  name: string;
  size: number;
  mime: string;
  duration: number | null;
  width: number | null;
  height: number | null;
  messageId: number;
  channelId: string;
  fileReference: string | null;
  status: MediaStatus;
  error: string | null;
  createdBy: string | null;
  uploadedAt: number;
  updatedAt: number;
}

export type MediaCategory = "video" | "audio" | "image" | "other";

export interface ListOptions {
  q?: string;
  category?: MediaCategory;
  sort?: "date_desc" | "date_asc" | "name_asc" | "size_desc";
  limit?: number;
  offset?: number;
}

interface Row {
  id: string;
  name: string;
  size: number;
  mime: string;
  duration: number | null;
  width: number | null;
  height: number | null;
  message_id: number;
  channel_id: string;
  file_reference: string | null;
  status: string;
  error: string | null;
  created_by: string | null;
  uploaded_at: number;
  updated_at: number;
}

function toRecord(row: Row): MediaRecord {
  return {
    id: row.id,
    name: row.name,
    size: row.size,
    mime: row.mime,
    duration: row.duration,
    width: row.width,
    height: row.height,
    messageId: row.message_id,
    channelId: row.channel_id,
    fileReference: row.file_reference,
    status: row.status as MediaStatus,
    error: row.error,
    createdBy: row.created_by,
    uploadedAt: row.uploaded_at,
    updatedAt: row.updated_at,
  };
}

const CATEGORY_PREFIX: Record<Exclude<MediaCategory, "other">, string> = {
  video: "video/",
  audio: "audio/",
  image: "image/",
};

export class MediaRepository {
  constructor(private readonly db: Db) {}

  async insert(input: {
    id: string;
    name: string;
    stored: StoredMedia;
    createdBy: string | null;
  }): Promise<MediaRecord> {
    const now = Date.now();
    await this.db.run(
      `INSERT INTO media (id, name, search_name, size, mime, duration, width, height,
         message_id, channel_id, file_reference, status, created_by, uploaded_at, updated_at)
       VALUES (@id, @name, @search, @size, @mime, @duration, @width, @height,
         @messageId, @channelId, @fileReference, 'ready', @createdBy, @now, @now)`,
      {
        id: input.id,
        name: input.name,
        search: input.name.toLowerCase(),
        size: input.stored.size,
        mime: input.stored.mime,
        duration: input.stored.duration ?? null,
        width: input.stored.width ?? null,
        height: input.stored.height ?? null,
        messageId: input.stored.messageId,
        channelId: input.stored.channelId,
        fileReference: input.stored.fileReference ?? null,
        createdBy: input.createdBy,
        now,
      },
    );
    const record = await this.get(input.id);
    if (!record) throw new Error("Failed to read back the inserted media row");
    return record;
  }

  async get(id: string): Promise<MediaRecord | null> {
    const row = await this.db.get<Row>("SELECT * FROM media WHERE id = ?", [id]);
    return row ? toRecord(row) : null;
  }

  async list(options: ListOptions = {}): Promise<{ items: MediaRecord[]; total: number }> {
    const where: string[] = [];
    const params: Record<string, unknown> = {};
    if (options.q) {
      where.push("search_name LIKE @q");
      params.q = `%${options.q.toLowerCase()}%`;
    }
    if (options.category && options.category !== "other") {
      where.push("mime LIKE @prefix");
      params.prefix = `${CATEGORY_PREFIX[options.category]}%`;
    } else if (options.category === "other") {
      where.push("mime NOT LIKE 'video/%' AND mime NOT LIKE 'audio/%' AND mime NOT LIKE 'image/%'");
    }
    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const orderSql = {
      date_desc: "uploaded_at DESC",
      date_asc: "uploaded_at ASC",
      name_asc: "LOWER(name) ASC",
      size_desc: "size DESC",
    }[options.sort ?? "date_desc"];

    const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
    const offset = Math.max(options.offset ?? 0, 0);

    const totalRow = await this.db.get<{ c: number }>(
      `SELECT COUNT(*) AS c FROM media ${whereSql}`,
      where.length ? params : undefined,
    );
    const rows = await this.db.all<Row>(
      `SELECT * FROM media ${whereSql} ORDER BY ${orderSql} LIMIT @limit OFFSET @offset`,
      { ...params, limit, offset },
    );
    return { items: rows.map(toRecord), total: totalRow?.c ?? 0 };
  }

  async rename(id: string, name: string): Promise<MediaRecord | null> {
    const trimmed = name.trim();
    if (!trimmed) throw new Error("Name cannot be empty");
    if (trimmed.length > 255) throw new Error("Name is too long (max 255 characters)");
    const res = await this.db.run("UPDATE media SET name = ?, search_name = ?, updated_at = ? WHERE id = ?", [
      trimmed,
      trimmed.toLowerCase(),
      Date.now(),
      id,
    ]);
    return res.changes ? this.get(id) : null;
  }

  async delete(id: string): Promise<boolean> {
    const res = await this.db.run("DELETE FROM media WHERE id = ?", [id]);
    return res.changes > 0;
  }

  ref(record: MediaRecord): MessageRef {
    return { channelId: record.channelId, messageId: record.messageId };
  }
}
