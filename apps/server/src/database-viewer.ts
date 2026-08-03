import { DatabaseSync } from "node:sqlite";

import type { JsonValue, WorkspaceId } from "@replicantos/core";

import { HttpError } from "./errors.js";

interface ViewerColumn {
  name: string;
  expression: string;
  masked?: true;
}

interface ViewerTableDefinition {
  orderBy: string;
  workspacePredicate: string;
  columns: readonly ViewerColumn[];
}

const masked = (name: string): ViewerColumn => ({
  name,
  expression: "'[masked]'",
  masked: true,
});

const column = (name: string): ViewerColumn => ({
  name,
  expression: `"${name}"`,
});

const VIEWER_TABLES = Object.freeze({
  workspaces: {
    orderBy: "id",
    workspacePredicate: '"id" = ?',
    columns: [
      column("id"),
      column("slug"),
      masked("display_name"),
      column("created_at"),
    ],
  },
  users: {
    orderBy: "id",
    workspacePredicate: '"workspace_id" = ?',
    columns: [
      column("id"),
      column("kind"),
      masked("handle"),
      masked("display_name"),
      column("role"),
      column("status"),
      masked("password_hash"),
      column("created_at"),
      column("updated_at"),
    ],
  },
  channels: {
    orderBy: "id",
    workspacePredicate: '"workspace_id" = ?',
    columns: [
      column("id"),
      column("category_id"),
      column("kind"),
      masked("slug"),
      masked("name"),
      masked("description"),
      column("archived_at"),
      column("created_at"),
      column("updated_at"),
    ],
  },
  messages: {
    orderBy: "id",
    workspacePredicate:
      'EXISTS (SELECT 1 FROM "channels" AS "viewer_channels" WHERE "viewer_channels"."id" = "messages"."channel_id" AND "viewer_channels"."workspace_id" = ?)',
    columns: [
      column("id"),
      column("channel_id"),
      column("reply_to_id"),
      column("author_kind"),
      column("author_user_id"),
      column("author_replicant_id"),
      masked("content"),
      column("edited_at"),
      column("deleted_at"),
      column("created_at"),
    ],
  },
  replicants: {
    orderBy: "id",
    workspacePredicate: '"workspace_id" = ?',
    columns: [
      column("id"),
      masked("slug"),
      masked("name"),
      masked("description"),
      masked("persona"),
      column("default_harness"),
      column("default_model"),
      masked("relative_workspace_path"),
      masked("relative_memory_path"),
      column("status"),
      column("created_at"),
      column("updated_at"),
    ],
  },
  projects: {
    orderBy: "id",
    workspacePredicate: '"workspace_id" = ?',
    columns: [
      column("id"),
      masked("slug"),
      masked("name"),
      masked("description"),
      column("created_at"),
      column("updated_at"),
    ],
  },
  tasks: {
    orderBy: "id",
    workspacePredicate: '"workspace_id" = ?',
    columns: [
      column("id"),
      column("project_id"),
      masked("title"),
      masked("notes"),
      column("status"),
      column("priority"),
      column("due_at"),
      column("assignee_user_id"),
      column("assignee_replicant_id"),
      column("created_at"),
      column("updated_at"),
      column("completed_at"),
    ],
  },
  schedules: {
    orderBy: "id",
    workspacePredicate: '"workspace_id" = ?',
    columns: [
      column("id"),
      masked("name"),
      masked("description"),
      column("cron_expression"),
      column("timezone"),
      column("status"),
      column("replicant_id"),
      column("channel_id"),
      column("task_id"),
      column("harness_override"),
      column("model_override"),
      column("effort_override"),
      masked("prompt"),
      masked("retry_policy_json"),
      masked("outcome_assertions_json"),
      column("next_run_at"),
      column("last_run_at"),
      column("created_at"),
      column("updated_at"),
    ],
  },
  runs: {
    orderBy: "id",
    workspacePredicate: '"workspace_id" = ?',
    columns: [
      column("id"),
      column("replicant_id"),
      column("channel_id"),
      column("task_id"),
      column("schedule_id"),
      column("parent_run_id"),
      column("trigger_type"),
      column("status"),
      column("harness"),
      column("model"),
      column("effort"),
      masked("harness_session_key"),
      column("created_at"),
      column("started_at"),
      column("finished_at"),
      column("input_tokens"),
      column("output_tokens"),
      column("cost_micros"),
      column("error_code"),
      masked("error_message"),
    ],
  },
  notifications: {
    orderBy: "id",
    workspacePredicate: '"workspace_id" = ?',
    columns: [
      column("id"),
      column("recipient_user_id"),
      column("kind"),
      masked("title"),
      masked("body"),
      column("resource_type"),
      masked("resource_id"),
      column("created_at"),
      column("read_at"),
    ],
  },
  artifacts: {
    orderBy: "id",
    workspacePredicate: '"workspace_id" = ?',
    columns: [
      column("id"),
      column("kind"),
      masked("name"),
      column("media_type"),
      masked("relative_path"),
      column("byte_size"),
      masked("sha256"),
      column("searchable"),
      column("created_at"),
      column("updated_at"),
    ],
  },
  audit_log: {
    orderBy: "id",
    workspacePredicate: '"workspace_id" = ?',
    columns: [
      column("id"),
      column("actor_kind"),
      column("actor_user_id"),
      column("action"),
      column("resource_type"),
      masked("resource_id"),
      column("request_id"),
      masked("detail_json"),
      column("created_at"),
    ],
  },
} satisfies Record<string, ViewerTableDefinition>);

export type ViewerTable = keyof typeof VIEWER_TABLES;

export interface ViewerTableDescription {
  name: ViewerTable;
  columns: readonly { name: string; masked: boolean }[];
}

export interface ViewerPage {
  table: ViewerTable;
  rows: readonly Record<string, JsonValue>[];
  nextOffset: number | null;
}

function jsonValue(value: unknown): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "bigint") return value.toString();
  return String(value);
}

export class SafeDatabaseViewer {
  #database: DatabaseSync | null;

  constructor(databasePath: string) {
    this.#database = new DatabaseSync(databasePath, {
      allowExtension: false,
      readOnly: true,
    });
    this.#database.exec("PRAGMA query_only = ON");
    this.#database.exec("PRAGMA trusted_schema = OFF");
  }

  tables(): ViewerTableDescription[] {
    return (
      Object.entries(VIEWER_TABLES) as Array<
        [ViewerTable, ViewerTableDefinition]
      >
    ).map(([name, definition]) => ({
      name,
      columns: definition.columns.map((entry) => ({
        name: entry.name,
        masked: entry.masked === true,
      })),
    }));
  }

  rows(
    table: string,
    workspaceId: WorkspaceId,
    limit: number,
    offset: number,
  ): ViewerPage {
    if (!Object.hasOwn(VIEWER_TABLES, table)) {
      throw new HttpError(
        404,
        "not_found",
        "The requested table is not available.",
      );
    }
    const tableName = table as ViewerTable;
    const definition = VIEWER_TABLES[tableName];
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new HttpError(400, "invalid_request", "The row limit is invalid.");
    }
    if (!Number.isInteger(offset) || offset < 0 || offset > 100_000) {
      throw new HttpError(400, "invalid_request", "The row offset is invalid.");
    }
    if (this.#database === null) throw new Error("Database viewer is closed");

    // Identifiers and expressions come only from the frozen allowlist above.
    // The request-controlled workspace and pagination values are all bound.
    const select = definition.columns
      .map((entry) => `${entry.expression} AS "${entry.name}"`)
      .join(", ");
    const statement = this.#database.prepare(
      `SELECT ${select} FROM "${tableName}" WHERE ${definition.workspacePredicate} ORDER BY "${definition.orderBy}" LIMIT ? OFFSET ?`,
    );
    const rows = statement.all(workspaceId, limit, offset) as Array<
      Record<string, unknown>
    >;
    return {
      table: tableName,
      rows: rows.map((row) =>
        Object.fromEntries(
          Object.entries(row).map(([key, value]) => [key, jsonValue(value)]),
        ),
      ),
      nextOffset:
        rows.length === limit && offset + rows.length <= 100_000
          ? offset + rows.length
          : null,
    };
  }

  close(): void {
    this.#database?.close();
    this.#database = null;
  }
}
