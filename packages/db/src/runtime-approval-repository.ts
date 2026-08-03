import type {
  ApprovalDispatchClaim,
  ApprovalRepositoryPort,
  ClaimApprovalDecisionResult,
} from "@replicantos/runtime";

import { connectionFor } from "./database.ts";
import {
  parseStoredJson,
  runtimeInstant,
  runtimeText,
  stableJsonText,
  type RuntimeRepositoryContext,
} from "./runtime-support.ts";

type ApprovalDecision = ApprovalDispatchClaim["decision"];

export interface RuntimeApprovalRecord {
  approvalId: string;
  runId: string;
  status: "dispatched" | "dispatching" | "pending";
  decision: ApprovalDecision | null;
  dispatchToken: string | null;
  leaseUntil: string | null;
  completedAt: string | null;
  lastErrorCode: string | null;
}

export class SqliteRuntimeApprovalRepository implements ApprovalRepositoryPort {
  constructor(private readonly context: RuntimeRepositoryContext) {}

  async claimDecisionDispatch(input: {
    runId: string;
    approvalId: string;
    decision: ApprovalDecision;
    leaseOwner: string;
    now: string;
    leaseUntil: string;
  }): Promise<ClaimApprovalDecisionResult> {
    const runId = runtimeText(input.runId, "approval run id", 500);
    const approvalId = runtimeText(input.approvalId, "approval id", 1_000);
    const owner = runtimeText(input.leaseOwner, "approval lease owner", 500);
    const now = runtimeInstant(input.now, "approval decision now");
    const leaseUntil = runtimeInstant(
      input.leaseUntil,
      "approval decision leaseUntil",
    );
    if (leaseUntil <= now) {
      throw new RangeError("approval leaseUntil must follow now");
    }
    const decisionJson = stableJsonText(input.decision);

    return this.context.database.transaction(() => {
      const connection = connectionFor(this.context.database);
      const row = connection
        .prepare(
          `SELECT a.status, a.decision_json, r.status AS run_status
           FROM runtime_run_approvals a
           JOIN runs r ON r.id = a.run_id
           WHERE a.approval_id = ? AND a.run_id = ?`,
        )
        .get(approvalId, runId) as
        | { status: string; decision_json: string | null; run_status: string }
        | undefined;
      if (row === undefined) return { status: "not-found" };
      if (row.status === "dispatched") {
        return row.decision_json === decisionJson
          ? { status: "already-dispatched" }
          : { status: "not-pending" };
      }
      // A dispatching row is never automatically reclaimed: the provider may
      // have received its decision even when the completion write was lost.
      if (row.status !== "pending" || row.run_status !== "awaiting-approval") {
        return { status: "not-pending" };
      }
      const dispatchToken = this.context.id("approval-dispatch");
      const claimed = connection
        .prepare(
          `UPDATE runtime_run_approvals
           SET status = 'dispatching', decision_json = ?, dispatch_token = ?,
             lease_owner = ?, lease_until = ?, last_error_code = NULL,
             updated_at = ?
           WHERE approval_id = ? AND run_id = ? AND status = 'pending'`,
        )
        .run(
          decisionJson,
          dispatchToken,
          owner,
          leaseUntil,
          now,
          approvalId,
          runId,
        );
      if (claimed.changes !== 1) return { status: "not-pending" };
      return {
        status: "dispatch",
        claim: { dispatchToken, runId, approvalId, decision: input.decision },
      };
    });
  }

  async completeDecisionDispatch(input: {
    dispatchToken: string;
    completedAt: string;
  }): Promise<"completed" | "stale"> {
    const dispatchToken = runtimeText(
      input.dispatchToken,
      "approval dispatch token",
      500,
    );
    const completedAt = runtimeInstant(
      input.completedAt,
      "approval dispatch completedAt",
    );
    return this.context.database.transaction(() => {
      const connection = connectionFor(this.context.database);
      const row = connection
        .prepare(
          `SELECT run_id FROM runtime_run_approvals
           WHERE dispatch_token = ? AND status = 'dispatching'`,
        )
        .get(dispatchToken) as { run_id: string } | undefined;
      if (row === undefined) return "stale";
      const completed = connection
        .prepare(
          `UPDATE runtime_run_approvals
           SET status = 'dispatched', completed_at = ?, updated_at = ?
           WHERE dispatch_token = ? AND status = 'dispatching'`,
        )
        .run(completedAt, completedAt, dispatchToken);
      if (completed.changes !== 1) return "stale";
      connection
        .prepare(
          `UPDATE runs SET status = 'running', finished_at = NULL
           WHERE id = ? AND status = 'awaiting-approval'`,
        )
        .run(row.run_id);
      return "completed";
    });
  }

  async releaseDecisionDispatch(input: {
    dispatchToken: string;
    releasedAt: string;
    errorCode: string;
  }): Promise<void> {
    const dispatchToken = runtimeText(
      input.dispatchToken,
      "approval dispatch token",
      500,
    );
    const releasedAt = runtimeInstant(
      input.releasedAt,
      "approval dispatch releasedAt",
    );
    const errorCode = runtimeText(
      input.errorCode,
      "approval dispatch error code",
      200,
    );
    connectionFor(this.context.database)
      .prepare(
        `UPDATE runtime_run_approvals
         SET status = 'pending', decision_json = NULL, dispatch_token = NULL,
           lease_owner = NULL, lease_until = NULL, completed_at = NULL,
           last_error_code = ?, updated_at = ?
         WHERE dispatch_token = ? AND status = 'dispatching'`,
      )
      .run(errorCode, releasedAt, dispatchToken);
  }

  get(approvalIdValue: string): RuntimeApprovalRecord | null {
    const approvalId = runtimeText(approvalIdValue, "approval id", 1_000);
    const row = connectionFor(this.context.database)
      .prepare(
        `SELECT approval_id, run_id, status, decision_json, dispatch_token,
           lease_until, completed_at, last_error_code
         FROM runtime_run_approvals WHERE approval_id = ?`,
      )
      .get(approvalId) as Record<string, unknown> | undefined;
    if (row === undefined) return null;
    return {
      approvalId: row.approval_id as string,
      runId: row.run_id as string,
      status: row.status as RuntimeApprovalRecord["status"],
      decision:
        row.decision_json === null
          ? null
          : (parseStoredJson(row.decision_json as string) as ApprovalDecision),
      dispatchToken: row.dispatch_token as string | null,
      leaseUntil: row.lease_until as string | null,
      completedAt: row.completed_at as string | null,
      lastErrorCode: row.last_error_code as string | null,
    };
  }
}
