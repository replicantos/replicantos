import {
  type FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";

import {
  api,
  type ApprovedFileRoot,
  type Artifact,
  type DatabasePage,
  type DatabaseTable,
  type FileEntry,
  jsonBody,
  type TextFile,
} from "./api.js";

interface ServiceProps {
  onFailure(error: unknown): void;
}

function formatBytes(value: number | null): string {
  if (value === null) return "DIRECTORY";
  if (value < 1_024) return `${value} B`;
  if (value < 1_048_576) return `${(value / 1_024).toFixed(1)} KB`;
  return `${(value / 1_048_576).toFixed(1)} MB`;
}

function nameFromPath(path: string): string {
  return path.split("/").at(-1) ?? path;
}

function parentPath(path: string): string {
  return path.split("/").slice(0, -1).join("/");
}

function mediaType(path: string): "text/markdown" | "text/plain" {
  return /\.(?:md|mdown|markdown)$/iu.test(path)
    ? "text/markdown"
    : "text/plain";
}

export function LiveLibrary({ onFailure }: ServiceProps) {
  const [documents, setDocuments] = useState<Artifact[]>([]);
  const [candidates, setCandidates] = useState<FileEntry[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [preview, setPreview] = useState<{
    artifact: Artifact;
    file: TextFile;
  } | null>(null);
  const [query, setQuery] = useState("");
  const [candidatePath, setCandidatePath] = useState("");
  const [pending, setPending] = useState(false);

  const loadIndex = useCallback(async () => {
    const [documentResult, fileResult] = await Promise.all([
      api<{ items: Artifact[] }>("/documents?limit=200"),
      api<{ items: FileEntry[] }>("/files?root=library&path="),
    ]);
    const files = fileResult.items.filter((item) => item.kind === "file");
    setDocuments(documentResult.items);
    setCandidates(files);
    setSelectedId((current) =>
      current && documentResult.items.some((item) => item.id === current)
        ? current
        : (documentResult.items[0]?.id ?? null),
    );
    setCandidatePath((current) =>
      current && files.some((item) => item.path === current)
        ? current
        : (files[0]?.path ?? ""),
    );
  }, []);

  useEffect(() => {
    void loadIndex().catch(onFailure);
  }, [loadIndex, onFailure]);

  useEffect(() => {
    let active = true;
    if (selectedId === null) {
      setPreview(null);
      return;
    }
    void api<{ artifact: Artifact; file: TextFile }>(
      `/documents/${encodeURIComponent(selectedId)}/text`,
    )
      .then((result) => {
        if (active) setPreview(result);
      })
      .catch(onFailure);
    return () => {
      active = false;
    };
  }, [onFailure, selectedId]);

  const filtered = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    if (!normalized) return documents;
    return documents.filter((document) =>
      `${document.name} ${document.relativePath} ${document.mediaType}`
        .toLocaleLowerCase()
        .includes(normalized),
    );
  }, [documents, query]);

  async function indexDocument() {
    if (!candidatePath) return;
    setPending(true);
    try {
      const artifact = await api<Artifact>("/documents/index", {
        body: jsonBody({
          mediaType: mediaType(candidatePath),
          name: nameFromPath(candidatePath),
          path: candidatePath,
        }),
        method: "POST",
      });
      await loadIndex();
      setSelectedId(artifact.id);
    } catch (error) {
      onFailure(error);
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="module-view split-view live-library-view">
      <div className="document-list">
        <div className="module-toolbar library-toolbar">
          <input
            aria-label="Search indexed documents"
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search indexed documents"
            value={query}
          />
          <button
            onClick={() => void loadIndex().catch(onFailure)}
            type="button"
          >
            REFRESH
          </button>
        </div>
        <form
          className="index-document-form"
          onSubmit={(event) => {
            event.preventDefault();
            void indexDocument();
          }}
        >
          <label htmlFor="library-file">APPROVED LIBRARY FILE</label>
          <select
            id="library-file"
            onChange={(event) => setCandidatePath(event.target.value)}
            value={candidatePath}
          >
            {candidates.length === 0 ? (
              <option value="">No root-level text files</option>
            ) : null}
            {candidates.map((entry) => (
              <option key={entry.path} value={entry.path}>
                {entry.path}
              </option>
            ))}
          </select>
          <button
            className="primary-button"
            disabled={pending || !candidatePath}
            type="submit"
          >
            {pending ? "INDEXING…" : "INDEX / REINDEX"}
          </button>
        </form>
        {filtered.length === 0 ? (
          <p className="live-empty">
            {documents.length === 0
              ? "No indexed documents. Create a text file in the Library root, then index it here."
              : "No documents match this search."}
          </p>
        ) : (
          filtered.map((document) => (
            <button
              className={
                selectedId === document.id
                  ? "document-row active"
                  : "document-row"
              }
              key={document.id}
              onClick={() => setSelectedId(document.id)}
              type="button"
            >
              <span>
                {document.mediaType === "text/markdown" ? "MD" : "TXT"}
              </span>
              <div>
                <strong>{document.name}</strong>
                <small>{document.relativePath}</small>
              </div>
              <time>{formatBytes(document.byteSize)}</time>
            </button>
          ))
        )}
      </div>
      <article className="document-preview live-document-preview">
        {preview === null ? (
          <div className="live-empty">
            Select an indexed document to read it.
          </div>
        ) : (
          <>
            <small>INDEX VERIFIED // SHA-256 MATCH</small>
            <h2>{preview.artifact.name}</h2>
            <p className="lead">
              {preview.artifact.relativePath} ·{" "}
              {formatBytes(preview.file.byteSize)} ·{" "}
              {preview.artifact.mediaType}
            </p>
            <pre className="document-text">{preview.file.content}</pre>
          </>
        )}
      </article>
    </section>
  );
}

export function LiveFiles({ onFailure }: ServiceProps) {
  const [root, setRoot] = useState<ApprovedFileRoot>("workspace");
  const [path, setPath] = useState("");
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [selected, setSelected] = useState<TextFile | null>(null);
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState(false);

  const loadDirectory = useCallback(async () => {
    const result = await api<{ items: FileEntry[] }>(
      `/files?root=${root}&path=${encodeURIComponent(path)}`,
    );
    setEntries(result.items);
  }, [path, root]);

  useEffect(() => {
    setEntries([]);
    setSelected(null);
    setDraft("");
    void loadDirectory().catch(onFailure);
  }, [loadDirectory, onFailure]);

  async function openFile(entry: FileEntry) {
    setPending(true);
    try {
      const file = await api<TextFile>(
        `/files/text?root=${root}&path=${encodeURIComponent(entry.path)}`,
      );
      setSelected(file);
      setDraft(file.content);
    } catch (error) {
      onFailure(error);
    } finally {
      setPending(false);
    }
  }

  async function writeFile(filePath: string, content: string) {
    setPending(true);
    try {
      const written = await api<Omit<TextFile, "content">>("/files/text", {
        body: jsonBody({ content, path: filePath, root }),
        method: "PUT",
      });
      setSelected({ ...written, content });
      setDraft(content);
      await loadDirectory();
    } catch (error) {
      onFailure(error);
    } finally {
      setPending(false);
    }
  }

  function createFile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const values = new FormData(form);
    const name = String(values.get("name") ?? "").trim();
    if (!name) return;
    const filePath = path ? `${path}/${name}` : name;
    void writeFile(filePath, "").then(() => form.reset());
  }

  return (
    <section className="module-view split-view files-view live-files-view">
      <div className="file-tree">
        <header>
          <span>
            {root.toUpperCase()} / {path || "ROOT"}
          </span>
          <button
            disabled={!path}
            onClick={() => setPath(parentPath(path))}
            type="button"
          >
            ↑ UP
          </button>
        </header>
        <div
          className="root-switcher"
          role="group"
          aria-label="Approved file root"
        >
          {(["workspace", "library"] as const).map((item) => (
            <button
              className={root === item ? "active" : ""}
              key={item}
              onClick={() => {
                setRoot(item);
                setPath("");
              }}
              type="button"
            >
              {item}
            </button>
          ))}
        </div>
        <form className="new-file-form" onSubmit={createFile}>
          <input
            aria-label="New file name"
            maxLength={100}
            name="name"
            pattern="[^/\\\\]+"
            placeholder="new-note.md"
            required
          />
          <button disabled={pending} type="submit">
            + FILE
          </button>
        </form>
        {entries.length === 0 ? (
          <p className="live-empty">This approved directory is empty.</p>
        ) : (
          entries.map((entry) => (
            <button
              className={selected?.path === entry.path ? "active" : ""}
              key={entry.path}
              onClick={() => {
                if (entry.kind === "directory") {
                  setPath(entry.path);
                  return;
                }
                void openFile(entry);
              }}
              type="button"
            >
              <span>{entry.kind === "directory" ? "▾" : "·"}</span> {entry.name}
              <small>{formatBytes(entry.byteSize)}</small>
            </button>
          ))
        )}
        <div className="protected-note">
          <span>⊘</span>
          <p>
            <strong>APPROVED ROOTS ONLY</strong>
            Hidden paths, credentials, links, and files outside these roots are
            rejected by the server.
          </p>
        </div>
      </div>
      <div className="editor live-editor">
        <header>
          <span>{selected?.path ?? "NO FILE SELECTED"}</span>
          <div>
            <small>
              {selected ? formatBytes(new Blob([draft]).size) : "UTF-8 TEXT"}
            </small>
            <button
              className="primary-button"
              disabled={
                pending || selected === null || draft === selected.content
              }
              onClick={() => {
                if (selected) void writeFile(selected.path, draft);
              }}
              type="button"
            >
              {pending ? "SAVING…" : "SAVE"}
            </button>
          </div>
        </header>
        {selected === null ? (
          <div className="live-empty">
            Select a UTF-8 file, or create one in the current approved
            directory.
          </div>
        ) : (
          <textarea
            aria-label={`Edit ${selected.path}`}
            onChange={(event) => setDraft(event.target.value)}
            spellCheck={false}
            value={draft}
          />
        )}
      </div>
    </section>
  );
}

export function LiveDatabase({ onFailure }: ServiceProps) {
  const [tables, setTables] = useState<DatabaseTable[]>([]);
  const [selectedName, setSelectedName] = useState<string | null>(null);
  const [page, setPage] = useState<DatabasePage | null>(null);
  const [offset, setOffset] = useState(0);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    let active = true;
    void api<{ items: DatabaseTable[] }>("/database/tables")
      .then((result) => {
        if (!active) return;
        setTables(result.items);
        setSelectedName((current) =>
          current && result.items.some((table) => table.name === current)
            ? current
            : (result.items[0]?.name ?? null),
        );
      })
      .catch(onFailure);
    return () => {
      active = false;
    };
  }, [onFailure]);

  const selected = tables.find((table) => table.name === selectedName) ?? null;

  const loadPage = useCallback(async () => {
    if (selectedName === null) {
      setPage(null);
      return;
    }
    setPending(true);
    try {
      const result = await api<DatabasePage>(
        `/database/tables/${encodeURIComponent(selectedName)}/rows?limit=50&offset=${offset}`,
      );
      setPage(result);
    } catch (error) {
      onFailure(error);
    } finally {
      setPending(false);
    }
  }, [offset, onFailure, selectedName]);

  useEffect(() => {
    void loadPage();
  }, [loadPage]);

  return (
    <section className="module-view split-view database-view live-database-view">
      <div className="table-list">
        <header>
          SAFE TABLES <span>{String(tables.length).padStart(2, "0")}</span>
        </header>
        {tables.map((table) => (
          <button
            className={selectedName === table.name ? "active" : ""}
            key={table.name}
            onClick={() => {
              setOffset(0);
              setSelectedName(table.name);
            }}
            type="button"
          >
            <span>▦</span>
            {table.name}
            <em>{table.columns.length} COL</em>
          </button>
        ))}
        <div className="protected-note">
          <span>⊘</span>
          <p>
            <strong>PROTECTED DATA HIDDEN</strong>
            Credentials and sessions are excluded. Sensitive allowlisted columns
            are masked.
          </p>
        </div>
      </div>
      <div className="data-panel">
        <div className="query-bar">
          <code>
            {selected
              ? `ALLOWLIST ${selected.name} · LIMIT 50 · OFFSET ${offset}`
              : "NO INSPECTABLE TABLES"}
          </code>
          <button
            disabled={pending || selected === null}
            onClick={() => void loadPage()}
            type="button"
          >
            {pending ? "READING…" : "REFRESH"}
          </button>
        </div>
        <div className="database-table-scroll">
          {selected === null ? (
            <p className="live-empty">No tables are available to this actor.</p>
          ) : (
            <table>
              <thead>
                <tr>
                  {selected.columns.map((column) => (
                    <th key={column.name}>
                      {column.name}
                      {column.masked ? (
                        <span title="Masked column"> ◌</span>
                      ) : null}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {(page?.rows ?? []).map((row, rowIndex) => (
                  <tr key={`${selected.name}-${offset + rowIndex}`}>
                    {selected.columns.map((column) => (
                      <td key={column.name}>
                        <code>{String(row[column.name] ?? "NULL")}</code>
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        {selected && page?.rows.length === 0 ? (
          <p className="live-empty">
            This workspace has no rows in {selected.name}.
          </p>
        ) : null}
        <footer className="database-footer">
          <span>
            {page?.rows.length ?? 0} ROWS · READ-ONLY · WORKSPACE-SCOPED
          </span>
          <div>
            <button
              disabled={pending || offset === 0}
              onClick={() => setOffset(Math.max(0, offset - 50))}
              type="button"
            >
              PREVIOUS
            </button>
            <button
              disabled={pending || page?.nextOffset === null || page === null}
              onClick={() => {
                if (page?.nextOffset !== null && page?.nextOffset !== undefined)
                  setOffset(page.nextOffset);
              }}
              type="button"
            >
              NEXT
            </button>
          </div>
        </footer>
      </div>
    </section>
  );
}
