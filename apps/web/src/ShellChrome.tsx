import {
  Archive,
  Bell,
  CalendarClock,
  ClipboardList,
  Database,
  FolderOpen,
  Gauge,
  Hash,
  MessagesSquare,
  Settings,
} from "lucide-react";

export const productAreaNames = [
  "Chat",
  "Tasks",
  "Scheduled",
  "Runs",
  "Library",
  "Files",
  "Database",
  "Settings",
] as const;

export type ProductAreaName = (typeof productAreaNames)[number];

const productIcons = {
  Chat: MessagesSquare,
  Database,
  Files: FolderOpen,
  Library: Archive,
  Runs: Gauge,
  Scheduled: CalendarClock,
  Settings,
  Tasks: ClipboardList,
} satisfies Record<ProductAreaName, typeof MessagesSquare>;

export function ProductIcon({
  area,
  size = 20,
}: {
  area: ProductAreaName;
  size?: number;
}) {
  const Icon = productIcons[area];
  return <Icon aria-hidden="true" size={size} strokeWidth={1.8} />;
}

export function BrandGlyph() {
  return (
    <span className="brand-glyph" aria-hidden="true">
      <span>R</span>
      <i />
    </span>
  );
}

export function ChannelHash({ size = 19 }: { size?: number }) {
  return <Hash aria-hidden="true" size={size} strokeWidth={1.8} />;
}

export function NotificationGlyph({ size = 18 }: { size?: number }) {
  return <Bell aria-hidden="true" size={size} strokeWidth={1.8} />;
}

export interface PresenceEntry {
  accent: string;
  id: string;
  name: string;
  online?: boolean;
  subtitle: string;
}

export interface PresenceGroup {
  entries: PresenceEntry[];
  label: string;
}

export interface SystemFact {
  state?: "online" | "muted";
  text: string;
}

export function PresenceRail({
  channelName,
  footer = "ReplicantOS v0.1.0",
  groups,
  onSelect,
  systemFacts,
}: {
  channelName: string;
  footer?: string;
  groups: PresenceGroup[];
  onSelect?: (entry: PresenceEntry) => void;
  systemFacts: SystemFact[];
}) {
  return (
    <aside className="presence-rail" aria-label="Workspace people and status">
      <header>
        <span>IN #{channelName.toUpperCase()}</span>
      </header>
      <div className="presence-scroll">
        {groups.map((group) =>
          group.entries.length > 0 ? (
            <section className="presence-group" key={group.label}>
              <h2>
                {group.label} — {group.entries.length}
              </h2>
              {group.entries.map((entry) => (
                <button
                  className="presence-row"
                  key={entry.id}
                  onClick={() => onSelect?.(entry)}
                  type="button"
                >
                  <span className={`avatar round accent-${entry.accent}`}>
                    {entry.name.slice(0, 1).toUpperCase()}
                    <i className={entry.online === false ? "offline" : ""} />
                  </span>
                  <span>
                    <strong>{entry.name}</strong>
                    <small>{entry.subtitle}</small>
                  </span>
                </button>
              ))}
            </section>
          ) : null,
        )}
        <section className="presence-system">
          <h2>SYSTEM</h2>
          {systemFacts.map((fact) => (
            <p key={fact.text}>
              <i className={fact.state === "muted" ? "muted" : ""} />
              {fact.text}
            </p>
          ))}
        </section>
      </div>
      <footer>{footer}</footer>
    </aside>
  );
}
