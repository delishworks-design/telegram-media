import type { Response } from "express";
import type { MediaStore, MessageRef } from "./store.js";

export interface ResolvedRange {
  start: number;
  end: number;
}

export type RangeParse = ResolvedRange | "unsatisfiable" | null;

// Parses a single-range `Range` header (RFC 7233). Returns null when absent,
// "unsatisfiable" when out of bounds, otherwise the inclusive byte range.
export function parseRange(header: string | undefined, size: number): RangeParse {
  if (!header) return null;
  const match = /^bytes=(.+)$/i.exec(header.trim());
  if (!match) return null;
  if (!Number.isFinite(size) || size <= 0) return "unsatisfiable";

  const spec = match[1]!.split(",")[0]!.trim();
  const dash = spec.indexOf("-");
  if (dash === -1) return "unsatisfiable";
  const startStr = spec.slice(0, dash).trim();
  const endStr = spec.slice(dash + 1).trim();

  let start: number;
  let end: number;
  if (startStr === "") {
    // Suffix range: last N bytes.
    const suffix = Number(endStr);
    if (!Number.isInteger(suffix) || suffix <= 0) return "unsatisfiable";
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(startStr);
    if (!Number.isInteger(start) || start < 0) return "unsatisfiable";
    if (endStr === "") {
      end = size - 1;
    } else {
      end = Number(endStr);
      if (!Number.isInteger(end) || end < start) return "unsatisfiable";
      end = Math.min(end, size - 1);
    }
  }
  if (start >= size) return "unsatisfiable";
  return { start, end };
}

export interface StreamOptions {
  store: MediaStore;
  ref: MessageRef;
  size: number;
  mime: string;
  name: string;
  rangeHeader: string | undefined;
  ifRangeHeader?: string | undefined;
  etag: string;
  headOnly: boolean;
  signal: AbortSignal;
  logger: { warn(msg: string, meta?: Record<string, unknown>): void };
}

function safeFilename(name: string): string {
  const cleaned = name.replace(/[\r\n"]/g, "").trim() || "video";
  return `inline; filename="${cleaned}"`;
}

export async function streamMedia(res: Response, options: StreamOptions): Promise<void> {
  const { store, ref, size, mime } = options;
  const parsed = parseRange(options.rangeHeader, size);

  if (parsed === "unsatisfiable") {
    res.status(416);
    res.setHeader("Content-Range", `bytes */${size}`);
    res.end();
    return;
  }

  const start = parsed ? parsed.start : 0;
  const end = parsed ? parsed.end : size - 1;
  const length = end - start + 1;
  const partial = parsed !== null;

  res.status(partial ? 206 : 200);
  res.setHeader("Content-Type", mime || "application/octet-stream");
  res.setHeader("Accept-Ranges", "bytes");
  res.setHeader("Content-Length", String(length));
  res.setHeader("Cache-Control", "private, max-age=0, must-revalidate");
  res.setHeader("ETag", options.etag);
  res.setHeader("Content-Disposition", safeFilename(options.name));
  if (partial) res.setHeader("Content-Range", `bytes ${start}-${end}/${size}`);

  if (res.req.method === "HEAD" || options.headOnly) {
    res.end();
    return;
  }

  try {
    for await (const chunk of store.readRange(ref, start, end, options.signal)) {
      if (options.signal.aborted) break;
      const ok = res.write(chunk);
      if (!ok) await waitForDrain(res);
      if (res.writableEnded || options.signal.aborted) break;
    }
    res.end();
  } catch (err) {
    const message = (err as Error)?.message ?? "stream error";
    options.logger.warn("stream failed", { error: message, start, end });
    if (!res.headersSent) {
      res.status(502).json({ error: "stream_failed", message: "The media source could not be read" });
    } else {
      res.destroy(err as Error);
    }
  }
}

function waitForDrain(res: Response): Promise<void> {
  return new Promise((resolve) => {
    const onDrain = () => {
      cleanup();
      resolve();
    };
    const onClose = () => {
      cleanup();
      resolve();
    };
    const cleanup = () => {
      res.off("drain", onDrain);
      res.off("close", onClose);
    };
    res.once("drain", onDrain);
    res.once("close", onClose);
  });
}
