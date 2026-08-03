import { permissions, type Permission } from "@replicantos/protocol";
import {
  type FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";

import {
  api,
  type AccessGrant,
  type Actor,
  type AuditRecord,
  type DoctorResult,
  type HarnessManifest,
  jsonBody,
  type Settings,
} from "./api.js";

type SettingsSection = "access" | "harnesses" | "workspace" | "security";

const settingsSections: readonly {
  id: SettingsSection;
  label: string;
}[] = [
  { id: "access", label: "Users & access" },
  { id: "harnesses", label: "Harness runtimes" },
  { id: "workspace", label: "Workspace" },
  { id: "security", label: "Security" },
];

interface LiveSettingsProps {
  actor: Actor;
  onChanged(): Promise<void>;
  onCreateUser(): void;
  onFailure(error: unknown): void;
  sessionExpiresAt: string | null;
  settings: Settings | null;
  users: Actor[];
}

interface WorkspaceDraft {
  telemetryEnabled: boolean;
  terminalEnabled: boolean;
  theme: string;
  timezone: string;
}

function workspaceDraft(settings: Settings | null): WorkspaceDraft {
  return {
    telemetryEnabled: false,
    terminalEnabled: settings?.["terminal.enabled"] ?? false,
    theme: settings?.["ui.theme"] ?? "system",
    timezone:
      settings?.["ui.timezone"] ??
      Intl.DateTimeFormat().resolvedOptions().timeZone,
  };
}

function AccessSettings({
  actor,
  onChanged,
  onCreateUser,
  onFailure,
  settings,
  users,
}: Omit<LiveSettingsProps, "sessionExpiresAt">) {
  const [selectedUserId, setSelectedUserId] = useState<string | null>(
    users[0]?.id ?? null,
  );
  const [grants, setGrants] = useState<AccessGrant[]>([]);
  const [loadingGrants, setLoadingGrants] = useState(false);
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const selectedUser = useMemo(
    () => users.find((user) => user.id === selectedUserId) ?? null,
    [selectedUserId, users],
  );

  const loadGrants = useCallback(
    async (userId: string) => {
      setLoadingGrants(true);
      try {
        const result = await api<{ items: AccessGrant[] }>(
          `/users/${encodeURIComponent(userId)}/grants`,
        );
        setGrants(result.items);
      } catch (error) {
        onFailure(error);
      } finally {
        setLoadingGrants(false);
      }
    },
    [onFailure],
  );

  useEffect(() => {
    if (selectedUser !== null || users.length === 0) return;
    setSelectedUserId(users[0]?.id ?? null);
  }, [selectedUser, users]);

  useEffect(() => {
    if (selectedUser === null) {
      setGrants([]);
      return;
    }
    void loadGrants(selectedUser.id);
  }, [loadGrants, selectedUser]);

  async function changeStatus() {
    if (selectedUser === null) return;
    const nextStatus =
      selectedUser.status === "active" ? "suspended" : "active";
    if (selectedUser.id === actor.id && nextStatus === "suspended") return;
    setPending(true);
    setNotice(null);
    try {
      await api(`/users/${encodeURIComponent(selectedUser.id)}/status`, {
        body: jsonBody({ status: nextStatus }),
        method: "PATCH",
      });
      await onChanged();
      setNotice(
        `${selectedUser.displayName} is now ${nextStatus === "active" ? "active" : "suspended"}.`,
      );
    } catch (error) {
      onFailure(error);
    } finally {
      setPending(false);
    }
  }

  async function createGrant(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (selectedUser === null) return;
    const form = event.currentTarget;
    const values = new FormData(form);
    const permission = String(values.get("permission")) as Permission;
    const resourceId = String(values.get("resourceId") ?? "").trim();
    const reason = String(values.get("reason") ?? "").trim();
    const effect = String(values.get("effect")) as "allow" | "deny";
    setPending(true);
    setNotice(null);
    try {
      await api("/grants", {
        body: jsonBody({
          effect,
          expiresAt: null,
          permission,
          reason: reason || null,
          resourceId: resourceId || null,
          subjectRole: null,
          subjectType: "user",
          subjectUserId: selectedUser.id,
        }),
        method: "POST",
      });
      await loadGrants(selectedUser.id);
      form.reset();
      setNotice(`${effect === "allow" ? "Allow" : "Deny"} grant created.`);
    } catch (error) {
      onFailure(error);
    } finally {
      setPending(false);
    }
  }

  const selfSuspension =
    selectedUser?.id === actor.id && selectedUser.status === "active";

  return (
    <div className="settings-content access-content">
      <header>
        <small>POLICY CONTROL</small>
        <h2>Users & access</h2>
        <p>
          Roles establish the baseline. Explicit allow and deny grants are
          evaluated at the server resource boundary, with deny taking
          precedence.
        </p>
      </header>
      <div className="module-toolbar">
        <span>{users.length} ACTORS</span>
        <button className="primary-button" onClick={onCreateUser} type="button">
          + ADD USER
        </button>
      </div>
      <div className="access-table">
        <header>
          <span>IDENTITY</span>
          <span>ROLE</span>
          <span>HANDLE</span>
          <span>STATE</span>
          <span />
        </header>
        {users.map((user) => (
          <article
            className={user.id === selectedUserId ? "selected" : ""}
            key={user.id}
          >
            <span>
              <i className="avatar mini accent-slate">
                {user.displayName.slice(0, 1)}
              </i>
              <strong>{user.displayName}</strong>
            </span>
            <code>{user.role}</code>
            <p>{user.handle}</p>
            <em>
              <i
                className={
                  user.status === "active" ? "status-dot" : "status-dot offline"
                }
              />
              {user.status}
            </em>
            <button
              aria-pressed={user.id === selectedUserId}
              onClick={() => {
                setNotice(null);
                setSelectedUserId(user.id);
              }}
              type="button"
            >
              REVIEW {user.displayName}
            </button>
          </article>
        ))}
      </div>

      {selectedUser === null ? null : (
        <section
          aria-label={`Review ${selectedUser.displayName}`}
          className="settings-review"
        >
          <header>
            <div>
              <small>SELECTED ACTOR</small>
              <h3>{selectedUser.displayName}</h3>
              <p>
                {selectedUser.handle} · {selectedUser.role} ·{" "}
                {selectedUser.status}
              </p>
            </div>
            <button
              disabled={pending || selfSuspension}
              onClick={() => void changeStatus()}
              title={
                selfSuspension
                  ? "The current actor cannot suspend their own account."
                  : undefined
              }
              type="button"
            >
              {selfSuspension
                ? "CURRENT SESSION"
                : selectedUser.status === "active"
                  ? "SUSPEND USER"
                  : "ACTIVATE USER"}
            </button>
          </header>

          <div className="grant-layout">
            <div className="grant-list" aria-label="Active grants">
              <h4>ACTIVE GRANTS</h4>
              {loadingGrants ? <p>Loading grants…</p> : null}
              {!loadingGrants && grants.length === 0 ? (
                <p>No active explicit grants.</p>
              ) : null}
              {grants.map((grant) => (
                <article key={grant.id}>
                  <strong>{grant.permission}</strong>
                  <code>{grant.effect}</code>
                  <span>{grant.resourceId ?? "all matching resources"}</span>
                  {grant.reason ? <p>{grant.reason}</p> : null}
                </article>
              ))}
            </div>
            <form
              className="grant-form"
              onSubmit={(event) => void createGrant(event)}
            >
              <h4>CREATE EXPLICIT GRANT</h4>
              <label>
                GRANT PERMISSION
                <select name="permission" defaultValue="channel:read">
                  {permissions.map((permission) => (
                    <option key={permission} value={permission}>
                      {permission}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                EFFECT
                <select name="effect" defaultValue="allow">
                  <option value="allow">Allow</option>
                  <option value="deny">Deny</option>
                </select>
              </label>
              <label>
                RESOURCE ID (OPTIONAL)
                <input
                  maxLength={120}
                  name="resourceId"
                  placeholder="Blank applies to every matching resource"
                />
              </label>
              <label>
                REASON
                <input maxLength={500} name="reason" />
              </label>
              <button
                className="primary-button"
                disabled={pending}
                type="submit"
              >
                CREATE GRANT
              </button>
            </form>
          </div>
        </section>
      )}

      {notice ? (
        <p className="settings-notice" role="status">
          {notice}
        </p>
      ) : null}
      <div className="policy-note">
        <span>LOCAL DEFAULTS</span>
        <p>
          Telemetry: disabled (not implemented)
          {" · "}Terminal policy:{" "}
          {settings?.["terminal.enabled"] ? "enabled" : "disabled"}. Provider
          credentials are not stored in the ReplicantOS database.
        </p>
      </div>
    </div>
  );
}

function HarnessSettings({ onFailure }: Pick<LiveSettingsProps, "onFailure">) {
  const [manifests, setManifests] = useState<HarnessManifest[]>([]);
  const [diagnostics, setDiagnostics] = useState<DoctorResult[]>([]);
  const [loadingManifests, setLoadingManifests] = useState(true);
  const [runningDiagnostics, setRunningDiagnostics] = useState(false);
  const [checked, setChecked] = useState(false);

  useEffect(() => {
    let active = true;
    void api<{ items: HarnessManifest[] }>("/harnesses")
      .then((result) => {
        if (active) setManifests(result.items);
      })
      .catch(onFailure)
      .finally(() => {
        if (active) setLoadingManifests(false);
      });
    return () => {
      active = false;
    };
  }, [onFailure]);

  async function runDiagnostics() {
    setRunningDiagnostics(true);
    try {
      const result = await api<{ items: DoctorResult[] }>("/harnesses/doctor", {
        body: jsonBody({}),
        method: "POST",
      });
      setDiagnostics(result.items);
      setChecked(true);
    } catch (error) {
      onFailure(error);
    } finally {
      setRunningDiagnostics(false);
    }
  }

  const resultByHarness = new Map(
    diagnostics.map((result) => [result.harnessId, result]),
  );

  return (
    <div className="settings-content">
      <header>
        <small>RUNTIME COMPOSITION</small>
        <h2>Harness runtimes</h2>
        <p>
          Manifests describe the installed runtime adapters. Diagnostics run
          only when you press the button and may invoke provider-native checks
          against locally installed tools.
        </p>
        <button
          className="primary-button harness-diagnostics-button"
          disabled={loadingManifests || runningDiagnostics}
          onClick={() => void runDiagnostics()}
          type="button"
        >
          {runningDiagnostics ? "RUNNING DIAGNOSTICS…" : "RUN DIAGNOSTICS"}
        </button>
      </header>
      <div className="provider-grid">
        {loadingManifests ? <p>Loading harness manifests…</p> : null}
        {!loadingManifests && manifests.length === 0 ? (
          <p>No harness manifests are available from this runtime.</p>
        ) : null}
        {manifests.map((manifest) => {
          const result = resultByHarness.get(manifest.id);
          return (
            <article key={manifest.id}>
              <div>
                <span className="provider-glyph">
                  {manifest.id.slice(0, 3).toUpperCase()}
                </span>
                <div>
                  <strong>{manifest.displayName}</strong>
                  <small>
                    {manifest.transport} · {manifest.maturity}
                  </small>
                </div>
                <em className={result?.status === "ready" ? "ready" : ""}>
                  {result?.status ?? (checked ? "NO RESULT" : "NOT CHECKED")}
                </em>
              </div>
              <p>{manifest.description}</p>
              <div className="harness-capabilities">
                <span>
                  {manifest.capabilities.approvals
                    ? "APPROVALS"
                    : "NO APPROVALS"}
                </span>
                <span>
                  {manifest.capabilities.cancellation
                    ? "CANCELLATION"
                    : "NO CANCELLATION"}
                </span>
                <span>
                  {manifest.capabilities.modelSelection
                    ? "MODEL SELECTION"
                    : "PROVIDER MODEL"}
                </span>
              </div>
              {result ? (
                <div
                  className="doctor-checks"
                  aria-label={`${manifest.displayName} diagnostics`}
                >
                  {result.checks.map((check) => (
                    <p key={check.id}>
                      <strong>{check.status}</strong> {check.message}
                      {check.remediation ? (
                        <small>{check.remediation}</small>
                      ) : null}
                    </p>
                  ))}
                  <time dateTime={result.checkedAt}>
                    Checked {new Date(result.checkedAt).toLocaleString()}
                  </time>
                </div>
              ) : null}
              <footer>
                <span>HOST-NATIVE CREDENTIALS · NOT STORED HERE</span>
              </footer>
            </article>
          );
        })}
      </div>
    </div>
  );
}

function WorkspaceSettings({
  onChanged,
  onFailure,
  settings,
}: Pick<LiveSettingsProps, "onChanged" | "onFailure" | "settings">) {
  const [draft, setDraft] = useState(() => workspaceDraft(settings));
  const [pending, setPending] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => setDraft(workspaceDraft(settings)), [settings]);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setSaved(false);
    try {
      const updates: readonly [keyof Settings, string | boolean][] = [
        ["ui.timezone", draft.timezone.trim()],
        ["ui.theme", draft.theme],
        ["terminal.enabled", draft.terminalEnabled],
        ["telemetry.enabled", draft.telemetryEnabled],
      ];
      for (const [key, value] of updates) {
        await api(`/settings/${encodeURIComponent(key)}`, {
          body: jsonBody({ value }),
          method: "PUT",
        });
      }
      await onChanged();
      setSaved(true);
    } catch (error) {
      onFailure(error);
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="settings-content">
      <header>
        <small>WORKSPACE CONTROL</small>
        <h2>Workspace</h2>
        <p>
          Store presentation and local capability defaults in the authenticated
          workspace settings boundary.
        </p>
      </header>
      <form
        className="workspace-settings-form"
        onSubmit={(event) => void save(event)}
      >
        <label>
          TIMEZONE
          <input
            name="timezone"
            onChange={(event) =>
              setDraft((current) => ({
                ...current,
                timezone: event.target.value,
              }))
            }
            required
            value={draft.timezone}
          />
        </label>
        <label>
          THEME
          <select
            name="theme"
            onChange={(event) =>
              setDraft((current) => ({ ...current, theme: event.target.value }))
            }
            value={draft.theme}
          >
            <option value="system">System</option>
            <option value="dark">Dark</option>
            <option value="light">Light</option>
          </select>
        </label>
        <label className="setting-toggle">
          <input
            aria-label="Terminal execution"
            checked={draft.terminalEnabled}
            name="terminalEnabled"
            onChange={(event) =>
              setDraft((current) => ({
                ...current,
                terminalEnabled: event.target.checked,
              }))
            }
            type="checkbox"
          />
          <span>
            <strong>Reserved terminal capability gate</strong>
            <small>
              No terminal UI is shipped. This policy remains inert without
              explicit permission and a composed runtime boundary.
            </small>
          </span>
        </label>
        <label className="setting-toggle telemetry-toggle">
          <input
            aria-label="Telemetry"
            checked={draft.telemetryEnabled}
            disabled
            name="telemetryEnabled"
            onChange={() => undefined}
            type="checkbox"
          />
          <span>
            <strong>Telemetry — OFF / NOT IMPLEMENTED</strong>
            <small>
              This build has no telemetry pipeline or external destination.
            </small>
          </span>
        </label>
        <footer>
          <span>
            {saved ? "Workspace settings saved." : "Changes are audited."}
          </span>
          <button className="primary-button" disabled={pending} type="submit">
            {pending ? "SAVING…" : "SAVE WORKSPACE SETTINGS"}
          </button>
        </footer>
      </form>
    </div>
  );
}

function SecuritySettings({
  actor,
  onFailure,
  sessionExpiresAt,
}: Pick<LiveSettingsProps, "actor" | "onFailure" | "sessionExpiresAt">) {
  const [audit, setAudit] = useState<AuditRecord[]>([]);
  const [loading, setLoading] = useState(false);

  const loadAudit = useCallback(async () => {
    setLoading(true);
    try {
      const result = await api<{ items: AuditRecord[] }>(
        `/audit?resourceType=workspace&resourceId=${encodeURIComponent(actor.workspaceId)}&limit=12`,
      );
      setAudit(result.items);
    } catch (error) {
      onFailure(error);
    } finally {
      setLoading(false);
    }
  }, [actor.workspaceId, onFailure]);

  useEffect(() => {
    void loadAudit();
  }, [loadAudit]);

  return (
    <div className="settings-content security-settings">
      <header>
        <small>SECURITY BOUNDARY</small>
        <h2>Security</h2>
        <p>
          Authentication, role ceilings, resource grants, and audit writes are
          enforced by the local server, not trusted to this interface.
        </p>
      </header>
      <div className="security-summary">
        <article>
          <small>CURRENT SESSION EXPIRES</small>
          <strong>
            {sessionExpiresAt === null
              ? "Unavailable"
              : new Date(sessionExpiresAt).toLocaleString()}
          </strong>
          {sessionExpiresAt ? (
            <time dateTime={sessionExpiresAt}>{sessionExpiresAt}</time>
          ) : null}
        </article>
        <article>
          <small>HARD BOUNDARIES</small>
          <strong>Deny wins. Owner-only actions stay owner-only.</strong>
          <p>
            Workspace transfer and backup restore cannot be granted around the
            owner ceiling. Terminal permission also remains inert while the
            workspace terminal setting is off.
          </p>
        </article>
      </div>
      <div className="workspace-audit">
        <header>
          <div>
            <small>EXACT RESOURCE FEED</small>
            <h3>Workspace audit</h3>
          </div>
          <button
            disabled={loading}
            onClick={() => void loadAudit()}
            type="button"
          >
            REFRESH AUDIT
          </button>
        </header>
        {loading && audit.length === 0 ? <p>Loading workspace audit…</p> : null}
        {!loading && audit.length === 0 ? (
          <p>No workspace audit entries yet.</p>
        ) : null}
        {audit.map((entry) => (
          <article key={entry.id}>
            <strong>{entry.action}</strong>
            <span>{entry.actorKind}</span>
            <time dateTime={entry.createdAt}>
              {new Date(entry.createdAt).toLocaleString()}
            </time>
          </article>
        ))}
      </div>
    </div>
  );
}

export function LiveSettings(props: LiveSettingsProps) {
  const [section, setSection] = useState<SettingsSection>("access");

  return (
    <section className="module-view settings-view">
      <div className="settings-nav">
        {settingsSections.map((item) => (
          <button
            aria-pressed={section === item.id}
            className={section === item.id ? "active" : ""}
            key={item.id}
            onClick={() => setSection(item.id)}
            type="button"
          >
            {item.label}
          </button>
        ))}
      </div>
      {section === "access" ? <AccessSettings {...props} /> : null}
      {section === "harnesses" ? (
        <HarnessSettings onFailure={props.onFailure} />
      ) : null}
      {section === "workspace" ? (
        <WorkspaceSettings
          onChanged={props.onChanged}
          onFailure={props.onFailure}
          settings={props.settings}
        />
      ) : null}
      {section === "security" ? (
        <SecuritySettings
          actor={props.actor}
          onFailure={props.onFailure}
          sessionExpiresAt={props.sessionExpiresAt}
        />
      ) : null}
    </section>
  );
}
