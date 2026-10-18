import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import BetterSqlite3 from "better-sqlite3";
import { Pool, types, type PoolClient, type QueryResult } from "pg";
import { applyMigrations } from "./migrations.js";

export type DbParams = unknown[] | Record<string, unknown> | undefined;

export interface DbResult {
  changes: number;
}

// A tiny, driver-agnostic async database surface. Application code always
// writes SQLite-flavoured SQL (`?` positional or `@name` named placeholders);
// the Postgres driver rewrites placeholders to `$n` on the fly.
export interface Db {
  readonly dialect: "sqlite" | "postgres";
  get<T = Record<string, unknown>>(sql: string, params?: DbParams): Promise<T | undefined>;
  all<T = Record<string, unknown>>(sql: string, params?: DbParams): Promise<T[]>;
  run(sql: string, params?: DbParams): Promise<DbResult>;
  exec(sql: string): Promise<void>;
  transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

// --- SQLite (better-sqlite3) ------------------------------------------------

class SqliteDb implements Db {
  readonly dialect = "sqlite" as const;

  constructor(private readonly db: BetterSqlite3.Database) {}

  private bind(params: DbParams): unknown[] {
    if (params === undefined) return [];
    if (Array.isArray(params)) return params;
    return Object.keys(params).length === 0 ? [] : [params];
  }

  async get<T>(sql: string, params?: DbParams): Promise<T | undefined> {
    return this.db.prepare(sql).get(...this.bind(params)) as T | undefined;
  }

  async all<T>(sql: string, params?: DbParams): Promise<T[]> {
    return this.db.prepare(sql).all(...this.bind(params)) as T[];
  }

  async run(sql: string, params?: DbParams): Promise<DbResult> {
    const res = this.db.prepare(sql).run(...this.bind(params));
    return { changes: res.changes };
  }

  async exec(sql: string): Promise<void> {
    this.db.exec(sql);
  }

  async transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
    this.db.exec("BEGIN");
    try {
      const value = await fn(this);
      this.db.exec("COMMIT");
      return value;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  async close(): Promise<void> {
    this.db.close();
  }
}

// --- Postgres (pg) ----------------------------------------------------------

// Rewrites `?` / `@name` placeholders to Postgres `$n`, skipping string
// literals so values like 'video/%' are never touched.
export function translatePostgres(sql: string, params?: DbParams): { text: string; values: unknown[] } {
  const values: unknown[] = [];
  const named = new Map<string, number>();
  const positional = Array.isArray(params) ? (params as unknown[]) : [];
  const record = params && !Array.isArray(params) ? (params as Record<string, unknown>) : undefined;
  let pos = 0;
  let text = "";
  let i = 0;

  while (i < sql.length) {
    const ch = sql[i]!;
    if (ch === "'") {
      text += ch;
      i++;
      while (i < sql.length) {
        text += sql[i];
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") {
            text += sql[i + 1];
            i += 2;
            continue;
          }
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    if (ch === "?") {
      values.push(positional[pos++]);
      text += `$${values.length}`;
      i++;
      continue;
    }
    if (ch === "@") {
      let name = "";
      let j = i + 1;
      while (j < sql.length && /[A-Za-z0-9_]/.test(sql[j]!)) {
        name += sql[j];
        j++;
      }
      if (name) {
        if (!named.has(name)) {
          values.push(record ? record[name] : undefined);
          named.set(name, values.length);
        }
        text += `$${named.get(name)}`;
        i = j;
        continue;
      }
    }
    text += ch;
    i++;
  }
  return { text, values };
}

interface Queryable {
  query(sql: string, params?: unknown[]): Promise<QueryResult>;
}

export class PgDb implements Db {
  readonly dialect = "postgres" as const;

  constructor(
    private readonly pool: Pool,
    private readonly client?: PoolClient,
  ) {}

  private runner(): Queryable {
    return this.client ?? this.pool;
  }

  async get<T>(sql: string, params?: DbParams): Promise<T | undefined> {
    const { text, values } = translatePostgres(sql, params);
    const res = await this.runner().query(text, values);
    return res.rows[0] as T | undefined;
  }

  async all<T>(sql: string, params?: DbParams): Promise<T[]> {
    const { text, values } = translatePostgres(sql, params);
    const res = await this.runner().query(text, values);
    return res.rows as T[];
  }

  async run(sql: string, params?: DbParams): Promise<DbResult> {
    const { text, values } = translatePostgres(sql, params);
    const res = await this.runner().query(text, values);
    return { changes: res.rowCount ?? 0 };
  }

  async exec(sql: string): Promise<void> {
    await this.runner().query(sql);
  }

  async transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const tx = new PgDb(this.pool, client);
      const value = await fn(tx);
      await client.query("COMMIT");
      return value;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

// BigInt / numeric columns come back as strings from node-postgres. Our values
// (epoch millis, byte sizes) are always well below 2^53, so a Number is safe.
function configurePgTypes(): void {
  types.setTypeParser(20, (v) => Number(v)); // int8 / bigint
  types.setTypeParser(1700, (v) => Number(v)); // numeric
}

function poolConfig(url: string): ConstructorParameters<typeof Pool>[0] {
  const local = /(?:@|\/\/)(localhost|127\.0\.0\.1|\[::1\])/i.test(url);
  const explicit = process.env.DATABASE_SSL?.toLowerCase();
  const wantSsl = explicit === "require" ? true : explicit === "disable" ? false : !local;
  return {
    connectionString: url,
    max: Number(process.env.DATABASE_POOL_MAX ?? 5),
    ssl: wantSsl ? { rejectUnauthorized: false } : undefined,
  };
}

export async function openDatabase(path: string): Promise<Db> {
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true });
  }
  const raw = new BetterSqlite3(path);
  raw.pragma("journal_mode = WAL");
  raw.pragma("foreign_keys = ON");
  raw.pragma("busy_timeout = 5000");
  const db = new SqliteDb(raw);
  await applyMigrations(db);
  return db;
}

export async function openPostgres(url: string): Promise<Db> {
  configurePgTypes();
  const pool = new Pool(poolConfig(url));
  const db = new PgDb(pool);
  await applyMigrations(db);
  return db;
}

export async function closeDatabase(db: Db): Promise<void> {
  try {
    await db.close();
  } catch {
    // already closed
  }
}
