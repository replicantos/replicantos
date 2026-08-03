import {
  type FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import { ChevronDown, Gauge, Plus } from "lucide-react";
import {
  api,
  ApiError,
  type Actor,
  type Channel,
  isAuthenticationError,
  jsonBody,
  type Message,
  type Notification,
  type Replicant,
  type Run,
  type Schedule,
  type Settings,
  type Task,
  type TaskStatus,
} from "./api.js";
import { LiveDatabase, LiveFiles, LiveLibrary } from "./LiveServices.js";
import { LiveRuns } from "./LiveRuns.js";
import { LiveSettings } from "./LiveSettings.js";
import {
  BrandGlyph,
  ChannelHash,
  NotificationGlyph,
  PresenceRail,
  ProductIcon,
  productAreaNames,
  type ProductAreaName,
} from "./ShellChrome.js";

const productAreas = productAreaNames;
type ProductArea = ProductAreaName;
type DialogKind = "channel" | "replicant" | "task" | "schedule" | "user" | null;
type Phase = "loading" | "setup" | "login" | "ready" | "offline";

export interface ReplicantDialogSubmission {
  binding: {
    behavior: "automatic" | "mention-only";
    channelId: string;
  };
  replicant: {
    defaultHarness: Replicant["defaultHarness"];
    defaultModel: null;
    description: string | null;
    name: string;
    persona: string;
    slug: string;
  };
}

export class ReplicantBindingCreationError extends Error {
  constructor(
    readonly created: Replicant,
    readonly bindingError: unknown,
  ) {
    super("The Replicant was created, but its channel binding failed.");
    this.name = "ReplicantBindingCreationError";
  }
}

export async function createBoundReplicant(
  submission: ReplicantDialogSubmission,
): Promise<Replicant> {
  const created = await api<Replicant>("/replicants", {
    body: jsonBody(submission.replicant),
    method: "POST",
  });
  try {
    await api(`/replicants/${encodeURIComponent(created.id)}/bindings`, {
      body: jsonBody(submission.binding),
      method: "POST",
    });
  } catch (error) {
    throw new ReplicantBindingCreationError(created, error);
  }
  return created;
}

export function startMessagePolling(
  refresh: () => Promise<void> | void,
  intervalMs = 2_500,
): () => void {
  const polling = window.setInterval(() => void refresh(), intervalMs);
  return () => window.clearInterval(polling);
}

interface WorkspaceResources {
  channels: Channel[];
  notifications: Notification[];
  replicants: Replicant[];
  runs: Run[];
  schedules: Schedule[];
  settings: Settings | null;
  tasks: Task[];
  users: Actor[];
}

const emptyResources: WorkspaceResources = {
  channels: [],
  notifications: [],
  replicants: [],
  runs: [],
  schedules: [],
  settings: null,
  tasks: [],
  users: [],
};

const descriptions: Record<ProductArea, string> = {
  Chat: "Persistent, permission-checked workspace channels",
  Tasks: "Human and Replicant work with durable state",
  Scheduled: "Timezone-aware definitions and auditable run requests",
  Runs: "Durable execution history, approvals, and runtime projections",
  Library: "Approved documents indexed from safe roots",
  Files: "Bounded workspace access with server-side containment",
  Database: "Allowlisted tables through a read-only connection",
  Settings: "Users, harnesses, security, and workspace policy",
};

function field(form: FormData, key: string): string {
  return String(form.get(key) ?? "").trim();
}

function displayError(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error && error.message) return error.message;
  return "The local server could not complete the request.";
}

export function LiveApp() {
  const [phase, setPhase] = useState<Phase>("loading");
  const [actor, setActor] = useState<Actor | null>(null);
  const [sessionExpiresAt, setSessionExpiresAt] = useState<string | null>(null);
  const [area, setArea] = useState<ProductArea>("Chat");
  const [resources, setResources] =
    useState<WorkspaceResources>(emptyResources);
  const [selectedChannelId, setSelectedChannelId] = useState<string | null>(
    null,
  );
  const [messages, setMessages] = useState<Message[]>([]);
  const [dialog, setDialog] = useState<DialogKind>(null);
  const [showNotifications, setShowNotifications] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [realtime, setRealtime] = useState<"connecting" | "online" | "offline">(
    "offline",
  );

  const loadResources = useCallback(async () => {
    // Keep the local control-plane refresh bounded. A sequential pass avoids
    // burst-opening eight loopback proxy sockets on constrained self-hosted
    // machines while remaining imperceptible for these small local resources.
    const channels = await api<{ items: Channel[] }>("/channels");
    const replicants = await api<{ items: Replicant[] }>("/replicants");
    const tasks = await api<{ items: Task[] }>("/tasks?limit=200");
    const schedules = await api<{ items: Schedule[] }>("/schedules?limit=100");
    const runs = await api<{ items: Run[] }>("/runs?limit=100");
    const users = await api<{ items: Actor[] }>("/users?limit=200");
    const settings = await api<Settings>("/settings");
    const notifications = await api<{ items: Notification[] }>(
      "/notifications?limit=100",
    );
    setResources({
      channels: channels.items,
      notifications: notifications.items,
      replicants: replicants.items,
      tasks: tasks.items,
      schedules: schedules.items,
      runs: runs.items,
      users: users.items,
      settings,
    });
    setSelectedChannelId((current) => {
      if (current && channels.items.some((channel) => channel.id === current))
        return current;
      return channels.items[0]?.id ?? null;
    });
  }, []);

  const refreshRuns = useCallback(async () => {
    const result = await api<{ items: Run[] }>("/runs?limit=100");
    setResources((current) => ({ ...current, runs: result.items }));
  }, []);

  const reportFailure = useCallback((failure: unknown) => {
    setError(displayError(failure));
  }, []);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const status = await api<{ bootstrapped: boolean }>(
          "/system/bootstrap-status",
        );
        if (!active) return;
        if (!status.bootstrapped) {
          setPhase("setup");
          return;
        }
        try {
          const session = await api<{ actor: Actor; expiresAt: string }>(
            "/auth/me",
          );
          if (!active) return;
          setActor(session.actor);
          setSessionExpiresAt(session.expiresAt);
          setPhase("ready");
        } catch (sessionError) {
          if (!active) return;
          if (isAuthenticationError(sessionError)) setPhase("login");
          else throw sessionError;
        }
      } catch (initializationError) {
        if (!active) return;
        setError(displayError(initializationError));
        setPhase("offline");
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (phase !== "ready") return;
    setError(null);
    void loadResources().catch((resourceError: unknown) => {
      if (isAuthenticationError(resourceError)) {
        setActor(null);
        setPhase("login");
        return;
      }
      setError(displayError(resourceError));
    });
  }, [loadResources, phase]);

  const loadMessages = useCallback(async (channelId: string) => {
    const result = await api<{ items: Message[] }>(
      `/channels/${encodeURIComponent(channelId)}/messages?limit=200`,
    );
    setMessages([...result.items].reverse());
  }, []);

  useEffect(() => {
    if (phase !== "ready" || selectedChannelId === null) {
      setMessages([]);
      return;
    }
    void loadMessages(selectedChannelId).catch((messageError: unknown) =>
      setError(displayError(messageError)),
    );
  }, [loadMessages, phase, selectedChannelId]);

  useEffect(() => {
    if (phase !== "ready" || selectedChannelId === null) return;
    const channelId = selectedChannelId;
    return startMessagePolling(() => {
      void loadMessages(channelId).catch((messageError: unknown) =>
        setError(displayError(messageError)),
      );
    });
  }, [loadMessages, phase, selectedChannelId]);

  useEffect(() => {
    if (phase !== "ready") return;
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(
      `${protocol}//${location.host}/api/v1/realtime`,
      "replicantos.v1",
    );
    setRealtime("connecting");
    socket.addEventListener("open", () => setRealtime("online"));
    socket.addEventListener("close", () => setRealtime("offline"));
    socket.addEventListener("error", () => setRealtime("offline"));
    return () => socket.close();
  }, [phase]);

  const selectedChannel = useMemo(
    () =>
      resources.channels.find((channel) => channel.id === selectedChannelId) ??
      null,
    [resources.channels, selectedChannelId],
  );
  const unreadNotifications = resources.notifications.filter(
    (notification) => notification.readAt === null,
  ).length;
  const canManageWorkspace = actor?.role === "owner" || actor?.role === "admin";
  const visibleProductAreas = useMemo(
    () =>
      canManageWorkspace
        ? [...productAreas]
        : productAreas.filter(
            (item) => item !== "Database" && item !== "Settings",
          ),
    [canManageWorkspace],
  );

  async function authenticate(handle: string, password: string) {
    const session = await api<{ actor: Actor; expiresAt: string }>(
      "/auth/login",
      {
        body: jsonBody({ handle, password }),
        method: "POST",
      },
    );
    setActor(session.actor);
    setSessionExpiresAt(session.expiresAt);
    setArea("Chat");
    setPhase("ready");
  }

  async function runAction(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (actionError) {
      setError(displayError(actionError));
    } finally {
      setBusy(false);
    }
  }

  if (phase === "loading")
    return (
      <SystemGate
        title="CONNECTING"
        detail="Locating the local ReplicantOS server…"
      />
    );
  if (phase === "offline") {
    return (
      <SystemGate
        title="SERVER OFFLINE"
        detail={error ?? "ReplicantOS is not reachable."}
      >
        <button onClick={() => location.reload()} type="button">
          RETRY CONNECTION
        </button>
        <a href="/?demo=1">OPEN SYNTHETIC DEMO</a>
      </SystemGate>
    );
  }
  if (phase === "setup") {
    return (
      <SetupForm
        busy={busy}
        error={error}
        onSubmit={(values) =>
          runAction(async () => {
            await api("/system/bootstrap", {
              body: jsonBody(values),
              method: "POST",
            });
            await authenticate(values.handle, values.password);
          })
        }
      />
    );
  }
  if (phase === "login") {
    return (
      <LoginForm
        busy={busy}
        error={error}
        onSubmit={(handle, password) =>
          runAction(() => authenticate(handle, password))
        }
      />
    );
  }

  return (
    <div className="app-frame live-app">
      <aside className="workspace-rail" aria-label="Workspace navigation">
        <button
          aria-label="Open chat"
          className="rail-logo"
          onClick={() => setArea("Chat")}
          title="ReplicantOS"
          type="button"
        >
          <BrandGlyph />
        </button>
        <div className="rail-divider" />
        <nav className="primary-nav" aria-label="Product areas">
          {visibleProductAreas.map((item) => (
            <button
              aria-label={item}
              className={area === item ? "nav-item active" : "nav-item"}
              key={item}
              onClick={() => setArea(item)}
              title={item}
              type="button"
            >
              <ProductIcon area={item} />
              <span className="nav-label">{item}</span>
            </button>
          ))}
        </nav>
        <button
          aria-label="Log out"
          className="rail-user"
          onClick={() =>
            void runAction(async () => {
              await api("/auth/logout", { method: "POST" });
              setActor(null);
              setSessionExpiresAt(null);
              setArea("Chat");
              setResources(emptyResources);
              setPhase("login");
            })
          }
          title={`${actor?.displayName ?? "Account"} · Log out`}
          type="button"
        >
          <span className="avatar round accent-slate">
            {actor?.displayName.slice(0, 1) ?? "?"}
            <i className={realtime === "online" ? "" : "offline"} />
          </span>
        </button>
      </aside>

      <aside className="context-rail" aria-label="Channels and Replicants">
        <div className="context-heading">
          <span>
            <strong>ReplicantOS</strong>
            <small>Local workspace</small>
          </span>
          <ChevronDown aria-hidden="true" size={16} />
        </div>
        <div className="demo-disclosure live-disclosure">
          <i className={realtime === "online" ? "" : "muted"} />
          <span>
            {realtime === "online" ? "SERVER CONNECTED" : "HTTP CONNECTED"}
          </span>
        </div>
        {area === "Chat" ? (
          <>
            <section className="context-section">
              <header>
                <span>CHANNELS</span>
                {canManageWorkspace ? (
                  <button
                    onClick={() => setDialog("channel")}
                    type="button"
                    aria-label="Create channel"
                  >
                    <Plus aria-hidden="true" size={14} />
                  </button>
                ) : null}
              </header>
              <div className="channel-group">
                <small>
                  <ChevronDown aria-hidden="true" size={11} /> Workspace
                </small>
                {resources.channels.map((channel) => (
                  <button
                    aria-label={`# ${channel.slug}`}
                    className={
                      selectedChannelId === channel.id
                        ? "channel active"
                        : "channel"
                    }
                    key={channel.id}
                    onClick={() => setSelectedChannelId(channel.id)}
                    type="button"
                  >
                    <ChannelHash size={17} />
                    {channel.slug}
                  </button>
                ))}
                {resources.channels.length === 0 ? (
                  <p className="rail-empty">Create the first channel.</p>
                ) : null}
              </div>
            </section>
            <div className="context-summary">
              <button
                disabled={!canManageWorkspace}
                onClick={() => setDialog("replicant")}
                type="button"
              >
                <Plus aria-hidden="true" size={13} /> Add Replicant
              </button>
              <span>{resources.replicants.length} Replicants</span>
              <span>{resources.users.length} workspace users</span>
              <small>Self-hosted · authenticated</small>
            </div>
          </>
        ) : (
          <LiveModuleContext area={area} resources={resources} />
        )}
      </aside>

      <main className="main-panel">
        <header className="panel-header">
          <div className="panel-title">
            {area === "Chat" ? (
              <ChannelHash size={24} />
            ) : (
              <ProductIcon area={area} size={22} />
            )}
            <div>
              <h1
                aria-label={
                  area === "Chat"
                    ? `#${selectedChannel?.slug ?? "no-channel"}`
                    : undefined
                }
              >
                {area === "Chat"
                  ? (selectedChannel?.slug ?? "no-channel")
                  : area}
              </h1>
              <p>{descriptions[area]}</p>
            </div>
          </div>
          {area === "Chat" && resources.channels.length > 0 ? (
            <select
              aria-label="Select channel"
              className="mobile-context-select"
              onChange={(event) => setSelectedChannelId(event.target.value)}
              value={selectedChannelId ?? ""}
            >
              {resources.channels.map((channel) => (
                <option key={channel.id} value={channel.id}>
                  #{channel.slug}
                </option>
              ))}
            </select>
          ) : null}
          <div className="header-actions">
            <span className="header-mode">
              <Gauge aria-hidden="true" size={15} /> Normal
            </span>
            <span>
              <i
                className={
                  realtime === "online" ? "status-dot" : "status-dot offline"
                }
              />{" "}
              {realtime === "online" ? "Connected" : "HTTP only"}
            </span>
            <button
              aria-expanded={showNotifications}
              aria-label={`${unreadNotifications} unread notifications`}
              className="notification-button"
              onClick={() => setShowNotifications((current) => !current)}
              type="button"
            >
              <NotificationGlyph />
              {unreadNotifications > 0 ? <em>{unreadNotifications}</em> : null}
            </button>
          </div>
        </header>
        {error ? (
          <div className="flash" role="alert">
            <span>{error}</span>
            <button onClick={() => setError(null)} type="button">
              DISMISS
            </button>
          </div>
        ) : null}
        <div className="panel-content">
          {area === "Chat" ? (
            <LiveChat
              actor={actor}
              busy={busy}
              channel={selectedChannel}
              messages={messages}
              replicants={resources.replicants}
              users={resources.users}
              onSend={(content) =>
                runAction(async () => {
                  if (!selectedChannel) return;
                  await api(`/channels/${selectedChannel.id}/messages`, {
                    body: jsonBody({ content, replyToId: null }),
                    method: "POST",
                  });
                  await loadMessages(selectedChannel.id);
                })
              }
            />
          ) : null}
          {area === "Tasks" ? (
            <LiveTasks
              busy={busy}
              canManage={canManageWorkspace}
              tasks={resources.tasks}
              users={resources.users}
              replicants={resources.replicants}
              onCreate={() => setDialog("task")}
              onStatus={(task, status) =>
                runAction(async () => {
                  await api(`/tasks/${task.id}/status`, {
                    body: jsonBody({ status }),
                    method: "PATCH",
                  });
                  await loadResources();
                })
              }
            />
          ) : null}
          {area === "Scheduled" ? (
            <LiveSchedules
              busy={busy}
              canManage={canManageWorkspace}
              schedules={resources.schedules}
              runs={resources.runs}
              replicants={resources.replicants}
              onCreate={() => setDialog("schedule")}
              onRun={(schedule) =>
                runAction(async () => {
                  await api(`/schedules/${schedule.id}/run-now`, {
                    method: "POST",
                  });
                  await loadResources();
                })
              }
            />
          ) : null}
          {area === "Runs" ? (
            <LiveRuns
              canManage={canManageWorkspace}
              onFailure={reportFailure}
              onRunsChanged={refreshRuns}
              replicants={resources.replicants}
              runs={resources.runs}
            />
          ) : null}
          {area === "Library" ? (
            <LiveLibrary onFailure={reportFailure} />
          ) : null}
          {area === "Files" ? <LiveFiles onFailure={reportFailure} /> : null}
          {area === "Database" && canManageWorkspace ? (
            <LiveDatabase onFailure={reportFailure} />
          ) : null}
          {area === "Settings" && canManageWorkspace && actor ? (
            <LiveSettings
              actor={actor}
              onChanged={loadResources}
              onFailure={reportFailure}
              sessionExpiresAt={sessionExpiresAt}
              settings={resources.settings}
              users={resources.users}
              onCreateUser={() => setDialog("user")}
            />
          ) : null}
        </div>
      </main>
      <PresenceRail
        channelName={
          area === "Chat" ? (selectedChannel?.slug ?? "workspace") : "workspace"
        }
        groups={[
          {
            entries: resources.users.map((user, index) => ({
              accent: ["slate", "violet", "green", "peach"][index % 4]!,
              id: `person-${user.id}`,
              name: user.displayName,
              subtitle: `${user.id === actor?.id ? "You · " : ""}${user.role}`,
            })),
            label: "WORKSPACE PEOPLE",
          },
          {
            entries: resources.replicants.map((replicant, index) => ({
              accent: ["blue", "violet", "peach", "green"][index % 4]!,
              id: `replicant-${replicant.id}`,
              name: replicant.name,
              subtitle: `${replicant.defaultHarness} · ${replicant.status}`,
              online: replicant.status === "active",
            })),
            label: "REPLICANTS",
          },
        ]}
        onSelect={(entry) => {
          if (entry.id.startsWith("replicant-")) setArea("Runs");
        }}
        systemFacts={[
          {
            state: realtime === "online" ? "online" : "muted",
            text:
              realtime === "online"
                ? "Presence socket online"
                : "HTTP API connected",
          },
          { text: "SQLite source of truth" },
          { state: "muted", text: "Harness diagnostics unchecked" },
        ]}
      />
      {showNotifications ? (
        <aside className="notification-drawer" aria-label="Notifications">
          <header>
            <div>
              <small>OPERATOR INBOX</small>
              <h2>Notifications</h2>
            </div>
            <button
              aria-label="Close notifications"
              onClick={() => setShowNotifications(false)}
              type="button"
            >
              ×
            </button>
          </header>
          <div>
            {resources.notifications.length === 0 ? (
              <p className="live-empty">No notifications.</p>
            ) : (
              resources.notifications.map((notification) => (
                <article
                  className={notification.readAt === null ? "unread" : ""}
                  key={notification.id}
                >
                  <small>{notification.kind}</small>
                  <h3>{notification.title}</h3>
                  {notification.body ? <p>{notification.body}</p> : null}
                  <footer>
                    <time>
                      {new Date(notification.createdAt).toLocaleString()}
                    </time>
                    {notification.readAt === null ? (
                      <button
                        disabled={busy}
                        onClick={() =>
                          void runAction(async () => {
                            await api(
                              `/notifications/${notification.id}/read`,
                              {
                                method: "POST",
                              },
                            );
                            await loadResources();
                          })
                        }
                        type="button"
                      >
                        MARK READ
                      </button>
                    ) : (
                      <span>READ</span>
                    )}
                  </footer>
                </article>
              ))
            )}
          </div>
        </aside>
      ) : null}
      <nav className="mobile-nav" aria-label="Mobile product areas">
        {visibleProductAreas.map((item) => (
          <button
            className={area === item ? "active" : ""}
            key={item}
            onClick={() => setArea(item)}
            type="button"
          >
            {item}
          </button>
        ))}
      </nav>

      {dialog ? (
        <CreateDialog
          busy={busy}
          channels={resources.channels}
          kind={dialog}
          replicants={resources.replicants}
          onClose={() => setDialog(null)}
          onSubmit={(body) =>
            runAction(async () => {
              if (dialog === "replicant") {
                const submission = body as ReplicantDialogSubmission;
                try {
                  await createBoundReplicant(submission);
                } catch (bindingError) {
                  if (!(bindingError instanceof ReplicantBindingCreationError))
                    throw bindingError;
                  setDialog(null);
                  await loadResources();
                  throw new Error(
                    `Replicant created, but its channel binding failed: ${displayError(bindingError.bindingError)}`,
                  );
                }
                setDialog(null);
                await loadResources();
                return;
              }
              const path =
                dialog === "channel"
                  ? "/channels"
                  : dialog === "task"
                    ? "/tasks"
                    : dialog === "schedule"
                      ? "/schedules"
                      : "/users";
              await api(path, { body: jsonBody(body), method: "POST" });
              setDialog(null);
              await loadResources();
            })
          }
        />
      ) : null}
    </div>
  );
}

function LiveModuleContext({
  area,
  resources,
}: {
  area: ProductArea;
  resources: WorkspaceResources;
}) {
  if (area === "Chat") return null;

  let label = area.toUpperCase();
  let detail = descriptions[area];
  let items: { id: string; label: string; meta: string }[] = [];
  let summary: string[] = [];

  if (area === "Tasks") {
    const statuses: TaskStatus[] = ["backlog", "ready", "active", "blocked"];
    label = "TASK BOARD";
    items = statuses.map((status) => ({
      id: `task-status-${status}`,
      label: status,
      meta: String(
        resources.tasks.filter((task) => task.status === status).length,
      ),
    }));
    summary = [
      `${resources.tasks.length} durable tasks`,
      "Server-authorized mutations",
    ];
  } else if (area === "Scheduled") {
    label = "SCHEDULES";
    items = resources.schedules.slice(0, 7).map((schedule) => ({
      id: schedule.id,
      label: schedule.name,
      meta: schedule.status.toUpperCase(),
    }));
    summary = [
      `${resources.schedules.filter((schedule) => schedule.status === "enabled").length} enabled`,
      "Audited Run Now",
    ];
  } else if (area === "Runs") {
    label = "RUN HISTORY";
    items = resources.runs.slice(0, 8).map((run) => ({
      id: run.id,
      label:
        resources.replicants.find(
          (replicant) => replicant.id === run.replicantId,
        )?.name ?? run.harness,
      meta: run.status.toUpperCase(),
    }));
    summary = [
      `${resources.runs.length} durable runs`,
      `${resources.runs.filter((run) => run.status === "awaiting-approval").length} awaiting approval`,
    ];
  } else if (area === "Library") {
    label = "DOCUMENT LIBRARY";
    items = [
      { id: "approved-files", label: "Approved files", meta: "INDEX" },
      { id: "markdown", label: "Markdown", meta: "TEXT" },
      { id: "plain-text", label: "Plain text", meta: "TEXT" },
    ];
    summary = ["Configured safe root", "Explicit file selection"];
  } else if (area === "Files") {
    label = "APPROVED ROOTS";
    items = [
      { id: "workspace", label: "Replicant workspace", meta: "TEXT" },
      { id: "library", label: "Document library", meta: "TEXT" },
      { id: "containment", label: "Containment", meta: "REALPATH" },
    ];
    summary = ["Bounded file access", "Owner/admin writes"];
  } else if (area === "Database") {
    label = "SAFE TABLES";
    items = [
      { id: "workspaces", label: "workspaces", meta: "READ" },
      { id: "channels", label: "channels", meta: "READ" },
      { id: "messages", label: "messages", meta: "READ" },
      { id: "replicants", label: "replicants", meta: "READ" },
      { id: "runs", label: "runs", meta: "READ" },
      { id: "audit-log", label: "audit_log", meta: "READ" },
    ];
    summary = ["Allowlisted tables", "Protected columns masked"];
  } else if (area === "Settings") {
    label = "SETTINGS";
    items = [
      { id: "harnesses", label: "Harness runtimes", meta: "DOCTOR" },
      {
        id: "users",
        label: "Users & access",
        meta: String(resources.users.length),
      },
      { id: "workspace", label: "Workspace", meta: "LOCAL" },
      { id: "security", label: "Security", meta: "POLICY" },
    ];
    summary = [
      `${resources.replicants.length} Replicants`,
      "Provider credentials external",
    ];
  }

  return (
    <>
      <section className="context-section module-context">
        <header>
          <span>{label}</span>
        </header>
        <p>{detail}</p>
        <div className="module-context-list">
          {items.length === 0 ? (
            <p className="rail-empty">No records yet.</p>
          ) : (
            items.map((item, index) => (
              <div className={index === 0 ? "active" : ""} key={item.id}>
                <span>{item.label}</span>
                <small>{item.meta}</small>
              </div>
            ))
          )}
        </div>
      </section>
      <div className="context-summary">
        {summary.map((item) => (
          <span key={item}>{item}</span>
        ))}
        <small>Self-hosted · authenticated</small>
      </div>
    </>
  );
}

function Brand() {
  return (
    <div className="brand-block">
      <span className="brand-mark" aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
      <div>
        <strong>
          REPLICANT<span>OS</span>
        </strong>
        <small>LOCAL CONTROL PLANE</small>
      </div>
    </div>
  );
}

function SystemGate({
  children,
  detail,
  title,
}: {
  children?: React.ReactNode;
  detail: string;
  title: string;
}) {
  return (
    <main className="auth-shell">
      <section className="auth-card">
        <Brand />
        <small>SYSTEM STATE</small>
        <h1>{title}</h1>
        <p>{detail}</p>
        <div className="gate-actions">{children}</div>
      </section>
    </main>
  );
}

function SetupForm({
  busy,
  error,
  onSubmit,
}: {
  busy: boolean;
  error: string | null;
  onSubmit(values: {
    workspaceName: string;
    handle: string;
    displayName: string;
    password: string;
  }): Promise<void> | void;
}) {
  return (
    <main className="auth-shell">
      <form
        className="auth-card"
        onSubmit={(event) => {
          event.preventDefault();
          const values = new FormData(event.currentTarget);
          const password = field(values, "password");
          if (password !== field(values, "confirmation")) return;
          void onSubmit({
            workspaceName: field(values, "workspaceName"),
            handle: field(values, "handle"),
            displayName: field(values, "displayName"),
            password,
          });
        }}
      >
        <Brand />
        <small>FIRST-RUN SETUP</small>
        <h1>Create the owner</h1>
        <p>
          No default account exists. This owner is created locally and can add
          the rest of the team.
        </p>
        {error ? (
          <div className="form-error" role="alert">
            {error}
          </div>
        ) : null}
        <label>
          WORKSPACE
          <input
            name="workspaceName"
            defaultValue="ReplicantOS"
            maxLength={120}
            required
          />
        </label>
        <label>
          OWNER HANDLE
          <input
            name="handle"
            autoComplete="username"
            pattern="[a-z0-9][a-z0-9_-]{2,63}"
            placeholder="operator"
            required
          />
        </label>
        <label>
          DISPLAY NAME
          <input
            name="displayName"
            placeholder="Operator"
            maxLength={120}
            required
          />
        </label>
        <label>
          PASSWORD
          <input
            name="password"
            autoComplete="new-password"
            minLength={12}
            type="password"
            required
          />
        </label>
        <label>
          CONFIRM PASSWORD
          <input
            name="confirmation"
            autoComplete="new-password"
            minLength={12}
            type="password"
            required
          />
        </label>
        <button disabled={busy} type="submit">
          {busy ? "CREATING…" : "CREATE LOCAL WORKSPACE"}
        </button>
      </form>
    </main>
  );
}

function LoginForm({
  busy,
  error,
  onSubmit,
}: {
  busy: boolean;
  error: string | null;
  onSubmit(handle: string, password: string): Promise<void> | void;
}) {
  return (
    <main className="auth-shell">
      <form
        className="auth-card"
        onSubmit={(event) => {
          event.preventDefault();
          const values = new FormData(event.currentTarget);
          void onSubmit(field(values, "handle"), field(values, "password"));
        }}
      >
        <Brand />
        <small>AUTHENTICATION</small>
        <h1>Enter the control plane</h1>
        <p>
          Credentials are verified by the local server. Provider authentication
          remains in each harness.
        </p>
        {error ? (
          <div className="form-error" role="alert">
            {error}
          </div>
        ) : null}
        <label>
          HANDLE
          <input name="handle" autoComplete="username" required />
        </label>
        <label>
          PASSWORD
          <input
            name="password"
            autoComplete="current-password"
            type="password"
            required
          />
        </label>
        <button disabled={busy} type="submit">
          {busy ? "VERIFYING…" : "SIGN IN"}
        </button>
      </form>
    </main>
  );
}

function LiveChat({
  actor,
  busy,
  channel,
  messages,
  onSend,
  replicants,
  users,
}: {
  actor: Actor | null;
  busy: boolean;
  channel: Channel | null;
  messages: Message[];
  onSend(content: string): Promise<void> | void;
  replicants: Replicant[];
  users: Actor[];
}) {
  const people = new Map(users.map((user) => [user.id, user.displayName]));
  const agents = new Map(
    replicants.map((replicant) => [replicant.id, replicant.name]),
  );
  if (!channel)
    return (
      <PendingService
        title="Create a channel"
        detail="Channels are durable collaboration spaces for humans and Replicants."
      />
    );
  return (
    <div className="chat-layout">
      <div className="message-stream">
        <div className="history-marker">
          <span />
          <small>PERSISTED HISTORY</small>
          <span />
        </div>
        {messages.length === 0 ? (
          <div className="live-empty">
            No messages yet. Start the channel below.
          </div>
        ) : (
          messages.map((message) => {
            const author = message.authorUserId
              ? people.get(message.authorUserId)
              : message.authorReplicantId
                ? agents.get(message.authorReplicantId)
                : "System";
            return (
              <article
                className={`message ${message.authorKind}`}
                key={message.id}
              >
                <span
                  className={`avatar ${message.authorKind === "replicant" ? "accent-blue" : "accent-slate"}`}
                >
                  {author?.slice(0, 1) ?? "?"}
                </span>
                <div className="message-body">
                  <header>
                    <strong>{author ?? "Unknown actor"}</strong>
                    <span>{message.authorKind.toUpperCase()}</span>
                    <time>
                      {new Date(message.createdAt).toLocaleTimeString([], {
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </time>
                  </header>
                  <p>{message.content}</p>
                </div>
              </article>
            );
          })
        )}
      </div>
      <form
        className="composer"
        onSubmit={(event) => {
          event.preventDefault();
          const form = event.currentTarget;
          const values = new FormData(form);
          const content = field(values, "content");
          if (!content) return;
          void Promise.resolve(onSend(content)).then(() => form.reset());
        }}
      >
        <label htmlFor="live-message">Message #{channel.slug}</label>
        <textarea
          id="live-message"
          name="content"
          placeholder={`Write to #${channel.slug} as ${actor?.displayName ?? "this actor"}…`}
          rows={3}
          required
        />
        <div>
          <span>PERSISTED HISTORY · POLLING FOR REPLIES</span>
          <button className="send-button" disabled={busy} type="submit">
            SEND
          </button>
        </div>
      </form>
    </div>
  );
}

const taskColumns: TaskStatus[] = [
  "backlog",
  "ready",
  "active",
  "blocked",
  "done",
  "canceled",
];
const nextTaskStatus: Record<TaskStatus, TaskStatus> = {
  backlog: "ready",
  ready: "active",
  active: "done",
  blocked: "active",
  done: "done",
  canceled: "canceled",
};

function LiveTasks({
  busy,
  canManage,
  onCreate,
  onStatus,
  replicants,
  tasks,
  users,
}: {
  busy: boolean;
  canManage: boolean;
  onCreate(): void;
  onStatus(task: Task, status: TaskStatus): Promise<void> | void;
  replicants: Replicant[];
  tasks: Task[];
  users: Actor[];
}) {
  const names = new Map([
    ...users.map((user) => [user.id, user.displayName] as const),
    ...replicants.map((replicant) => [replicant.id, replicant.name] as const),
  ]);
  return (
    <section className="module-view">
      <div className="module-toolbar">
        <div>
          <button className="active" type="button">
            BOARD
          </button>
        </div>
        {canManage ? (
          <button className="primary-button" onClick={onCreate} type="button">
            + NEW TASK
          </button>
        ) : null}
      </div>
      <div className="task-grid live-task-grid">
        {taskColumns.map((status) => (
          <section className="task-column" key={status}>
            <header>
              <span>{status}</span>
              <em>{tasks.filter((task) => task.status === status).length}</em>
            </header>
            {tasks
              .filter((task) => task.status === status)
              .map((task) => (
                <article
                  className={`task-card priority-${task.priority}`}
                  key={task.id}
                >
                  <small>{task.priority}</small>
                  <h2>{task.title}</h2>
                  <div>
                    <span>
                      {names.get(
                        task.assigneeUserId ?? task.assigneeReplicantId ?? "",
                      ) ?? "Unassigned"}
                    </span>
                    {canManage &&
                    nextTaskStatus[task.status] !== task.status ? (
                      <button
                        disabled={busy}
                        onClick={() =>
                          void onStatus(task, nextTaskStatus[task.status])
                        }
                        type="button"
                      >
                        → {nextTaskStatus[task.status]}
                      </button>
                    ) : null}
                  </div>
                </article>
              ))}
          </section>
        ))}
      </div>
    </section>
  );
}

function LiveSchedules({
  busy,
  canManage,
  onCreate,
  onRun,
  replicants,
  runs,
  schedules,
}: {
  busy: boolean;
  canManage: boolean;
  onCreate(): void;
  onRun(schedule: Schedule): Promise<void> | void;
  replicants: Replicant[];
  runs: Run[];
  schedules: Schedule[];
}) {
  const names = new Map(
    replicants.map((replicant) => [replicant.id, replicant.name]),
  );
  return (
    <section className="module-view">
      <div className="stats-row">
        <LiveStat
          label="ENABLED"
          value={String(
            schedules.filter((schedule) => schedule.status === "enabled")
              .length,
          ).padStart(2, "0")}
        />
        <LiveStat
          label="ACTIVE RUNS"
          value={String(
            runs.filter((run) =>
              ["queued", "starting", "running", "awaiting-approval"].includes(
                run.status,
              ),
            ).length,
          ).padStart(2, "0")}
        />
        <LiveStat
          label="REPLICANTS"
          value={String(replicants.length).padStart(2, "0")}
        />
        <LiveStat label="EXECUTION" value="AUDITED" />
      </div>
      <div className="module-toolbar">
        <div>
          <button className="active" type="button">
            SCHEDULES
          </button>
        </div>
        {canManage ? (
          <button className="primary-button" onClick={onCreate} type="button">
            + NEW SCHEDULE
          </button>
        ) : null}
      </div>
      <div className="schedule-list">
        {schedules.length === 0 ? (
          <div className="live-empty">
            No readable schedules are configured.
          </div>
        ) : (
          schedules.map((schedule) => (
            <article key={schedule.id}>
              <span
                className={`schedule-state ${schedule.status === "enabled" ? "healthy" : ""}`}
              >
                <i />
              </span>
              <div>
                <small>
                  {names.get(schedule.replicantId) ?? "Replicant"} ·{" "}
                  {schedule.harnessOverride ?? "default harness"}
                </small>
                <h2>{schedule.name}</h2>
                <code>
                  {schedule.cronExpression} · {schedule.timezone}
                </code>
              </div>
              <div>
                <small>LAST RUN</small>
                <strong>
                  {schedule.lastRunAt
                    ? new Date(schedule.lastRunAt).toLocaleString()
                    : "Never"}
                </strong>
              </div>
              <div>
                <small>NEXT RUN</small>
                <strong>
                  {schedule.nextRunAt
                    ? new Date(schedule.nextRunAt).toLocaleString()
                    : "Unscheduled"}
                </strong>
              </div>
              {canManage ? (
                <button
                  disabled={busy}
                  onClick={() => void onRun(schedule)}
                  type="button"
                >
                  RUN NOW
                </button>
              ) : null}
            </article>
          ))
        )}
      </div>
    </section>
  );
}

function PendingService({ detail, title }: { detail: string; title: string }) {
  return (
    <section className="module-view pending-service">
      <small>SECURE SERVICE BOUNDARY</small>
      <h2>{title}</h2>
      <p>{detail}</p>
      <div>
        <span className="status-dot" /> Configuration required
      </div>
    </section>
  );
}

function LiveStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="stat">
      <small>{label}</small>
      <strong>{value}</strong>
    </div>
  );
}

export function CreateDialog({
  busy,
  channels,
  kind,
  onClose,
  onSubmit,
  replicants,
}: {
  busy: boolean;
  channels: Channel[];
  kind: Exclude<DialogKind, null>;
  onClose(): void;
  onSubmit(body: unknown): Promise<void> | void;
  replicants: Replicant[];
}) {
  return (
    <div className="modal-backdrop" role="presentation">
      <form
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="dialog-title"
        onSubmit={(event) => {
          event.preventDefault();
          const values = new FormData(event.currentTarget);
          let body: unknown;
          if (kind === "channel")
            body = {
              categoryId: null,
              kind: "standard",
              slug: field(values, "slug"),
              name: field(values, "name"),
              description: field(values, "description") || null,
            };
          else if (kind === "replicant")
            body = {
              binding: {
                behavior: field(values, "bindingBehavior"),
                channelId: field(values, "bindingChannelId"),
              },
              replicant: {
                slug: field(values, "slug"),
                name: field(values, "name"),
                description: field(values, "description") || null,
                persona: field(values, "persona"),
                defaultHarness: field(values, "defaultHarness"),
                defaultModel: null,
              },
            };
          else if (kind === "task")
            body = {
              projectId: null,
              title: field(values, "title"),
              notes: field(values, "notes") || null,
              status: "backlog",
              priority: field(values, "priority"),
              dueAt: null,
              assigneeUserId: null,
              assigneeReplicantId: field(values, "assigneeReplicantId") || null,
            };
          else if (kind === "schedule")
            body = {
              name: field(values, "name"),
              description: null,
              cronExpression: field(values, "cronExpression"),
              timezone: field(values, "timezone"),
              status: "enabled",
              replicantId: field(values, "replicantId"),
              channelId: field(values, "channelId") || null,
              taskId: null,
              harnessOverride: null,
              modelOverride: null,
              effortOverride: null,
              prompt: field(values, "prompt"),
              retryPolicy: { maxAttempts: 1 },
              outcomeAssertions: {},
            };
          else
            body = {
              kind: "human",
              handle: field(values, "handle"),
              displayName: field(values, "displayName"),
              role: field(values, "role"),
              password: field(values, "password"),
            };
          void onSubmit(body);
        }}
      >
        <header>
          <small>CREATE // {kind.toUpperCase()}</small>
          <h2 id="dialog-title">New {kind}</h2>
          <button onClick={onClose} type="button" aria-label="Close dialog">
            ×
          </button>
        </header>
        {kind === "channel" ? (
          <>
            <label>
              SLUG
              <input name="slug" pattern="[a-z0-9][a-z0-9-]*" required />
            </label>
            <label>
              NAME
              <input name="name" required />
            </label>
            <label>
              DESCRIPTION
              <textarea name="description" rows={3} />
            </label>
          </>
        ) : null}
        {kind === "replicant" ? (
          <>
            <label>
              SLUG
              <input name="slug" pattern="[a-z0-9][a-z0-9-]*" required />
            </label>
            <label>
              NAME
              <input name="name" required />
            </label>
            <label>
              HARNESS
              <select name="defaultHarness" defaultValue="codex">
                <option value="codex">Codex</option>
                <option value="claude">Claude Agent SDK</option>
                <option value="opencode">OpenCode</option>
                <option value="grok">Grok Build</option>
              </select>
            </label>
            <label>
              CHANNEL
              <select
                defaultValue={channels[0]?.id ?? ""}
                name="bindingChannelId"
                required
              >
                {channels.length === 0 ? (
                  <option value="">Create a channel first</option>
                ) : null}
                {channels.map((channel) => (
                  <option key={channel.id} value={channel.id}>
                    {channel.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              CHANNEL BEHAVIOR
              <select name="bindingBehavior" defaultValue="mention-only">
                <option value="mention-only">Mention only</option>
                <option value="automatic">Automatic</option>
              </select>
            </label>
            <p className="modal-note">
              Automatic responds to every eligible channel message. Mention only
              responds to its @slug or exact @name.
            </p>
            <label>
              DESCRIPTION
              <textarea name="description" rows={2} />
            </label>
            <label>
              PERSONA
              <textarea name="persona" rows={5} required />
            </label>
          </>
        ) : null}
        {kind === "task" ? (
          <>
            <label>
              TITLE
              <input name="title" required />
            </label>
            <label>
              PRIORITY
              <select name="priority" defaultValue="normal">
                <option value="low">Low</option>
                <option value="normal">Normal</option>
                <option value="high">High</option>
                <option value="urgent">Urgent</option>
              </select>
            </label>
            <label>
              ASSIGNEE
              <select name="assigneeReplicantId" defaultValue="">
                <option value="">Unassigned</option>
                {replicants.map((replicant) => (
                  <option key={replicant.id} value={replicant.id}>
                    {replicant.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              NOTES
              <textarea name="notes" rows={5} />
            </label>
          </>
        ) : null}
        {kind === "schedule" ? (
          <>
            <label>
              NAME
              <input name="name" required />
            </label>
            <label>
              REPLICANT
              <select name="replicantId" required>
                {replicants.map((replicant) => (
                  <option key={replicant.id} value={replicant.id}>
                    {replicant.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              CHANNEL
              <select name="channelId" defaultValue="">
                <option value="">None</option>
                {channels.map((channel) => (
                  <option key={channel.id} value={channel.id}>
                    {channel.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              CRON
              <input name="cronExpression" defaultValue="0 9 * * 1" required />
            </label>
            <label>
              TIMEZONE
              <input
                name="timezone"
                defaultValue={Intl.DateTimeFormat().resolvedOptions().timeZone}
                required
              />
            </label>
            <label>
              PROMPT
              <textarea name="prompt" rows={5} required />
            </label>
          </>
        ) : null}
        {kind === "user" ? (
          <>
            <label>
              HANDLE
              <input
                name="handle"
                pattern="[a-z0-9][a-z0-9_-]{2,63}"
                required
              />
            </label>
            <label>
              DISPLAY NAME
              <input name="displayName" required />
            </label>
            <label>
              ROLE
              <select name="role" defaultValue="member">
                <option value="member">Member</option>
                <option value="admin">Admin</option>
              </select>
            </label>
            <label>
              INITIAL PASSWORD
              <input name="password" minLength={12} type="password" required />
            </label>
          </>
        ) : null}
        <footer>
          <button onClick={onClose} type="button">
            CANCEL
          </button>
          <button
            className="primary-button"
            disabled={busy || (kind === "replicant" && channels.length === 0)}
            type="submit"
          >
            {busy ? "CREATING…" : "CREATE"}
          </button>
        </footer>
      </form>
    </div>
  );
}
