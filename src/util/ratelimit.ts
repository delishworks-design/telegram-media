import type { RequestHandler } from "express";

interface Bucket {
  count: number;
  resetAt: number;
}

// Small fixed-window limiter. Per-process and in-memory: good enough for a
// two-person service, and it never grows without bound.
export function rateLimit(options: { windowMs: number; max: number; keyPrefix?: string }): RequestHandler {
  const buckets = new Map<string, Bucket>();
  let lastSweep = Date.now();

  return (req, res, next) => {
    const now = Date.now();
    if (now - lastSweep > options.windowMs) {
      for (const [k, b] of buckets) if (b.resetAt <= now) buckets.delete(k);
      lastSweep = now;
    }
    const key = `${options.keyPrefix ?? ""}:${req.ip ?? "unknown"}`;
    let bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + options.windowMs };
      buckets.set(key, bucket);
    }
    bucket.count++;
    if (bucket.count > options.max) {
      const retry = Math.ceil((bucket.resetAt - now) / 1000);
      res.setHeader("Retry-After", String(retry));
      res.status(429).json({ error: "rate_limited", retryAfter: retry });
      return;
    }
    next();
  };
}
