import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import BetterSqlite3 from "better-sqlite3";
import { applyMigrations } from "./migrations.js";

export type Database = BetterSqlite3.Database;

export function openDatabase(path: string): Database {
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true });
  }
  const db = new BetterSqlite3(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  applyMigrations(db);
  return db;
}

export function closeDatabase(db: Database): void {
  try {
    db.close();
  } catch {
    // already closed
  }
}
