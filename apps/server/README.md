# ReplicantOS self-hosted server

The server is the composition root for the single-workspace SQLite application. `createApp()` keeps a locked, fail-closed default for isolated unit tests; `createProductionApp()` opens the database, applies migrations, owns shutdown, and enables the authenticated API.

## Same-origin web application

In production, this process serves the built web application, JSON API, and realtime WebSocket endpoint from one origin. Build both packages, then start the compiled server:

```sh
pnpm --filter @replicantos/web build
pnpm --filter @replicantos/server build
NODE_ENV=production \
  REPLICANTOS_ALLOWED_ORIGINS=http://127.0.0.1:8787 \
  pnpm --filter @replicantos/server start
```

`REPLICANTOS_ALLOWED_ORIGINS` is required in production and accepts a comma-separated list of exact canonical HTTP origins. Plain HTTP is accepted only for explicit loopback hosts (`localhost`, `127.0.0.0/8`, or `[::1]`) with a loopback `REPLICANTOS_HOST`, and uses a non-`Secure` Strict session cookie so local login persists. Any network-accessible origin or bind host must use HTTPS origins and receives a `Secure` cookie. Production startup rejects non-loopback HTTP, a non-loopback bind paired with HTTP origins, and mixed HTTP/HTTPS origin lists rather than weakening one origin's cookie policy for another.

The production web root defaults to the sibling `apps/web/dist` build resolved from the compiled server module. `REPLICANTOS_WEB_ROOT` can override it only with an explicit absolute path. Startup fails when the selected directory or its regular `index.html` is missing.

Static files are served without directory listings or symbolic-link traversal. Only safe, non-API `GET` and `HEAD` requests that explicitly accept HTML receive the application shell fallback; unknown API routes remain JSON 404 responses. Browser policy headers restrict scripts, connections, framing, and resources to the serving origin. API, session, and error responses are never cached; HTML, the service worker, and the manifest are revalidated; content-hashed assets are immutable.

## Authentication dependency

Passwords use `@node-rs/argon2` because it is a maintained RustCrypto/N-API implementation with prebuilt Node binaries and a small API surface. ReplicantOS explicitly uses the dependency's Argon2id version 19 default with 19,456 KiB memory, two passes, one lane, and a 32-byte output. Tests assert the encoded algorithm, version, and cost parameters so a future default change cannot silently alter the policy.

ReplicantOS stores only Argon2id password hashes and SHA-256 hashes of opaque 32-byte session tokens. Raw session tokens exist only in the secure cookie response. Provider credentials are not handled by this server authentication layer.

## API boundary

- Every state-changing request requires an exact configured `Origin`.
- Bootstrap and login have independent rate limits.
- Database resource handlers authenticate the current session, reload user status, fetch the target, check its workspace, evaluate the core permission policy, then mutate and append an audit record in one SQLite transaction.
- Realtime upgrades require an allowed Origin, the `replicantos.v1` subprotocol, and a live database session before upgrade.
- Sensitive file, document, and database reads require either an exact configured `Origin` or browser Fetch Metadata proving a same-origin/direct request. Requests with no provenance, `same-site`, `cross-site`, or a conflicting `Origin` are rejected. Mutations and realtime upgrades continue to require the exact configured `Origin`.
- There is no arbitrary SQL endpoint. The database viewer uses a dedicated read-only, `query_only` connection and exposes only fixed table/column projections, bounded parameterized pagination, workspace predicates, and explicit masking of credentials, user-authored text, names, paths, and audit detail.

## Approved file roots

The file and document APIs can access only two configured roots. They default to `files/workspace` and `files/library` below `REPLICANTOS_DATA_DIR`; self-hosted installations can set non-empty absolute `REPLICANTOS_WORKSPACE_ROOT` and `REPLICANTOS_LIBRARY_ROOT` values instead. The roots must be distinct and non-overlapping. These roots are process-wide because the current database deliberately enforces a single workspace installation.

Paths are NFC-normalized, relative slash-separated names. Absolute paths, traversal, backslashes, hidden segments, runtime/auth/credential locations, symbolic links, hard-link aliases, and oversized components are rejected. Permission identifiers preserve exact case on case-sensitive roots and fold case only when a startup probe proves the configured root is case-insensitive. Directory results and UTF-8 text reads/writes are bounded to fixed limits. Writes use a same-directory exclusive temporary file, descriptor and realpath checks, `fsync`, inode/size verification, and atomic rename. A content-digested audit intent is committed before a write; completion or failure is recorded afterward so interrupted cross-resource writes remain reconcilable. No delete or arbitrary filesystem endpoint is exposed.

The document index accepts bounded UTF-8 files from the library root and stores only safe relative paths. Initial indexing requires `artifact:create`; reindexing the same path preserves the artifact identity and requires `artifact:write`. Artifact create/update and its audit record share one SQLite transaction. Reads verify the indexed byte size and SHA-256 before returning content and audit stale detections. File, document, and database-viewer operations all require their corresponding core permissions and never put file or row content into audit details.

The current schedule collection reflects the database repository's `enabled and due before` query boundary; it does not pretend to provide unsupported cursor pagination or an all-status schedule query.
