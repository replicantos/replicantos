export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export const migrations: readonly Migration[] = [
  {
    version: 1,
    name: "initial_public_schema",
    sql: String.raw`
CREATE TABLE workspaces (
  id TEXT PRIMARY KEY,
  singleton INTEGER NOT NULL DEFAULT 1 UNIQUE CHECK (singleton = 1),
  slug TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE workspace_settings (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  value_json TEXT NOT NULL CHECK (json_valid(value_json)),
  updated_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, key)
) STRICT;

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('human', 'service')),
  handle TEXT NOT NULL COLLATE NOCASE,
  display_name TEXT NOT NULL,
  password_hash TEXT,
  role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'member', 'service')),
  status TEXT NOT NULL CHECK (status IN ('active', 'suspended', 'disabled')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (workspace_id, handle),
  CHECK ((kind = 'service' AND role = 'service' AND password_hash IS NULL) OR kind = 'human')
) STRICT;

CREATE UNIQUE INDEX one_active_owner_per_workspace
  ON users(workspace_id)
  WHERE role = 'owner' AND status = 'active';

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE CHECK (length(token_hash) = 64 AND token_hash NOT GLOB '*[^0-9a-f]*'),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  revoked_at TEXT,
  CHECK (expires_at > created_at)
) STRICT;

CREATE INDEX sessions_active_lookup ON sessions(token_hash, expires_at) WHERE revoked_at IS NULL;

CREATE TABLE access_grants (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  subject_type TEXT NOT NULL CHECK (subject_type IN ('user', 'role')),
  subject_user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  subject_role TEXT CHECK (subject_role IN ('owner', 'admin', 'member', 'service')),
  permission TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT,
  effect TEXT NOT NULL CHECK (effect IN ('allow', 'deny')),
  reason TEXT,
  created_by TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  expires_at TEXT,
  revoked_at TEXT,
  CHECK (
    (subject_type = 'user' AND subject_user_id IS NOT NULL AND subject_role IS NULL) OR
    (subject_type = 'role' AND subject_user_id IS NULL AND subject_role IS NOT NULL)
  ),
  CHECK (resource_type = substr(permission, 1, instr(permission, ':') - 1)),
  CHECK (expires_at IS NULL OR expires_at > created_at)
) STRICT;

CREATE INDEX grants_for_user ON access_grants(subject_user_id, permission, resource_type, resource_id)
  WHERE revoked_at IS NULL;
CREATE INDEX grants_for_role ON access_grants(subject_role, permission, resource_type, resource_id)
  WHERE revoked_at IS NULL;

CREATE TABLE categories (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0 CHECK (position >= 0),
  created_at TEXT NOT NULL,
  UNIQUE (workspace_id, name)
) STRICT;

CREATE TABLE channels (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  category_id TEXT REFERENCES categories(id) ON DELETE SET NULL,
  kind TEXT NOT NULL CHECK (kind IN ('standard', 'direct', 'system')),
  slug TEXT NOT NULL COLLATE NOCASE,
  name TEXT NOT NULL,
  description TEXT,
  archived_at TEXT,
  created_by TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (workspace_id, slug)
) STRICT;

CREATE TABLE replicants (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  slug TEXT NOT NULL COLLATE NOCASE,
  name TEXT NOT NULL,
  description TEXT,
  persona TEXT NOT NULL,
  default_harness TEXT NOT NULL,
  default_model TEXT,
  relative_workspace_path TEXT NOT NULL,
  relative_memory_path TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'paused', 'archived')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (workspace_id, slug),
  UNIQUE (workspace_id, relative_workspace_path),
  UNIQUE (workspace_id, relative_memory_path)
) STRICT;

CREATE TABLE replicant_channel_bindings (
  id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  replicant_id TEXT NOT NULL REFERENCES replicants(id) ON DELETE CASCADE,
  behavior TEXT NOT NULL CHECK (behavior IN ('automatic', 'mention-only', 'listen-only', 'disabled')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (channel_id, replicant_id)
) STRICT;

CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  reply_to_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
  author_kind TEXT NOT NULL CHECK (author_kind IN ('user', 'replicant', 'system')),
  author_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  author_replicant_id TEXT REFERENCES replicants(id) ON DELETE SET NULL,
  content TEXT NOT NULL CHECK (length(content) <= 100000),
  edited_at TEXT,
  deleted_at TEXT,
  created_at TEXT NOT NULL,
  CHECK (
    (author_kind = 'user' AND author_user_id IS NOT NULL AND author_replicant_id IS NULL) OR
    (author_kind = 'replicant' AND author_user_id IS NULL AND author_replicant_id IS NOT NULL) OR
    (author_kind = 'system' AND author_user_id IS NULL AND author_replicant_id IS NULL)
  )
) STRICT;

CREATE INDEX messages_by_channel ON messages(channel_id, created_at DESC, id DESC);
CREATE INDEX message_replies ON messages(reply_to_id) WHERE reply_to_id IS NOT NULL;

CREATE TABLE message_reactions (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reaction TEXT NOT NULL CHECK (length(reaction) BETWEEN 1 AND 32),
  created_at TEXT NOT NULL,
  UNIQUE (message_id, user_id, reaction)
) STRICT;

CREATE TABLE message_tags (
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  tag TEXT NOT NULL COLLATE NOCASE CHECK (length(tag) BETWEEN 1 AND 64),
  PRIMARY KEY (message_id, tag)
) STRICT;

CREATE TABLE channel_reads (
  channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  last_read_message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
  last_read_at TEXT NOT NULL,
  PRIMARY KEY (channel_id, user_id)
) STRICT;

CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  slug TEXT NOT NULL COLLATE NOCASE,
  name TEXT NOT NULL,
  description TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (workspace_id, slug)
) STRICT;

CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  notes TEXT,
  status TEXT NOT NULL CHECK (status IN ('backlog', 'ready', 'active', 'blocked', 'done', 'canceled')),
  priority TEXT NOT NULL CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  due_at TEXT,
  assignee_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  assignee_replicant_id TEXT REFERENCES replicants(id) ON DELETE SET NULL,
  created_by TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  CHECK (assignee_user_id IS NULL OR assignee_replicant_id IS NULL),
  CHECK ((status = 'done' AND completed_at IS NOT NULL) OR (status <> 'done' AND completed_at IS NULL))
) STRICT;

CREATE INDEX tasks_workspace_status ON tasks(workspace_id, status, priority, due_at);

CREATE TABLE schedules (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  cron_expression TEXT NOT NULL,
  timezone TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('enabled', 'paused', 'archived')),
  replicant_id TEXT NOT NULL REFERENCES replicants(id) ON DELETE RESTRICT,
  channel_id TEXT REFERENCES channels(id) ON DELETE SET NULL,
  task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  harness_override TEXT,
  model_override TEXT,
  effort_override TEXT,
  prompt TEXT NOT NULL,
  retry_policy_json TEXT NOT NULL CHECK (json_valid(retry_policy_json)),
  outcome_assertions_json TEXT NOT NULL CHECK (json_valid(outcome_assertions_json)),
  next_run_at TEXT,
  last_run_at TEXT,
  created_by TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (workspace_id, name)
) STRICT;

CREATE INDEX schedules_due ON schedules(status, next_run_at) WHERE status = 'enabled';

CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  replicant_id TEXT NOT NULL REFERENCES replicants(id) ON DELETE RESTRICT,
  channel_id TEXT REFERENCES channels(id) ON DELETE SET NULL,
  task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  schedule_id TEXT REFERENCES schedules(id) ON DELETE SET NULL,
  parent_run_id TEXT REFERENCES runs(id) ON DELETE SET NULL,
  trigger_type TEXT NOT NULL CHECK (trigger_type IN ('message', 'task', 'schedule', 'manual', 'retry')),
  status TEXT NOT NULL CHECK (status IN ('queued', 'starting', 'running', 'awaiting-approval', 'succeeded', 'failed', 'canceled')),
  harness TEXT NOT NULL,
  model TEXT,
  effort TEXT,
  harness_session_key TEXT,
  requested_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  input_tokens INTEGER CHECK (input_tokens IS NULL OR input_tokens >= 0),
  output_tokens INTEGER CHECK (output_tokens IS NULL OR output_tokens >= 0),
  cost_micros INTEGER CHECK (cost_micros IS NULL OR cost_micros >= 0),
  error_code TEXT,
  error_message TEXT,
  CHECK (
    (status IN ('succeeded', 'failed', 'canceled') AND finished_at IS NOT NULL) OR
    (status NOT IN ('succeeded', 'failed', 'canceled') AND finished_at IS NULL)
  )
) STRICT;

CREATE INDEX runs_active ON runs(workspace_id, status, created_at DESC)
  WHERE status IN ('queued', 'starting', 'running', 'awaiting-approval');
CREATE INDEX runs_for_task ON runs(task_id, created_at DESC) WHERE task_id IS NOT NULL;
CREATE INDEX runs_for_schedule ON runs(schedule_id, created_at DESC) WHERE schedule_id IS NOT NULL;

CREATE TABLE run_events (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL CHECK (sequence >= 0),
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  created_at TEXT NOT NULL,
  UNIQUE (run_id, sequence)
) STRICT;

CREATE TABLE approvals (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  run_id TEXT REFERENCES runs(id) ON DELETE CASCADE,
  requested_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  action_digest TEXT NOT NULL CHECK (length(action_digest) = 64 AND action_digest NOT GLOB '*[^0-9a-f]*'),
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'denied', 'expired', 'consumed')),
  expires_at TEXT NOT NULL,
  decided_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  decided_at TEXT,
  consumed_at TEXT,
  created_at TEXT NOT NULL,
  CHECK (expires_at > created_at),
  CHECK (
    (status = 'pending' AND decided_at IS NULL AND decided_by IS NULL AND consumed_at IS NULL) OR
    (status IN ('approved', 'denied') AND decided_at IS NOT NULL AND decided_by IS NOT NULL AND consumed_at IS NULL) OR
    (status = 'expired' AND consumed_at IS NULL) OR
    (status = 'consumed' AND decided_at IS NOT NULL AND decided_by IS NOT NULL AND consumed_at IS NOT NULL)
  )
) STRICT;

CREATE INDEX approvals_pending ON approvals(workspace_id, expires_at) WHERE status = 'pending';

CREATE TABLE notifications (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  recipient_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT,
  resource_type TEXT,
  resource_id TEXT,
  created_at TEXT NOT NULL,
  read_at TEXT
) STRICT;

CREATE INDEX notifications_unread ON notifications(recipient_user_id, created_at DESC)
  WHERE read_at IS NULL;

CREATE TABLE artifacts (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('attachment', 'document', 'export', 'run-output')),
  name TEXT NOT NULL,
  media_type TEXT NOT NULL,
  relative_path TEXT NOT NULL,
  byte_size INTEGER NOT NULL CHECK (byte_size >= 0),
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*'),
  searchable INTEGER NOT NULL CHECK (searchable IN (0, 1)),
  created_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_by_replicant_id TEXT REFERENCES replicants(id) ON DELETE SET NULL,
  metadata_json TEXT NOT NULL CHECK (json_valid(metadata_json)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (workspace_id, relative_path),
  CHECK (created_by_user_id IS NULL OR created_by_replicant_id IS NULL)
) STRICT;

CREATE TABLE message_attachments (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  UNIQUE (message_id, artifact_id)
) STRICT;

CREATE TABLE audit_log (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('user', 'service', 'system')),
  actor_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT,
  request_id TEXT,
  detail_json TEXT NOT NULL CHECK (json_valid(detail_json)),
  created_at TEXT NOT NULL,
  CHECK ((actor_kind = 'system' AND actor_user_id IS NULL) OR actor_kind <> 'system')
) STRICT;

CREATE INDEX audit_by_resource ON audit_log(workspace_id, resource_type, resource_id, created_at DESC);
CREATE INDEX audit_by_actor ON audit_log(actor_user_id, created_at DESC) WHERE actor_user_id IS NOT NULL;

CREATE TRIGGER audit_log_no_update
BEFORE UPDATE ON audit_log
BEGIN
  SELECT RAISE(ABORT, 'audit records are immutable');
END;

CREATE TRIGGER audit_log_no_delete
BEFORE DELETE ON audit_log
BEGIN
  SELECT RAISE(ABORT, 'audit records are immutable');
END;
`,
  },
  {
    version: 2,
    name: "runtime_coordination",
    sql: String.raw`
CREATE TABLE runtime_schedule_occurrences (
  occurrence_key TEXT PRIMARY KEY,
  schedule_id TEXT NOT NULL REFERENCES schedules(id) ON DELETE CASCADE,
  scheduled_for TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'completed')),
  claim_token TEXT UNIQUE,
  lease_owner TEXT,
  lease_until TEXT,
  run_id TEXT REFERENCES runs(id) ON DELETE SET NULL,
  last_error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  UNIQUE (schedule_id, scheduled_for),
  CHECK (
    (claim_token IS NULL AND lease_owner IS NULL AND lease_until IS NULL) OR
    (claim_token IS NOT NULL AND lease_owner IS NOT NULL AND lease_until IS NOT NULL)
  ),
  CHECK (
    (status = 'pending' AND completed_at IS NULL) OR
    (status = 'completed' AND completed_at IS NOT NULL AND run_id IS NOT NULL)
  )
) STRICT;

CREATE INDEX runtime_schedule_occurrences_due
  ON runtime_schedule_occurrences(status, scheduled_for, lease_until);

CREATE TABLE runtime_scheduled_run_keys (
  idempotency_key TEXT PRIMARY KEY,
  schedule_id TEXT NOT NULL REFERENCES schedules(id) ON DELETE CASCADE,
  scheduled_for TEXT NOT NULL,
  run_id TEXT NOT NULL UNIQUE REFERENCES runs(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  UNIQUE (schedule_id, scheduled_for)
) STRICT;

CREATE TABLE runtime_run_controls (
  run_id TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
  prompt TEXT NOT NULL,
  cwd TEXT NOT NULL,
  system_prompt TEXT,
  approval_mode TEXT CHECK (approval_mode IS NULL OR approval_mode IN ('ask', 'plan')),
  retry_policy_json TEXT NOT NULL CHECK (json_valid(retry_policy_json)),
  attempt INTEGER NOT NULL DEFAULT 1 CHECK (attempt >= 1 AND attempt <= 10),
  not_before TEXT,
  cancellation_requested_at TEXT,
  assistant_text TEXT NOT NULL DEFAULT '',
  cached_input_tokens INTEGER CHECK (cached_input_tokens IS NULL OR cached_input_tokens >= 0),
  last_failure_retryable INTEGER NOT NULL DEFAULT 0 CHECK (last_failure_retryable IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (length(prompt) BETWEEN 1 AND 100000),
  CHECK (length(cwd) BETWEEN 1 AND 4096)
) STRICT;

CREATE INDEX runtime_run_controls_runnable
  ON runtime_run_controls(not_before, cancellation_requested_at);

CREATE TABLE runtime_run_executions (
  execution_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  attempt INTEGER NOT NULL CHECK (attempt >= 1 AND attempt <= 10),
  mode TEXT NOT NULL CHECK (mode IN ('start', 'resume')),
  lease_token TEXT NOT NULL UNIQUE,
  lease_owner TEXT NOT NULL,
  claimed_at TEXT NOT NULL,
  lease_until TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'finished', 'retry-scheduled', 'released', 'abandoned')),
  finished_at TEXT,
  finish_code TEXT,
  CHECK (
    (status = 'active' AND finished_at IS NULL) OR
    (status <> 'active' AND finished_at IS NOT NULL)
  )
) STRICT;

CREATE UNIQUE INDEX runtime_one_active_execution_per_run
  ON runtime_run_executions(run_id) WHERE status = 'active';
CREATE INDEX runtime_live_executions
  ON runtime_run_executions(status, lease_until, run_id);

CREATE TABLE runtime_run_event_keys (
  idempotency_key TEXT PRIMARY KEY,
  execution_id TEXT NOT NULL REFERENCES runtime_run_executions(execution_id) ON DELETE CASCADE,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  event_id TEXT NOT NULL UNIQUE REFERENCES run_events(id) ON DELETE CASCADE,
  event_digest TEXT NOT NULL CHECK (length(event_digest) = 64 AND event_digest NOT GLOB '*[^0-9a-f]*'),
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE runtime_run_approvals (
  approval_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  request_json TEXT NOT NULL CHECK (json_valid(request_json)),
  status TEXT NOT NULL CHECK (status IN ('pending', 'dispatching', 'dispatched')),
  decision_json TEXT CHECK (decision_json IS NULL OR json_valid(decision_json)),
  dispatch_token TEXT UNIQUE,
  lease_owner TEXT,
  lease_until TEXT,
  completed_at TEXT,
  last_error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (
    (status = 'pending' AND decision_json IS NULL AND dispatch_token IS NULL AND lease_owner IS NULL AND lease_until IS NULL AND completed_at IS NULL) OR
    (status = 'dispatching' AND decision_json IS NOT NULL AND dispatch_token IS NOT NULL AND lease_owner IS NOT NULL AND lease_until IS NOT NULL AND completed_at IS NULL) OR
    (status = 'dispatched' AND decision_json IS NOT NULL AND dispatch_token IS NOT NULL AND lease_owner IS NOT NULL AND lease_until IS NOT NULL AND completed_at IS NOT NULL)
  )
) STRICT;

CREATE INDEX runtime_run_approvals_by_run
  ON runtime_run_approvals(run_id, status);

CREATE TRIGGER run_events_no_update
BEFORE UPDATE ON run_events
BEGIN
  SELECT RAISE(ABORT, 'run events are immutable');
END;

CREATE TRIGGER run_events_no_delete
BEFORE DELETE ON run_events
BEGIN
  SELECT RAISE(ABORT, 'run events are immutable');
END;
`,
  },
  {
    version: 3,
    name: "runtime_chat_delivery",
    sql: String.raw`
CREATE TABLE runtime_run_message_deliveries (
  run_id TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
  message_id TEXT NOT NULL UNIQUE REFERENCES messages(id) ON DELETE CASCADE,
  delivered_at TEXT NOT NULL
) STRICT;

CREATE INDEX runtime_run_message_deliveries_by_message
  ON runtime_run_message_deliveries(message_id);
`,
  },
] as const;
