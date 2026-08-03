import { useCallback, useEffect, useMemo, useState } from "react";

import {
  api,
  type Approval,
  jsonBody,
  type Replicant,
  type Run,
  type RunDetail,
} from "./api.js";

const cancellableStatuses = new Set<Run["status"]>([
  "queued",
  "starting",
  "running",
  "awaiting-approval",
]);

interface LiveRunsProps {
  canManage: boolean;
  onFailure(error: unknown): void;
  onRunsChanged(): Promise<void>;
  replicants: Replicant[];
  runs: Run[];
}

function runTime(run: Run): string {
  const instant = run.finishedAt ?? run.startedAt ?? run.createdAt;
  return new Date(instant).toLocaleString();
}

function tokenCount(value: number | null): string {
  return value === null ? "Unavailable" : value.toLocaleString();
}

function cost(value: number | null): string {
  return value === null ? "Unavailable" : `$${(value / 1_000_000).toFixed(4)}`;
}

export function LiveRuns({
  canManage,
  onFailure,
  onRunsChanged,
  replicants,
  runs,
}: LiveRunsProps) {
  const [selectedRunId, setSelectedRunId] = useState<string | null>(
    runs[0]?.id ?? null,
  );
  const [detail, setDetail] = useState<RunDetail | null>(null);
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [loadingApprovals, setLoadingApprovals] = useState(false);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const replicantNames = useMemo(
    () =>
      new Map(replicants.map((replicant) => [replicant.id, replicant.name])),
    [replicants],
  );

  const loadDetail = useCallback(
    async (runId: string, showLoading = true) => {
      if (showLoading) setLoadingDetail(true);
      try {
        const result = await api<RunDetail>(
          `/runs/${encodeURIComponent(runId)}`,
        );
        setDetail(result);
      } catch (error) {
        onFailure(error);
      } finally {
        if (showLoading) setLoadingDetail(false);
      }
    },
    [onFailure],
  );

  const loadApprovals = useCallback(async () => {
    if (!canManage) {
      setApprovals([]);
      return;
    }
    setLoadingApprovals(true);
    try {
      const result = await api<{ items: Approval[] }>("/approvals?limit=100");
      setApprovals(result.items);
    } catch (error) {
      onFailure(error);
    } finally {
      setLoadingApprovals(false);
    }
  }, [canManage, onFailure]);

  useEffect(() => {
    if (
      selectedRunId !== null &&
      runs.some((run) => run.id === selectedRunId)
    ) {
      return;
    }
    setSelectedRunId(runs[0]?.id ?? null);
  }, [runs, selectedRunId]);

  useEffect(() => {
    if (selectedRunId === null) {
      setDetail(null);
      return;
    }
    setDetail(null);
    void loadDetail(selectedRunId);
  }, [loadDetail, selectedRunId]);

  useEffect(() => {
    void loadApprovals();
  }, [loadApprovals]);

  useEffect(() => {
    if (
      selectedRunId === null ||
      detail === null ||
      !cancellableStatuses.has(detail.run.status)
    ) {
      return;
    }
    const runId = selectedRunId;
    const polling = window.setInterval(() => {
      void Promise.all([loadDetail(runId, false), onRunsChanged()]).catch(
        onFailure,
      );
    }, 3_000);
    return () => window.clearInterval(polling);
  }, [detail, loadDetail, onFailure, onRunsChanged, selectedRunId]);

  async function cancelRun(run: Run) {
    setPendingAction(`cancel:${run.id}`);
    setNotice(null);
    try {
      const result = await api<{
        cancellation: "recorded" | "terminal";
        runId: string;
      }>(`/runs/${encodeURIComponent(run.id)}/cancel`, {
        body: jsonBody({}),
        method: "POST",
      });
      setNotice(
        result.cancellation === "recorded"
          ? "Cancellation requested. Runtime state will refresh from durable storage."
          : "The run was already terminal; no cancellation was sent.",
      );
      await Promise.all([loadDetail(run.id, false), onRunsChanged()]);
    } catch (error) {
      onFailure(error);
    } finally {
      setPendingAction(null);
    }
  }

  async function decide(approval: Approval, decision: "approved" | "denied") {
    setPendingAction(`approval:${approval.id}`);
    setNotice(null);
    try {
      await api(`/approvals/${encodeURIComponent(approval.id)}/decision`, {
        body: jsonBody({ decision }),
        method: "POST",
      });
      setNotice(
        decision === "approved"
          ? "Approval allowed and dispatched."
          : "Approval denied and dispatched.",
      );
      await Promise.all([
        loadApprovals(),
        approval.runId === null || approval.runId !== selectedRunId
          ? Promise.resolve()
          : loadDetail(approval.runId, false),
        onRunsChanged(),
      ]);
    } catch (error) {
      onFailure(error);
    } finally {
      setPendingAction(null);
    }
  }

  const selectedDetail = detail?.run.id === selectedRunId ? detail : null;

  return (
    <section className="module-view live-runs">
      <div className="stats-row">
        <div className="stat">
          <small>HISTORY</small>
          <strong>{String(runs.length).padStart(2, "0")}</strong>
        </div>
        <div className="stat">
          <small>ACTIVE</small>
          <strong>
            {String(
              runs.filter((run) => cancellableStatuses.has(run.status)).length,
            ).padStart(2, "0")}
          </strong>
        </div>
        <div className="stat">
          <small>PENDING APPROVALS</small>
          <strong>
            {canManage ? String(approvals.length).padStart(2, "0") : "—"}
          </strong>
        </div>
        <div className="stat">
          <small>SOURCE</small>
          <strong>DURABLE</strong>
        </div>
      </div>

      <div className="module-toolbar">
        <div>
          <button className="active" type="button">
            RUN HISTORY
          </button>
        </div>
        <button
          onClick={() =>
            void Promise.all([onRunsChanged(), loadApprovals()]).catch(
              onFailure,
            )
          }
          type="button"
        >
          REFRESH
        </button>
      </div>

      <div className="runs-workspace">
        <div className="run-history" aria-label="Durable run history">
          {runs.length === 0 ? (
            <p className="live-empty">No readable runs have been recorded.</p>
          ) : (
            runs.map((run) => (
              <button
                aria-pressed={selectedRunId === run.id}
                className={selectedRunId === run.id ? "selected" : ""}
                key={run.id}
                onClick={() => {
                  setNotice(null);
                  setSelectedRunId(run.id);
                }}
                type="button"
              >
                <span className={`run-status ${run.status}`}>{run.status}</span>
                <strong>
                  {replicantNames.get(run.replicantId) ?? "Replicant"}
                </strong>
                <small>
                  {run.harness} · {run.trigger}
                </small>
                <time dateTime={run.finishedAt ?? run.createdAt}>
                  {runTime(run)}
                </time>
              </button>
            ))
          )}
        </div>

        <div className="run-detail" aria-label="Run detail">
          {loadingDetail && selectedDetail === null ? (
            <p>Loading durable run detail…</p>
          ) : null}
          {!loadingDetail && selectedRunId === null ? (
            <p>Select a run to inspect its durable projection.</p>
          ) : null}
          {selectedDetail ? (
            <>
              <header>
                <div>
                  <small>RUN DETAIL</small>
                  <h2>
                    {replicantNames.get(selectedDetail.run.replicantId) ??
                      "Replicant run"}
                  </h2>
                  <code>{selectedDetail.run.id}</code>
                </div>
                <span className={`run-status ${selectedDetail.run.status}`}>
                  {selectedDetail.run.status}
                </span>
              </header>

              <div className="run-facts">
                <div>
                  <small>HARNESS</small>
                  <strong>{selectedDetail.run.harness}</strong>
                </div>
                <div>
                  <small>MODEL</small>
                  <strong>
                    {selectedDetail.run.model ?? "Provider default"}
                  </strong>
                </div>
                <div>
                  <small>STARTED</small>
                  <strong>
                    {selectedDetail.run.startedAt
                      ? new Date(selectedDetail.run.startedAt).toLocaleString()
                      : "Not started"}
                  </strong>
                </div>
                <div>
                  <small>FINISHED</small>
                  <strong>
                    {selectedDetail.run.finishedAt
                      ? new Date(selectedDetail.run.finishedAt).toLocaleString()
                      : "Not finished"}
                  </strong>
                </div>
              </div>

              {selectedDetail.projection ? (
                <section className="run-projection">
                  <header>
                    <div>
                      <small>DURABLE RUNTIME PROJECTION</small>
                      <h3>{selectedDetail.projection.status}</h3>
                    </div>
                    {canManage &&
                    cancellableStatuses.has(selectedDetail.run.status) ? (
                      <button
                        disabled={
                          pendingAction === `cancel:${selectedDetail.run.id}` ||
                          selectedDetail.projection.cancellationRequestedAt !==
                            null
                        }
                        onClick={() => void cancelRun(selectedDetail.run)}
                        type="button"
                      >
                        {selectedDetail.projection.cancellationRequestedAt
                          ? "CANCELLATION REQUESTED"
                          : "CANCEL RUN"}
                      </button>
                    ) : null}
                  </header>
                  <div>
                    <span>
                      INPUT {tokenCount(selectedDetail.projection.inputTokens)}
                    </span>
                    <span>
                      CACHED{" "}
                      {tokenCount(selectedDetail.projection.cachedInputTokens)}
                    </span>
                    <span>
                      OUTPUT{" "}
                      {tokenCount(selectedDetail.projection.outputTokens)}
                    </span>
                    <span>
                      COST {cost(selectedDetail.projection.costMicros)}
                    </span>
                  </div>
                  {selectedDetail.projection.assistantText ? (
                    <article>
                      <small>PERSISTED ASSISTANT OUTPUT</small>
                      <p>{selectedDetail.projection.assistantText}</p>
                    </article>
                  ) : (
                    <p>No persisted assistant output yet.</p>
                  )}
                </section>
              ) : (
                <p className="run-no-projection">
                  This run has no runtime projection. It may predate runtime
                  execution or have been queued outside the active worker.
                </p>
              )}

              {selectedDetail.run.errorMessage ? (
                <p className="run-error" role="status">
                  {selectedDetail.run.errorCode ?? "run_failed"}:{" "}
                  {selectedDetail.run.errorMessage}
                </p>
              ) : null}

              <section className="run-events">
                <h3>PERSISTED EVENTS</h3>
                {selectedDetail.events.length === 0 ? (
                  <p>No run events recorded.</p>
                ) : (
                  selectedDetail.events.map((event) => (
                    <article key={event.id}>
                      <code>{String(event.sequence).padStart(3, "0")}</code>
                      <strong>{event.type}</strong>
                      <time dateTime={event.createdAt}>
                        {new Date(event.createdAt).toLocaleString()}
                      </time>
                    </article>
                  ))
                )}
              </section>
            </>
          ) : null}
        </div>
      </div>

      {canManage ? (
        <section className="approval-queue" aria-label="Pending approvals">
          <header>
            <div>
              <small>PROVIDER DECISIONS</small>
              <h2>Pending approvals</h2>
            </div>
            <button
              disabled={loadingApprovals}
              onClick={() => void loadApprovals()}
              type="button"
            >
              REFRESH APPROVALS
            </button>
          </header>
          {loadingApprovals && approvals.length === 0 ? (
            <p>Loading pending approvals…</p>
          ) : null}
          {!loadingApprovals && approvals.length === 0 ? (
            <p>No pending approvals.</p>
          ) : null}
          {approvals.map((approval) => (
            <article key={approval.id}>
              <div>
                <strong>{approval.action}</strong>
                <code>{approval.runId ?? "No linked run"}</code>
                <small>
                  Expires {new Date(approval.expiresAt).toLocaleString()}
                </small>
              </div>
              <div>
                <button
                  disabled={pendingAction === `approval:${approval.id}`}
                  onClick={() => void decide(approval, "denied")}
                  type="button"
                >
                  DENY
                </button>
                <button
                  className="primary-button"
                  disabled={pendingAction === `approval:${approval.id}`}
                  onClick={() => void decide(approval, "approved")}
                  type="button"
                >
                  ALLOW
                </button>
              </div>
            </article>
          ))}
        </section>
      ) : null}

      {notice ? (
        <p className="settings-notice" role="status">
          {notice}
        </p>
      ) : null}
    </section>
  );
}
