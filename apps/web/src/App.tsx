import { useMemo, useState } from "react";
import { ChevronDown, Gauge, MoreHorizontal, Plus, X } from "lucide-react";
import {
  demoChannels,
  demoDocuments,
  demoMessages,
  demoPeople,
  demoProviders,
  demoReplicants,
  demoRuns,
  demoSchedules,
  demoTasks,
} from "./demo.js";
import {
  BrandGlyph,
  ChannelHash,
  NotificationGlyph,
  PresenceRail,
  ProductIcon,
  productAreaNames,
  type ProductAreaName,
} from "./ShellChrome.js";

const screens = productAreaNames;
type Screen = ProductAreaName;

const screenDescriptions: Record<Screen, string> = {
  Chat: "Shared channel · 4 Replicants",
  Tasks: "Human and agent work queue",
  Scheduled: "Reliable background execution",
  Runs: "Durable history, projections, and approvals",
  Library: "Approved documents and artifacts",
  Files: "Atlas workspace · safe root",
  Database: "Read-only · protected columns masked",
  Settings: "Workspace and harness configuration",
};

function initialDemoScreen(): Screen {
  const requested = new URLSearchParams(location.search).get("screen");
  return (
    screens.find(
      (screen) => screen.toLowerCase() === requested?.toLowerCase(),
    ) ?? "Chat"
  );
}

export function App() {
  const [screen, setScreen] = useState<Screen>(initialDemoScreen);
  const [channel, setChannel] = useState("product");
  const [selectedProfile, setSelectedProfile] = useState<string | null>(null);
  const unread = useMemo(
    () => demoChannels.reduce((total, item) => total + item.unread, 0),
    [],
  );
  const profile = demoReplicants.find(
    (replicant) => replicant.name === selectedProfile,
  );

  return (
    <div className="app-frame">
      <aside className="workspace-rail" aria-label="Workspace navigation">
        <button
          aria-label="Open chat"
          className="rail-logo"
          onClick={() => setScreen("Chat")}
          title="ReplicantOS"
          type="button"
        >
          <BrandGlyph />
        </button>
        <div className="rail-divider" />

        <nav className="primary-nav" aria-label="Product areas">
          {screens.map((item) => (
            <button
              aria-label={item}
              className={screen === item ? "nav-item active" : "nav-item"}
              key={item}
              onClick={() => setScreen(item)}
              title={item}
              type="button"
            >
              <ProductIcon area={item} />
              <span className="nav-label">{item}</span>
              {item === "Chat" && unread > 0 ? <em>{unread}</em> : null}
            </button>
          ))}
        </nav>

        <button className="rail-user" title="Demo Owner" type="button">
          <span className="avatar round accent-slate">
            D<i />
          </span>
        </button>
      </aside>

      <aside className="context-rail" aria-label="Channels and Replicants">
        <div className="context-heading">
          <span>
            <strong>ReplicantOS</strong>
            <small>Demo workspace</small>
          </span>
          <ChevronDown aria-hidden="true" size={16} />
        </div>

        <div className="demo-disclosure">
          <i />
          <span>SYNTHETIC DATA</span>
        </div>

        {screen === "Chat" ? (
          <>
            <section className="context-section">
              <header>
                <span>CHANNELS</span>
                <button type="button" aria-label="Create channel">
                  <Plus aria-hidden="true" size={14} />
                </button>
              </header>
              {["Workspace", "Projects", "Knowledge"].map((category) => (
                <div className="channel-group" key={category}>
                  <small>
                    <ChevronDown aria-hidden="true" size={11} /> {category}
                  </small>
                  {demoChannels
                    .filter((item) => item.category === category)
                    .map((item) => (
                      <button
                        aria-label={`# ${item.name}`}
                        className={
                          channel === item.name ? "channel active" : "channel"
                        }
                        key={item.name}
                        onClick={() => setChannel(item.name)}
                        type="button"
                      >
                        <ChannelHash size={17} />
                        {item.name}
                        {item.unread ? <em>{item.unread}</em> : null}
                      </button>
                    ))}
                </div>
              ))}
            </section>
            <div className="context-summary">
              <span>4 Replicants</span>
              <span>4 harness adapters</span>
              <small>Static preview · no runtimes invoked</small>
            </div>
          </>
        ) : (
          <DemoModuleContext screen={screen} />
        )}
      </aside>

      <main className="main-panel">
        <header className="panel-header">
          <div className="panel-title">
            {screen === "Chat" ? (
              <ChannelHash size={24} />
            ) : (
              <ProductIcon area={screen} size={22} />
            )}
            <div>
              <h1 aria-label={screen === "Chat" ? `#${channel}` : undefined}>
                {screen === "Chat" ? channel : screen}
              </h1>
              <p>{screenDescriptions[screen]}</p>
            </div>
          </div>
          {screen === "Chat" ? (
            <select
              aria-label="Select channel"
              className="mobile-context-select"
              onChange={(event) => setChannel(event.target.value)}
              value={channel}
            >
              {demoChannels.map((item) => (
                <option key={item.name} value={item.name}>
                  #{item.name}
                </option>
              ))}
            </select>
          ) : null}
          <div className="header-actions">
            <span className="header-mode">
              <Gauge aria-hidden="true" size={15} /> Normal
            </span>
            <span>
              <i className="status-dot offline" /> Offline preview
            </span>
            <button className="notification-button" type="button">
              <NotificationGlyph />
              <em>{unread}</em>
              <span className="sr-only">Synthetic notifications</span>
            </button>
          </div>
        </header>

        <div className="panel-content">
          {screen === "Chat" ? <ChatScreen channel={channel} /> : null}
          {screen === "Tasks" ? <TasksScreen /> : null}
          {screen === "Scheduled" ? <ScheduledScreen /> : null}
          {screen === "Runs" ? <RunsScreen /> : null}
          {screen === "Library" ? <LibraryScreen /> : null}
          {screen === "Files" ? <FilesScreen /> : null}
          {screen === "Database" ? <DatabaseScreen /> : null}
          {screen === "Settings" ? <SettingsScreen /> : null}
        </div>
      </main>

      <PresenceRail
        channelName={screen === "Chat" ? channel : "workspace"}
        groups={[
          {
            entries: demoPeople.map((person, index) => ({
              accent: person.accent,
              id: `person-${index}`,
              name: person.name,
              subtitle: person.role,
            })),
            label: "PEOPLE",
          },
          {
            entries: demoReplicants
              .filter((replicant) => replicant.mode === "automatic")
              .map((replicant) => ({
                accent: replicant.accent,
                id: `replicant-${replicant.name}`,
                name: replicant.name,
                subtitle: `${replicant.harness} · Automatic`,
              })),
            label: "AUTOMATIC",
          },
          {
            entries: demoReplicants
              .filter((replicant) => replicant.mode === "mention-only")
              .map((replicant) => ({
                accent: replicant.accent,
                id: `replicant-${replicant.name}`,
                name: replicant.name,
                subtitle: `${replicant.harness} · Mention only`,
              })),
            label: "MENTION ONLY",
          },
        ]}
        onSelect={(entry) => {
          if (entry.id.startsWith("replicant-")) setSelectedProfile(entry.name);
        }}
        systemFacts={[
          { state: "muted", text: "Static preview" },
          { text: "Synthetic fixture loaded" },
          { state: "muted", text: "Harnesses not invoked" },
        ]}
      />

      {profile && screen === "Chat" ? (
        <aside className="profile-card" aria-label={`${profile.name} profile`}>
          <div className={`profile-banner accent-${profile.accent}`} />
          <button
            aria-label="Close profile"
            className="profile-close"
            onClick={() => setSelectedProfile(null)}
            type="button"
          >
            <X aria-hidden="true" size={16} />
          </button>
          <span className={`avatar profile-avatar accent-${profile.accent}`}>
            {profile.name.slice(0, 1)}
          </span>
          <div className="profile-content">
            <header>
              <div>
                <h2>{profile.name}</h2>
                <span>REPLICANT</span>
              </div>
              <button aria-label="More profile actions" type="button">
                <MoreHorizontal aria-hidden="true" size={18} />
              </button>
            </header>
            <dl>
              <div>
                <dt>HARNESS</dt>
                <dd>{profile.harness}</dd>
              </div>
              <div>
                <dt>CHANNEL MODE</dt>
                <dd>{profile.mode}</dd>
              </div>
              <div>
                <dt>MODEL</dt>
                <dd>Provider default</dd>
              </div>
            </dl>
            <div className="profile-channels">
              <span># product (automatic)</span>
              <span># release-gate (mention)</span>
            </div>
            <footer>
              <button
                className="primary-button"
                onClick={() => {
                  setSelectedProfile(null);
                  setScreen("Runs");
                }}
                type="button"
              >
                VIEW RUNS
              </button>
              <button onClick={() => setSelectedProfile(null)} type="button">
                CLOSE
              </button>
            </footer>
          </div>
        </aside>
      ) : null}

      <nav className="mobile-nav" aria-label="Mobile product areas">
        {screens.map((item) => (
          <button
            className={screen === item ? "active" : ""}
            key={item}
            onClick={() => setScreen(item)}
            type="button"
          >
            {item}
          </button>
        ))}
      </nav>
    </div>
  );
}

const moduleContextContent: Record<
  Exclude<Screen, "Chat">,
  {
    detail: string;
    items: readonly { label: string; meta: string }[];
    label: string;
    summary: readonly string[];
  }
> = {
  Database: {
    detail: "Protected tables excluded",
    items: [
      { label: "workspaces", meta: "4 COL" },
      { label: "channels", meta: "9 COL" },
      { label: "messages", meta: "10 COL" },
      { label: "replicants", meta: "12 COL" },
      { label: "runs", meta: "20 COL" },
      { label: "audit_log", meta: "9 COL" },
    ],
    label: "SAFE TABLES",
    summary: ["12 allowlisted tables", "Read-only connection"],
  },
  Files: {
    detail: "Contained host paths",
    items: [
      { label: "Atlas workspace", meta: "ACTIVE" },
      { label: "docs", meta: "2 FILES" },
      { label: "reports", meta: "1 FILE" },
      { label: "skills", meta: "FOLDER" },
      { label: "memory", meta: "FOLDER" },
    ],
    label: "APPROVED ROOT",
    summary: ["Realpath containment", "Text editing only"],
  },
  Library: {
    detail: "Approved text documents",
    items: [
      { label: "All documents", meta: "3" },
      { label: "Markdown", meta: "2" },
      { label: "Plain text", meta: "1" },
      { label: "Indexed source", meta: "SAFE ROOT" },
    ],
    label: "DOCUMENT LIBRARY",
    summary: ["3 indexed documents", "Explicit file selection"],
  },
  Runs: {
    detail: "Durable runtime records",
    items: demoRuns.map((run) => ({
      label: run.replicant,
      meta: run.status.toUpperCase(),
    })),
    label: "RUN HISTORY",
    summary: ["1 queued", "1 pending approval"],
  },
  Scheduled: {
    detail: "Timezone-aware definitions",
    items: demoSchedules.map((schedule) => ({
      label: schedule.name,
      meta: schedule.state.toUpperCase(),
    })),
    label: "SCHEDULES",
    summary: ["3 enabled", "Run Now available"],
  },
  Settings: {
    detail: "Owner and admin controls",
    items: [
      { label: "Harness runtimes", meta: "4" },
      { label: "Users & access", meta: "3" },
      { label: "Workspace", meta: "LOCAL" },
      { label: "Security", meta: "POLICY" },
    ],
    label: "SETTINGS",
    summary: ["Diagnostics on demand", "No stored provider keys"],
  },
  Tasks: {
    detail: "Human and Replicant work",
    items: [
      { label: "Backlog", meta: "1" },
      { label: "Active", meta: "1" },
      { label: "Blocked", meta: "1" },
      { label: "Done", meta: "1" },
    ],
    label: "TASK BOARD",
    summary: ["4 durable tasks", "Replicant assignment"],
  },
};

function DemoModuleContext({ screen }: { screen: Screen }) {
  if (screen === "Chat") return null;
  const content = moduleContextContent[screen];
  return (
    <>
      <section className="context-section module-context">
        <header>
          <span>{content.label}</span>
        </header>
        <p>{content.detail}</p>
        <div className="module-context-list">
          {content.items.map((item, index) => (
            <div className={index === 0 ? "active" : ""} key={item.label}>
              <span>{item.label}</span>
              <small>{item.meta}</small>
            </div>
          ))}
        </div>
      </section>
      <div className="context-summary">
        {content.summary.map((item) => (
          <span key={item}>{item}</span>
        ))}
        <small>Synthetic preview · feature-backed</small>
      </div>
    </>
  );
}

function ChatScreen({ channel }: { channel: string }) {
  return (
    <div className="chat-layout">
      <div className="message-stream">
        <div className="history-marker">
          <span /> <small>PERSISTED HISTORY</small>
          <span />
        </div>
        {demoMessages.map((message) => (
          <article
            className={`message ${message.kind}`}
            key={`${message.author}-${message.time}`}
          >
            <span
              className={`avatar ${message.kind === "human" ? "accent-slate" : "accent-blue"}`}
            >
              {message.author.slice(0, 1)}
            </span>
            <div className="message-body">
              <header>
                <strong>{message.author}</strong>
                {"meta" in message && message.meta ? (
                  <span>{message.meta}</span>
                ) : null}
                <time>{message.time}</time>
              </header>
              <p>{message.body}</p>
            </div>
          </article>
        ))}
      </div>
      <form className="composer" onSubmit={(event) => event.preventDefault()}>
        <div className="mention-chip">
          @ Atlas{" "}
          <button type="button" aria-label="Remove mention">
            ×
          </button>
        </div>
        <label htmlFor="message-input">Message #{channel}</label>
        <textarea
          id="message-input"
          placeholder="Ask a Replicant or write to the channel…"
          rows={2}
        />
        <div>
          <span>PERSISTED TEXT · POLLING FOR REPLIES</span>
          <button className="send-button" type="submit">
            SEND
          </button>
        </div>
      </form>
    </div>
  );
}

function TasksScreen() {
  return (
    <section className="module-view">
      <div className="module-toolbar">
        <div>
          <button className="active" type="button">
            BOARD
          </button>
        </div>
        <button className="primary-button" type="button">
          + NEW TASK
        </button>
      </div>
      <div className="task-grid">
        {["backlog", "active", "blocked", "done"].map((status) => (
          <section className="task-column" key={status}>
            <header>
              <span>{status.replace("_", " ")}</span>
              <em>
                {demoTasks.filter((task) => task.status === status).length}
              </em>
            </header>
            {demoTasks
              .filter((task) => task.status === status)
              .map((task) => (
                <article
                  className={`task-card priority-${task.priority}`}
                  key={task.title}
                >
                  <small>{task.priority}</small>
                  <h2>{task.title}</h2>
                  <div>
                    <span className="avatar mini accent-blue">
                      {task.assignee.slice(0, 1)}
                    </span>
                    <span>{task.assignee}</span>
                  </div>
                </article>
              ))}
          </section>
        ))}
      </div>
    </section>
  );
}

function ScheduledScreen() {
  return (
    <section className="module-view">
      <div className="stats-row">
        <Stat label="ENABLED" value="03" />
        <Stat label="ACTIVE RUNS" value="01" accent="green" />
        <Stat label="REPLICANTS" value="04" />
        <Stat label="EXECUTION" value="AUDITED" />
      </div>
      <div className="module-toolbar">
        <div>
          <button className="active" type="button">
            SCHEDULES
          </button>
        </div>
        <button className="primary-button" type="button">
          + NEW SCHEDULE
        </button>
      </div>
      <div className="schedule-list">
        {demoSchedules.map((schedule) => (
          <article key={schedule.name}>
            <span className={`schedule-state ${schedule.state}`}>
              <i />
            </span>
            <div>
              <small>
                {schedule.replicant} · {schedule.harness}
              </small>
              <h2>{schedule.name}</h2>
              <code>{schedule.schedule}</code>
            </div>
            <div>
              <small>LAST OUTCOME</small>
              <strong>{schedule.last}</strong>
            </div>
            <div>
              <small>NEXT RUN</small>
              <strong>{schedule.next}</strong>
            </div>
            <button type="button">RUN NOW</button>
          </article>
        ))}
      </div>
    </section>
  );
}

function RunsScreen() {
  return (
    <section className="module-view live-runs">
      <div className="stats-row">
        <Stat label="HISTORY" value="03" />
        <Stat label="ACTIVE" value="01" />
        <Stat label="PENDING APPROVALS" value="01" />
        <Stat label="SOURCE" value="DURABLE" />
      </div>
      <div className="module-toolbar">
        <div>
          <button className="active" type="button">
            RUN HISTORY
          </button>
        </div>
        <button type="button">REFRESH</button>
      </div>
      <div className="runs-workspace">
        <div className="run-history" aria-label="Durable run history">
          {demoRuns.map((run, index) => (
            <button
              className={index === 0 ? "selected" : ""}
              key={`${run.replicant}-${run.time}`}
              type="button"
            >
              <span className={`run-status ${run.status}`}>{run.status}</span>
              <strong>{run.replicant}</strong>
              <small>
                {run.harness} · {run.trigger}
              </small>
              <time>{run.time}</time>
            </button>
          ))}
        </div>
        <div className="run-detail">
          <header>
            <div>
              <small>RUN DETAIL</small>
              <h2>Atlas</h2>
              <code>run_synthetic_release01</code>
            </div>
            <span className="run-status succeeded">succeeded</span>
          </header>
          <div className="run-facts">
            <div>
              <small>HARNESS</small>
              <strong>codex</strong>
            </div>
            <div>
              <small>MODEL</small>
              <strong>Provider default</strong>
            </div>
            <div>
              <small>STARTED</small>
              <strong>08:41</strong>
            </div>
            <div>
              <small>FINISHED</small>
              <strong>08:42</strong>
            </div>
          </div>
          <section className="run-projection">
            <header>
              <div>
                <small>DURABLE RUNTIME PROJECTION</small>
                <h3>succeeded</h3>
              </div>
            </header>
            <div>
              <span>INPUT 2,184</span>
              <span>CACHED 1,024</span>
              <span>OUTPUT 642</span>
              <span>COST $0.0124</span>
            </div>
            <article>
              <small>PERSISTED ASSISTANT OUTPUT</small>
              <p>
                Release requirements mapped and recorded in the Product channel.
              </p>
            </article>
          </section>
          <section className="run-events">
            <h3>PERSISTED EVENTS</h3>
            <article>
              <code>001</code>
              <strong>run.state</strong>
              <time>08:41</time>
            </article>
            <article>
              <code>002</code>
              <strong>assistant.delta</strong>
              <time>08:42</time>
            </article>
          </section>
        </div>
      </div>
      <section className="approval-queue">
        <header>
          <div>
            <small>PROVIDER DECISIONS</small>
            <h2>Pending approvals</h2>
          </div>
        </header>
        <article>
          <div>
            <strong>Write release evidence file</strong>
            <code>run_synthetic_review01</code>
            <small>Expires 09:15</small>
          </div>
          <div>
            <button type="button">DENY</button>
            <button className="primary-button" type="button">
              ALLOW
            </button>
          </div>
        </article>
      </section>
    </section>
  );
}

function LibraryScreen() {
  return (
    <section className="module-view split-view">
      <div className="document-list">
        <div className="module-toolbar">
          <input
            aria-label="Search indexed documents"
            placeholder="Search indexed documents"
          />
          <button type="button">REFRESH</button>
        </div>
        <div className="index-document-form">
          <label>APPROVED LIBRARY FILE</label>
          <select
            aria-label="Approved library file"
            defaultValue="reports/release-verification.md"
          >
            <option>reports/release-verification.md</option>
            <option>reports/harness-capabilities.txt</option>
            <option>reports/security-boundary.md</option>
          </select>
          <button className="primary-button" type="button">
            INDEX / REINDEX
          </button>
        </div>
        {demoDocuments.map((document, index) => (
          <button
            className={index === 0 ? "document-row active" : "document-row"}
            key={document.path}
            type="button"
          >
            <span>{document.format}</span>
            <div>
              <strong>{document.title}</strong>
              <small>{document.path}</small>
            </div>
            <time>{document.modified}</time>
          </button>
        ))}
      </div>
      <article className="document-preview">
        <small>REPORT // VERIFIED</small>
        <h2>Public release verification</h2>
        <p className="lead">
          Evidence for every release requirement, generated from the isolated
          demo workspace.
        </p>
        <h3>Current state</h3>
        <ul>
          <li>
            <span className="check">✓</span> Independent source and Git history
          </li>
          <li>
            <span className="check">✓</span> Synthetic fixtures only
          </li>
          <li>
            <span className="check">✓</span> Harness contract tests
          </li>
          <li>
            <span className="pending">○</span> Final browser capture review
          </li>
        </ul>
      </article>
    </section>
  );
}

function FilesScreen() {
  return (
    <section className="module-view split-view files-view">
      <div className="file-tree">
        <header>
          <span>ATLAS / WORKSPACE</span>
          <button type="button">+</button>
        </header>
        <button type="button">⌄ docs</button>
        <button className="nested active" type="button">
          release-plan.md
        </button>
        <button className="nested" type="button">
          architecture.md
        </button>
        <button type="button">⌄ reports</button>
        <button className="nested" type="button">
          verification.md
        </button>
        <button type="button">› skills</button>
        <button type="button">› memory</button>
      </div>
      <div className="editor">
        <header>
          <span>release-plan.md</span>
          <div>
            <button className="primary-button" type="button">
              SAVE
            </button>
          </div>
        </header>
        <pre>
          <span>01</span> # Public launch plan{`\n`}
          <span>02</span>
          {`\n`}
          <span>03</span> Every artifact is generated from the demo workspace.
          {`\n`}
          <span>04</span>
          {`\n`}
          <span>05</span> - [x] Create independent history{`\n`}
          <span>06</span> - [x] Normalize harness contracts{`\n`}
          <span>07</span> - [ ] Capture final product evidence
        </pre>
      </div>
    </section>
  );
}

function DatabaseScreen() {
  return (
    <section className="module-view split-view database-view">
      <div className="table-list">
        <header>
          SAFE TABLES <span>12</span>
        </header>
        {[
          ["workspaces", 4],
          ["users", 9],
          ["channels", 9],
          ["messages", 10],
          ["replicants", 12],
          ["projects", 6],
          ["tasks", 12],
          ["schedules", 19],
          ["runs", 20],
          ["notifications", 9],
          ["artifacts", 10],
          ["audit_log", 9],
        ].map(([table, columns], index) => (
          <button
            className={index === 0 ? "active" : ""}
            key={table}
            type="button"
          >
            <span>▦</span>
            {table}
            <em>{columns} COL</em>
          </button>
        ))}
        <div className="protected-note">
          <span>⊘</span>
          <p>
            <strong>PROTECTED DATA HIDDEN</strong>Credential and session tables
            are excluded. Sensitive allowlisted columns are masked.
          </p>
        </div>
      </div>
      <div className="data-panel">
        <div className="query-bar">
          <code>ALLOWLIST workspaces · LIMIT 50 · OFFSET 0</code>
          <button type="button">REFRESH</button>
        </div>
        <table>
          <thead>
            <tr>
              <th>id</th>
              <th>slug</th>
              <th>display_name ◌</th>
              <th>created_at</th>
            </tr>
          </thead>
          <tbody>
            {[
              [
                "wsp_synthetic01",
                "synthetic-workspace",
                "[masked]",
                "2026-08-02T13:00:00.000Z",
              ],
            ].map((row) => (
              <tr key={row[0]}>
                {row.map((cell) => (
                  <td key={cell}>
                    <code>{cell}</code>
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        <footer>1 ROWS · READ-ONLY · WORKSPACE-SCOPED</footer>
      </div>
    </section>
  );
}

function SettingsScreen() {
  const [section, setSection] = useState("Harness runtimes");
  const settingsSections = [
    "Harness runtimes",
    "Users & access",
    "Workspace",
    "Security",
  ];

  return (
    <section className="module-view settings-view">
      <div className="settings-nav">
        {settingsSections.map((item) => (
          <button
            className={section === item ? "active" : ""}
            key={item}
            onClick={() => setSection(item)}
            type="button"
          >
            {item}
          </button>
        ))}
      </div>
      {section === "Harness runtimes" ? <HarnessSettings /> : null}
      {section === "Users & access" ? <AccessSettings /> : null}
      {!["Harness runtimes", "Users & access"].includes(section) ? (
        <SettingsPlaceholder section={section} />
      ) : null}
    </section>
  );
}

function HarnessSettings() {
  return (
    <div className="settings-content">
      <header>
        <small>RUNTIME CONTROL</small>
        <h2>Harnesses</h2>
        <p>
          Replicants use provider-native authentication. Credentials remain
          outside the ReplicantOS database.
        </p>
        <button className="harness-diagnostics-button" disabled type="button">
          RUN DIAGNOSTICS · LIVE SERVER
        </button>
      </header>
      <div className="provider-grid">
        {demoProviders.map((provider) => (
          <article key={provider.name}>
            <div>
              <span className="provider-glyph">
                {provider.name.slice(0, 2).toUpperCase()}
              </span>
              <span>
                <strong>{provider.name}</strong>
                <small>
                  {provider.transport} · {provider.maturity}
                </small>
              </span>
              <em>NOT CHECKED</em>
            </div>
            <p>{provider.capability}</p>
            <footer>
              <span>HOST-NATIVE CREDENTIALS · NOT STORED HERE</span>
            </footer>
          </article>
        ))}
      </div>
    </div>
  );
}

function AccessSettings() {
  const actors = [
    {
      grants: "All workspace resources",
      identity: "Operator",
      role: "Owner",
      state: "Active",
    },
    {
      grants: "#product · Atlas · tasks",
      identity: "Analyst",
      role: "Member",
      state: "Active",
    },
  ];
  return (
    <div className="settings-content access-content">
      <header>
        <small>POLICY CONTROL</small>
        <h2>Users & access</h2>
        <p>
          Roles set the ceiling. Explicit grants decide which channels,
          Replicants, and privileged capabilities each actor can use.
        </p>
      </header>
      <div className="access-summary">
        <Stat label="ACTORS" value="02" />
        <Stat label="CUSTOM GRANTS" value="03" />
        <Stat label="ACTIVE" value="02" accent="green" />
      </div>
      <div className="access-table">
        <header>
          <span>IDENTITY</span>
          <span>ROLE</span>
          <span>EXPLICIT ACCESS</span>
          <span>STATE</span>
          <span />
        </header>
        {actors.map((actor) => (
          <article key={actor.identity}>
            <span>
              <i className="avatar mini accent-slate">
                {actor.identity.slice(0, 1)}
              </i>
              <strong>{actor.identity}</strong>
            </span>
            <code>{actor.role}</code>
            <p>{actor.grants}</p>
            <em>
              <i className="status-dot" />
              {actor.state}
            </em>
            <button type="button">REVIEW</button>
          </article>
        ))}
      </div>
      <div className="policy-note">
        <span>ACCESS POLICY</span>
        <p>
          Channel, file, database inspection, schedule, and run requests are
          checked server-side. Hidden navigation never counts as authorization.
        </p>
      </div>
    </div>
  );
}

function SettingsPlaceholder({ section }: { section: string }) {
  const detail =
    section === "Workspace"
      ? "Timezone, theme, and the reserved terminal capability gate are stored in authenticated workspace settings. Telemetry is off and not implemented."
      : "Session expiry, hard authorization boundaries, and the exact workspace audit feed are visible here.";
  return (
    <div className="settings-content">
      <header>
        <small>WORKSPACE CONTROL</small>
        <h2>{section}</h2>
        <p>{detail}</p>
      </header>
    </div>
  );
}

function Stat({
  label,
  value,
  accent,
}: {
  label: string;
  value: string;
  accent?: string;
}) {
  return (
    <div className={`stat ${accent ? `accent-${accent}` : ""}`}>
      <small>{label}</small>
      <strong>{value}</strong>
    </div>
  );
}
