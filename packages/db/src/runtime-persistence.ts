import type { ReplicantDatabase } from "./database.ts";
import { SqliteRuntimeApprovalRepository } from "./runtime-approval-repository.ts";
import { SqliteRuntimeRunRepository } from "./runtime-run-repository.ts";
import { SqliteRuntimeScheduleRepository } from "./runtime-schedule-repository.ts";
import {
  createRuntimeRepositoryContext,
  type SqliteRuntimeRepositoryOptions,
} from "./runtime-support.ts";

export interface SqliteRuntimeRepositories {
  schedules: SqliteRuntimeScheduleRepository;
  runs: SqliteRuntimeRunRepository;
  approvals: SqliteRuntimeApprovalRepository;
}

export function createRuntimeRepositories(
  database: ReplicantDatabase,
  options: SqliteRuntimeRepositoryOptions,
): SqliteRuntimeRepositories {
  const context = createRuntimeRepositoryContext(database, options);
  return {
    schedules: new SqliteRuntimeScheduleRepository(context),
    runs: new SqliteRuntimeRunRepository(context),
    approvals: new SqliteRuntimeApprovalRepository(context),
  };
}

export type {
  RuntimeCwdContext,
  RuntimeIdKind,
  SqliteRuntimeRepositoryOptions,
} from "./runtime-support.ts";
