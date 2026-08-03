# `@replicantos/runtime`

Restart-safe scheduling and normalized harness run coordination. This package
contains no database driver, HTTP server, polling daemon, or provider-specific
payload handling. Those boundaries are injected.

## Scheduler contract

`ScheduleCoordinator.tick()` atomically claims bounded due occurrences through
`ScheduleClaimRepositoryPort`. Each occurrence has a stable
`schedule/<id>/<scheduledFor>` idempotency key; `ScheduledRunRepositoryPort`
must enforce its uniqueness. Claim completion is fenced by an opaque token. If
the process stops after creating a run but before completing the claim, the
expired claim is reclaimed and resolves to the existing run instead of creating
a duplicate.

`nextCronOccurrence()` supports numeric five-field cron expressions with lists,
ranges, and steps. It uses the host's IANA timezone database. Nonexistent DST
wall minutes are skipped and repeated wall minutes map to both real instants.
Day-of-month and day-of-week use traditional cron OR semantics when both are
restricted. Search windows are caller-reducible and capped at eight leap-year
lengths to keep invalid schedules from creating unbounded work.

## Run coordination contract

`RunCoordinator` requires:

- a hardened `HarnessRegistry`;
- an injected `ApprovedCwdResolver` (the coordinator resolves cwd even though
  production adapters should use the same resolver themselves);
- `RunRepositoryPort`, whose leases fence state/event/finalization writes;
- `ApprovalRepositoryPort`, whose dispatch leases keep approval delivery
  fail-closed;
- explicit global and optional per-harness concurrency limits.

Normalized events are persisted with an execution-scoped idempotency key. The
repository atomically applies the supplied state, usage, assistant-text,
session, failure, or approval projection with each event. A recovered database
claim explicitly selects `start` or `resume` and supplies the next global event
sequence. An invocation that crashed before binding a resumable session is
externally ambiguous and must remain fail-closed; recovery must not select a new
`start` that could duplicate provider work. Lease heartbeats cancel provider
work when fencing is lost.

Retries are deterministic, exponential, and bounded to ten total attempts and
seven days. The first attempt counts toward `maxAttempts`; retry eligibility
comes from normalized `run.failed` events or the injected error classifier.

Approval dispatch cannot be made transactional with an external harness. The
port therefore records a dispatch lease, the coordinator delivers the decision,
and the repository idempotently completes it. If a process dies after delivery
but before completion, the database must leave the ambiguous dispatch
fail-closed for reconciliation rather than silently allowing the action again.

## Server integration

The server owns the recurring schedule/run poll loops, worker identity, graceful
shutdown, authorization before cancellation or approval decisions, and concrete
SQLite implementations of every repository port. SQLite claims should use
transactions plus unique constraints for occurrence/event keys and compare-and-
set updates for lease tokens. Run claims must honor retry `notBefore` instants,
exclude requested cancellations, and enforce global/per-harness lease counts in
the same transaction. The same approved-root resolver should be injected into
the coordinator and every registered adapter.
