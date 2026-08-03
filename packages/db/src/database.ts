import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { IsoTimestamp, Workspace } from "@replicantos/core";

import { migrations, type Migration } from "./migrations.ts";

const connections = new WeakMap<ReplicantDatabase, DatabaseSync>();

export interface OpenDatabaseOptions {
  path: string;
  busyTimeoutMs?: number;
  clock?: () => IsoTimestamp;
}

export interface BootstrapDatabaseOptions extends OpenDatabaseOptions {
  workspace?: Workspace;
}

export class DatabaseMigrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DatabaseMigrationError";
  }
}

export class ReplicantDatabase {
  readonly path: string;
  readonly clock: () => IsoTimestamp;
  #closed = false;
  #transactionDepth = 0;

  constructor(
    path: string,
    connection: DatabaseSync,
    clock: () => IsoTimestamp,
  ) {
    this.path = path;
    this.clock = clock;
    connections.set(this, connection);
  }

  transaction<Result>(operation: () => Result): Result {
    const connection = connectionFor(this);
    if (this.#transactionDepth > 0) return operation();

    connection.exec("BEGIN IMMEDIATE");
    this.#transactionDepth += 1;
    try {
      const result = operation();
      connection.exec("COMMIT");
      return result;
    } catch (error) {
      connection.exec("ROLLBACK");
      throw error;
    } finally {
      this.#transactionDepth -= 1;
    }
  }

  schemaVersion(): number {
    const row = connectionFor(this)
      .prepare(
        "SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations",
      )
      .get() as { version: number };
    return row.version;
  }

  integrityCheck(): string {
    const row = connectionFor(this).prepare("PRAGMA integrity_check").get() as {
      integrity_check: string;
    };
    return row.integrity_check;
  }

  close(): void {
    if (this.#closed) return;
    connectionFor(this).close();
    connections.delete(this);
    this.#closed = true;
  }
}

export function connectionFor(database: ReplicantDatabase): DatabaseSync {
  const connection = connections.get(database);
  if (connection === undefined)
    throw new Error("Database connection is closed");
  return connection;
}

function defaultClock(): IsoTimestamp {
  return new Date().toISOString() as IsoTimestamp;
}

function migrationChecksum(migration: Migration): string {
  return createHash("sha256").update(migration.sql).digest("hex");
}

function initializeMigrationTable(connection: DatabaseSync): void {
  connection.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      checksum TEXT NOT NULL,
      applied_at TEXT NOT NULL
    ) STRICT
  `);
}

function applyMigrations(database: ReplicantDatabase): void {
  const connection = connectionFor(database);
  initializeMigrationTable(connection);

  const applied = connection
    .prepare(
      "SELECT version, name, checksum FROM schema_migrations ORDER BY version",
    )
    .all() as Array<{ version: number; name: string; checksum: string }>;
  const knownVersions = new Set(
    migrations.map((migration) => migration.version),
  );

  for (const row of applied) {
    const migration = migrations.find(
      (candidate) => candidate.version === row.version,
    );
    if (migration === undefined) {
      throw new DatabaseMigrationError(
        `Database contains unknown migration ${row.version}`,
      );
    }
    if (
      migration.name !== row.name ||
      migrationChecksum(migration) !== row.checksum
    ) {
      throw new DatabaseMigrationError(
        `Migration ${row.version} does not match the application`,
      );
    }
  }

  for (const migration of migrations) {
    if (!knownVersions.has(migration.version)) {
      throw new DatabaseMigrationError(
        `Duplicate or invalid migration ${migration.version}`,
      );
    }
    if (applied.some((row) => row.version === migration.version)) continue;

    database.transaction(() => {
      connection.exec(migration.sql);
      connection
        .prepare(
          "INSERT INTO schema_migrations(version, name, checksum, applied_at) VALUES (?, ?, ?, ?)",
        )
        .run(
          migration.version,
          migration.name,
          migrationChecksum(migration),
          database.clock(),
        );
    });
  }
}

export function openDatabase(options: OpenDatabaseOptions): ReplicantDatabase {
  if (options.path.trim() === "")
    throw new TypeError("Database path cannot be empty");
  const busyTimeoutMs = options.busyTimeoutMs ?? 5_000;
  if (
    !Number.isInteger(busyTimeoutMs) ||
    busyTimeoutMs < 0 ||
    busyTimeoutMs > 60_000
  ) {
    throw new RangeError(
      "busyTimeoutMs must be an integer between 0 and 60000",
    );
  }

  const memory = options.path === ":memory:";
  const databasePath = memory
    ? options.path
    : isAbsolute(options.path)
      ? options.path
      : resolve(options.path);
  if (!memory)
    mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 });

  const connection = new DatabaseSync(databasePath, {
    allowExtension: false,
    enableForeignKeyConstraints: true,
  });
  connection.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
  connection.exec("PRAGMA foreign_keys = ON");
  connection.exec("PRAGMA recursive_triggers = ON");
  connection.exec("PRAGMA trusted_schema = OFF");
  if (!memory) {
    connection.exec("PRAGMA journal_mode = WAL");
    connection.exec("PRAGMA synchronous = NORMAL");
  }

  const database = new ReplicantDatabase(
    databasePath,
    connection,
    options.clock ?? defaultClock,
  );
  try {
    applyMigrations(database);
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}

export function bootstrapDatabase(
  options: BootstrapDatabaseOptions,
): ReplicantDatabase {
  const database = openDatabase(options);
  const workspace = options.workspace;
  if (workspace === undefined) return database;

  try {
    database.transaction(() => {
      const connection = connectionFor(database);
      const rows = connection
        .prepare("SELECT id FROM workspaces LIMIT 2")
        .all() as Array<{
        id: string;
      }>;
      if (rows.length === 0) {
        connection
          .prepare(
            `INSERT INTO workspaces(id, slug, display_name, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?)`,
          )
          .run(
            workspace.id,
            workspace.slug,
            workspace.displayName,
            workspace.createdAt,
            workspace.updatedAt,
          );
        return;
      }
      if (rows.length !== 1 || rows[0]?.id !== workspace.id) {
        throw new Error(
          "The database is already bootstrapped for a different workspace",
        );
      }
    });
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}
