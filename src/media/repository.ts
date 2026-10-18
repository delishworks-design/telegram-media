import type { Database } from "../db/index.js";
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
  constructor(private readonly db: Database) {}

  insert(input: {
    id: string;
    name: string;
    stored: StoredMedia;
    createdBy: string | null;
  }): MediaRecord {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO media (id, name, search_name, size, mime, duration, width, height,
           message_id, channel_id, file_reference, status, created_by, uploaded_at, updated_at)
         VALUES (@id, @name, @search, @size, @mime, @duration, @width, @height,
           @messageId, @channelId, @fileReference, 'ready', @createdBy, @now, @now)`,
      )
      .run({
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
      });
    return this.get(input.id)!;
  }

  get(id: string): MediaRecord | null {
    const row = this.db.prepare("SELECT * FROM media WHERE id = ?").get(id) as Row | undefined;
    return row ? toRecord(row) : null;
  }

  list(options: ListOptions = {}): { items: MediaRecord[]; total: number } {
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
      name_asc: "name COLLATE NOCASE ASC",
      size_desc: "size DESC",
    }[options.sort ?? "date_desc"];

    const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
    const offset = Math.max(options.offset ?? 0, 0);

    const total = (
      this.db.prepare(`SELECT COUNT(*) AS c FROM media ${whereSql}`).get(params) as { c: number }
    ).c;
    const rows = this.db
      .prepare(`SELECT * FROM media ${whereSql} ORDER BY ${orderSql} LIMIT @limit OFFSET @offset`)
      .all({ ...params, limit, offset }) as Row[];
    return { items: rows.map(toRecord), total };
  }

  rename(id: string, name: string): MediaRecord | null {
    const trimmed = name.trim();
    if (!trimmed) throw new Error("Name cannot be empty");
    if (trimmed.length > 255) throw new Error("Name is too long (max 255 characters)");
    const res = this.db
      .prepare("UPDATE media SET name = ?, search_name = ?, updated_at = ? WHERE id = ?")
      .run(trimmed, trimmed.toLowerCase(), Date.now(), id);
    return res.changes ? this.get(id) : null;
  }

  delete(id: string): boolean {
    return this.db.prepare("DELETE FROM media WHERE id = ?").run(id).changes > 0;
  }

  ref(record: MediaRecord): MessageRef {
    return { channelId: record.channelId, messageId: record.messageId };
  }
}
