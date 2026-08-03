import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { IsoTimestamp, UserId } from "@replicantos/core";
import {
  createRepositories,
  openDatabase,
  type Repositories,
  type ReplicantDatabase,
} from "@replicantos/db";

import type { ServerConfig } from "./config.js";
import { SafeDatabaseViewer } from "./database-viewer.js";
import { DocumentIndexStore } from "./document-index.js";
import { SafeFileService } from "./file-service.js";
import {
  createRuntimeService,
  type RuntimeService,
} from "./runtime-service.js";
import { createPasswordService, type PasswordService } from "./security.js";

export interface ServerDependencies {
  database: ReplicantDatabase | null;
  databaseViewer: SafeDatabaseViewer | null;
  documentIndex: DocumentIndexStore | null;
  files: SafeFileService | null;
  repositories: Repositories | null;
  runtime: RuntimeService | null;
  passwords: PasswordService | null;
  now(): IsoTimestamp;
  readPasswordHash(userId: UserId): Promise<string | null>;
  close(): Promise<void>;
}

export const lockedDependencies: ServerDependencies = Object.freeze({
  database: null,
  databaseViewer: null,
  documentIndex: null,
  files: null,
  repositories: null,
  runtime: null,
  passwords: null,
  now: () => new Date().toISOString() as IsoTimestamp,
  async readPasswordHash() {
    return null;
  },
  async close() {},
});

export interface ProductionDependencyOptions {
  databasePath?: string;
  clock?: () => IsoTimestamp;
}

export async function createProductionDependencies(
  config: ServerConfig,
  options: ProductionDependencyOptions = {},
): Promise<ServerDependencies> {
  const database = openDatabase({
    path:
      options.databasePath ?? join(config.dataDirectory, "replicantos.sqlite"),
    ...(options.clock === undefined ? {} : { clock: options.clock }),
  });

  let credentialReader: DatabaseSync | null = null;
  let databaseViewer: SafeDatabaseViewer | null = null;
  let documentIndex: DocumentIndexStore | null = null;
  try {
    const files = new SafeFileService(config.approvedFileRoots);
    databaseViewer = new SafeDatabaseViewer(database.path);
    documentIndex = new DocumentIndexStore(database.path);
    credentialReader = new DatabaseSync(database.path, {
      allowExtension: false,
      readOnly: true,
    });
    credentialReader.exec("PRAGMA query_only = ON");
    credentialReader.exec("PRAGMA trusted_schema = OFF");
    const passwords = await createPasswordService();
    const repositories = createRepositories(database);
    const runtime = createRuntimeService({
      database,
      workspaceRoot: files.roots.workspace,
    });
    const now =
      options.clock ?? (() => new Date().toISOString() as IsoTimestamp);
    let closed = false;

    return {
      database,
      databaseViewer,
      documentIndex,
      files,
      repositories,
      runtime,
      passwords,
      now,
      async readPasswordHash(userId) {
        const row = credentialReader
          ?.prepare("SELECT password_hash FROM users WHERE id = ?")
          .get(userId) as { password_hash: string | null } | undefined;
        return row?.password_hash ?? null;
      },
      async close() {
        if (closed) return;
        closed = true;
        await runtime.stop();
        documentIndex?.close();
        documentIndex = null;
        databaseViewer?.close();
        databaseViewer = null;
        credentialReader?.close();
        credentialReader = null;
        database.close();
      },
    };
  } catch (error) {
    documentIndex?.close();
    databaseViewer?.close();
    credentialReader?.close();
    database.close();
    throw error;
  }
}
