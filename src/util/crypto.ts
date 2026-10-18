import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  hkdfSync,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";

const GCM = "aes-256-gcm";

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

// --- scrypt password hashing -------------------------------------------------
// Format: scrypt$N$r$p$<salt-b64>$<hash-b64>

export function hashPassword(password: string): string {
  const N = 1 << 14;
  const r = 8;
  const p = 1;
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 32, { N, r, p, maxmem: 64 * 1024 * 1024 });
  return `scrypt$${N}$${r}$${p}$${salt.toString("base64")}$${hash.toString("base64")}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, nStr, rStr, pStr, saltB64, hashB64] = parts;
  const N = Number(nStr);
  const r = Number(rStr);
  const p = Number(pStr);
  if (!Number.isFinite(N) || !Number.isFinite(r) || !Number.isFinite(p)) return false;
  const salt = Buffer.from(saltB64!, "base64");
  const expected = Buffer.from(hashB64!, "base64");
  const actual = scryptSync(password, salt, expected.length, {
    N,
    r,
    p,
    maxmem: 64 * 1024 * 1024,
  });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

// --- AES-256-GCM at-rest encryption -----------------------------------------

export class SecretBox {
  private readonly key: Buffer;

  constructor(masterKey: Buffer) {
    if (masterKey.length !== 32) {
      throw new Error("SecretBox requires a 32-byte key");
    }
    this.key = masterKey;
  }

  seal(plaintext: string, context = ""): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv(GCM, this.key, iv);
    if (context) cipher.setAAD(Buffer.from(context, "utf8"));
    const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `v1.${iv.toString("base64")}.${tag.toString("base64")}.${enc.toString("base64")}`;
  }

  open(sealed: string, context = ""): string {
    const parts = sealed.split(".");
    if (parts.length !== 4 || parts[0] !== "v1") {
      throw new Error("malformed sealed payload");
    }
    const iv = Buffer.from(parts[1]!, "base64");
    const tag = Buffer.from(parts[2]!, "base64");
    const data = Buffer.from(parts[3]!, "base64");
    const decipher = createDecipheriv(GCM, this.key, iv);
    if (context) decipher.setAAD(Buffer.from(context, "utf8"));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
  }

  // Derive a subkey bound to a purpose so one master key can serve several uses.
  subkey(purpose: string): SecretBox {
    const out = hkdfSync("sha256", this.key, Buffer.alloc(0), Buffer.from(purpose), 32);
    return new SecretBox(Buffer.from(out));
  }
}

// --- Signed, expiring tokens (HMAC-SHA256) ----------------------------------
// Payload is base64url(json).expiry; signature binds the payload.

export interface TokenPayload {
  [key: string]: unknown;
}

export function signToken(secret: Buffer, payload: TokenPayload, ttlSeconds: number): string {
  const body = { ...payload, exp: Math.floor(Date.now() / 1000) + ttlSeconds };
  const encoded = Buffer.from(JSON.stringify(body), "utf8").toString("base64url");
  const sig = createHmac("sha256", secret).update(encoded).digest("base64url");
  return `${encoded}.${sig}`;
}

export function verifyToken<T extends TokenPayload>(
  secret: Buffer,
  token: string | undefined,
): (T & { exp: number }) | null {
  if (!token) return null;
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;
  const encoded = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = createHmac("sha256", secret).update(encoded).digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  let body: T & { exp: number };
  try {
    body = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (typeof body.exp !== "number" || body.exp < Math.floor(Date.now() / 1000)) return null;
  return body;
}

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

export function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}
