import assert from "node:assert/strict";
import test from "node:test";

import {
  createRepositories,
  demoIds,
  openDatabase,
  safeDescendantPath,
  safeRelativePath,
  seedSyntheticDemo,
} from "../dist/index.js";
import { connectionFor } from "../dist/database.js";

const beforeExpiry = "2026-04-14T16:00:00.000Z";
const later = "2026-04-14T16:05:00.000Z";

function demoDatabase() {
  const database = openDatabase({
    path: ":memory:",
    clock: () => beforeExpiry,
  });
  seedSyntheticDemo(database);
  return database;
}

test("migration configures a complete, valid SQLite schema", () => {
  const database = openDatabase({
    path: ":memory:",
    clock: () => beforeExpiry,
  });
  try {
    assert.equal(database.schemaVersion(), 3);
    assert.equal(database.integrityCheck(), "ok");
    assert.deepEqual(
      connectionFor(database).prepare("PRAGMA foreign_key_check").all(),
      [],
    );
    const tables = connectionFor(database)
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
      )
      .all()
      .map((row) => row.name);
    for (const required of [
      "users",
      "sessions",
      "access_grants",
      "channels",
      "messages",
      "replicants",
      "tasks",
      "schedules",
      "runs",
      "runtime_run_controls",
      "runtime_run_executions",
      "runtime_schedule_occurrences",
      "runtime_run_message_deliveries",
      "approvals",
      "notifications",
      "artifacts",
      "audit_log",
    ]) {
      assert.ok(tables.includes(required), `missing ${required}`);
    }
  } finally {
    database.close();
  }
});

test("synthetic demo seed is deterministic and idempotent", () => {
  const first = openDatabase({ path: ":memory:", clock: () => beforeExpiry });
  const second = openDatabase({ path: ":memory:", clock: () => beforeExpiry });
  try {
    assert.equal(seedSyntheticDemo(first).applied, true);
    assert.equal(seedSyntheticDemo(first).applied, false);
    assert.equal(seedSyntheticDemo(second).applied, true);

    const snapshot = (database) =>
      connectionFor(database)
        .prepare(
          `SELECT 'users' AS source, id, display_name AS value FROM users
           UNION ALL SELECT 'replicants', id, name FROM replicants
           UNION ALL SELECT 'tasks', id, title FROM tasks
           UNION ALL SELECT 'messages', id, content FROM messages
           ORDER BY source, id`,
        )
        .all();
    assert.deepEqual(snapshot(first), snapshot(second));
    assert.equal(
      connectionFor(first).prepare("SELECT count(*) AS n FROM sessions").get()
        .n,
      0,
    );
    assert.equal(first.integrityCheck(), "ok");
  } finally {
    first.close();
    second.close();
  }
});

test("session repository accepts hashes only and enforces revocation", () => {
  const database = demoDatabase();
  try {
    const sessions = createRepositories(database).sessions;
    const tokenHash = "b".repeat(64);
    sessions.create({
      id: "ses_demo0001",
      userId: demoIds.member,
      tokenHash,
      createdAt: beforeExpiry,
      expiresAt: "2026-04-16T16:00:00.000Z",
      lastSeenAt: beforeExpiry,
      revokedAt: null,
    });
    assert.equal(sessions.resolve(tokenHash, later)?.userId, demoIds.member);
    assert.equal(sessions.revoke("ses_demo0001", later), true);
    assert.equal(sessions.resolve(tokenHash, later), null);
    assert.throws(
      () =>
        sessions.create({
          id: "ses_demo0002",
          userId: demoIds.member,
          tokenHash: "not-a-hash",
          createdAt: beforeExpiry,
          expiresAt: "2026-04-16T16:00:00.000Z",
          lastSeenAt: beforeExpiry,
          revokedAt: null,
        }),
      /lowercase hexadecimal digest/,
    );
  } finally {
    database.close();
  }
});

test("access grants can be loaded and revoked exactly once", () => {
  const database = demoDatabase();
  try {
    const grants = createRepositories(database).accessGrants;
    assert.equal(
      grants.get(demoIds.grantChannelRead)?.id,
      demoIds.grantChannelRead,
    );
    assert.equal(grants.revoke(demoIds.grantChannelRead, later), true);
    assert.equal(grants.get(demoIds.grantChannelRead)?.revokedAt, later);
    assert.equal(grants.revoke(demoIds.grantChannelRead, later), false);
    assert.equal(grants.get("grt_missing01"), null);
  } finally {
    database.close();
  }
});

test("artifact and Replicant paths reject traversal and absolute paths", () => {
  assert.equal(safeRelativePath("documents/demo.md"), "documents/demo.md");
  assert.equal(
    safeDescendantPath(
      "replicants/atlas/workspace",
      "replicants/atlas/workspace/memory",
    ),
    "replicants/atlas/workspace/memory",
  );
  for (const unsafe of [
    "../outside",
    "documents/../outside",
    "/host/path",
    "C:\\host\\path",
    "documents/new\nline",
    `documents/${"a".repeat(256)}`,
    `documents/${"a".repeat(1_024)}`,
    "documents/e\u0301.txt",
  ])
    assert.throws(() => safeRelativePath(unsafe));

  for (const memoryPath of [
    "replicants/atlas/workspace",
    "replicants/atlas/memory",
    "replicants/quill/workspace/memory",
  ]) {
    assert.throws(
      () => safeDescendantPath("replicants/atlas/workspace", memoryPath),
      /strict descendant/,
    );
  }

  const database = demoDatabase();
  try {
    assert.throws(
      () =>
        createRepositories(database).artifacts.create({
          id: "art_unsafe01",
          workspaceId: demoIds.workspace,
          kind: "document",
          name: "Unsafe",
          mediaType: "text/plain",
          relativePath: "../outside.txt",
          byteSize: 1,
          sha256: "c".repeat(64),
          searchable: false,
          createdByUserId: demoIds.owner,
          createdByReplicantId: null,
          metadata: {},
          createdAt: beforeExpiry,
          updatedAt: beforeExpiry,
        }),
      /traversal|relative POSIX/,
    );

    const replicants = createRepositories(database).replicants;
    const seeded = replicants.get(demoIds.replicantAtlas);
    assert.ok(seeded);
    assert.throws(
      () =>
        replicants.create({
          ...seeded,
          id: "rep_memory01",
          slug: "memory-outside-workspace",
          relativeWorkspacePath:
            "replicants/memory-outside-workspace/workspace",
          relativeMemoryPath: "replicants/memory-outside-workspace/memory",
        }),
      /strict descendant/,
    );
  } finally {
    database.close();
  }
});

test("schedule persistence accepts only runtime-compatible timing policies", () => {
  const database = demoDatabase();
  try {
    const schedules = createRepositories(database).schedules;
    const seeded = schedules.get(demoIds.schedule);
    assert.ok(seeded);
    const candidate = {
      ...seeded,
      id: "sch_policy001",
      name: "Synthetic policy validation",
    };
    assert.throws(
      () =>
        schedules.create({
          ...candidate,
          cronExpression: "0 9 * * * *",
        }),
      /five|minute|fields/i,
    );
    assert.throws(
      () =>
        schedules.create({
          ...candidate,
          timezone: "Not/A_Timezone",
        }),
      /timezone/i,
    );
    assert.throws(
      () =>
        schedules.create({
          ...candidate,
          retryPolicy: { maximumAttempts: 2 },
        }),
      /maximumAttempts|not supported/i,
    );
    const created = schedules.create({
      ...candidate,
      retryPolicy: { maxAttempts: 1 },
    });
    assert.deepEqual(created.retryPolicy, { maxAttempts: 1 });
    assert.deepEqual(schedules.get(candidate.id)?.retryPolicy, {
      initialDelayMs: 0,
      maxAttempts: 1,
      maxDelayMs: 604_800_000,
      multiplier: 2,
    });
  } finally {
    database.close();
  }
});

test("approvals are action-bound and can be consumed once", () => {
  const database = demoDatabase();
  try {
    const approvals = createRepositories(database).approvals;
    assert.equal(
      approvals.decide(
        demoIds.approval,
        "approved",
        demoIds.owner,
        beforeExpiry,
      ).status,
      "approved",
    );
    assert.throws(
      () => approvals.consume(demoIds.approval, "f".repeat(64), later),
      /does not match/,
    );
    assert.equal(
      approvals.consume(demoIds.approval, "a".repeat(64), later).status,
      "consumed",
    );
    assert.throws(
      () => approvals.consume(demoIds.approval, "a".repeat(64), later),
      /already been consumed|not approved/,
    );
  } finally {
    database.close();
  }
});

test("expired approvals fail closed and persist their terminal state", () => {
  const database = demoDatabase();
  try {
    const approvals = createRepositories(database).approvals;
    approvals.create({
      id: "apr_expired1",
      workspaceId: demoIds.workspace,
      runId: null,
      requestedBy: demoIds.member,
      action: "Synthetic expired action",
      actionDigest: "d".repeat(64),
      payload: {},
      status: "pending",
      expiresAt: "2026-04-14T15:00:00.000Z",
      decidedBy: null,
      decidedAt: null,
      consumedAt: null,
      createdAt: "2026-04-14T14:00:00.000Z",
    });
    assert.throws(
      () =>
        approvals.decide(
          "apr_expired1",
          "approved",
          demoIds.owner,
          beforeExpiry,
        ),
      /expired/,
    );
    assert.equal(approvals.get("apr_expired1")?.status, "expired");
  } finally {
    database.close();
  }
});

test("run transitions reject invalid state changes and preserve ordered events", () => {
  const database = demoDatabase();
  try {
    const runs = createRepositories(database).runs;
    runs.create({
      id: "run_active01",
      workspaceId: demoIds.workspace,
      replicantId: demoIds.replicantAtlas,
      channelId: demoIds.channelOps,
      taskId: null,
      scheduleId: null,
      parentRunId: null,
      trigger: "manual",
      status: "queued",
      harness: "opencode",
      model: null,
      effort: null,
      harnessSessionKey: null,
      requestedBy: demoIds.owner,
      createdAt: beforeExpiry,
      startedAt: null,
      finishedAt: null,
      inputTokens: null,
      outputTokens: null,
      costMicros: null,
      errorCode: null,
      errorMessage: null,
    });
    assert.throws(
      () => runs.transition("run_active01", { status: "succeeded", at: later }),
      /Invalid run transition/,
    );
    runs.transition("run_active01", { status: "starting", at: later });
    assert.equal(
      runs.transition("run_active01", { status: "running", at: later }).status,
      "running",
    );
    runs.appendEvent({
      id: "evt_active01",
      runId: "run_active01",
      sequence: 0,
      type: "run.started",
      payload: { synthetic: true },
      createdAt: later,
    });
    assert.deepEqual(
      runs.listEvents("run_active01").map((event) => event.sequence),
      [0],
    );
  } finally {
    database.close();
  }
});

test("audit records are append-only at the database boundary", () => {
  const database = demoDatabase();
  try {
    const connection = connectionFor(database);
    assert.throws(
      () =>
        connection
          .prepare("UPDATE audit_log SET action = ? WHERE id = ?")
          .run("changed", demoIds.audit),
      /immutable/,
    );
    assert.throws(
      () =>
        connection
          .prepare("DELETE FROM audit_log WHERE id = ?")
          .run(demoIds.audit),
      /immutable/,
    );
    assert.equal(
      createRepositories(database).audit.get(demoIds.audit)?.action,
      "demo.seeded",
    );
  } finally {
    database.close();
  }
});

test("foreign keys and owner invariants fail closed", () => {
  const database = demoDatabase();
  try {
    const repositories = createRepositories(database);
    assert.throws(
      () => repositories.users.setStatus(demoIds.owner, "disabled", later),
      /owner cannot be disabled/,
    );
    assert.throws(
      () =>
        repositories.messages.create({
          id: "msg_invalid1",
          channelId: "chn_missing1",
          replyToId: null,
          authorKind: "user",
          authorUserId: demoIds.member,
          authorReplicantId: null,
          content: "This insert must fail.",
          editedAt: null,
          deletedAt: null,
          createdAt: later,
        }),
      /FOREIGN KEY/,
    );
  } finally {
    database.close();
  }
});
