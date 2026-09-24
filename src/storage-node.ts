// Node adapters for the Store: node:sqlite for metadata, plain files for HTML.

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import type { Blobs, Sql, SqlValue } from "./store.ts";

// Paths are relative to this file in development (src/) and to the bundle in
// the npm package (dist/) - both sit one level below the package root.
const MIGRATIONS_DIR = new URL("../migrations/", import.meta.url);

// Loaded lazily so the CLI can filter the "SQLite is experimental" warning
// before the module is initialised.
const loadSqlite = () => process.getBuiltinModule("node:sqlite") as typeof import("node:sqlite");

// Migrations run in order; PRAGMA user_version records how many have been
// applied. Append new files here, never edit released ones.
const MIGRATIONS = ["0001_init.sql"];

function migrate(db: DatabaseSyncType) {
  const applied = (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
  for (let i = applied; i < MIGRATIONS.length; i++) {
    db.exec("BEGIN");
    try {
      db.exec(readFileSync(new URL(MIGRATIONS[i], MIGRATIONS_DIR), "utf8"));
      db.exec(`PRAGMA user_version = ${i + 1}`);
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  }
}

export function openSql(dataDir: string): Sql {
  mkdirSync(dataDir, { recursive: true });
  const db: DatabaseSyncType = new (loadSqlite().DatabaseSync)(join(dataDir, "artifacts.db"));
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  migrate(db);

  return {
    async all<T>(sql: string, ...params: SqlValue[]) {
      return db.prepare(sql).all(...params) as T[];
    },
    async first<T>(sql: string, ...params: SqlValue[]) {
      return (db.prepare(sql).get(...params) as T | undefined) ?? null;
    },
    async run(sql: string, ...params: SqlValue[]) {
      db.prepare(sql).run(...params);
    },
  };
}

export function fileBlobs(dataDir: string): Blobs {
  return {
    async put(key, body) {
      const path = join(dataDir, key);
      await mkdir(dirname(path), { recursive: true });
      // Write-then-rename so a reader never sees a half-written version.
      await writeFile(`${path}.tmp`, body, "utf8");
      await rename(`${path}.tmp`, path);
    },
    async get(key) {
      try {
        return await readFile(join(dataDir, key), "utf8");
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw e;
      }
    },
  };
}
