import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, lstat, readFile, realpath } from "node:fs/promises";
import { isIP } from "node:net";
import { dirname, isAbsolute, join, parse, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

const scriptPath = fileURLToPath(import.meta.url);
export const repositoryRoot = resolve(dirname(scriptPath), "..");

const MINIMUM_NODE_MAJOR = 22;
const MAX_ENV_FILE_BYTES = 64 * 1024;

const HOST_ENV_KEYS = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
  "SystemRoot",
  "ComSpec",
  "PATHEXT",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "PROGRAMDATA",
];

// These names mirror the explicit provider allowlists in packages/harnesses.
// Values remain host-native and are never printed by this entrypoint.
const PROVIDER_ENV_KEYS = [
  "CODEX_HOME",
  "CODEX_SQLITE_HOME",
  "CODEX_ACCESS_TOKEN",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "CLAUDE_CONFIG_DIR",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_MANTLE",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
  "CLAUDE_CODE_USE_ANTHROPIC_AWS",
  "CLAUDE_CODE_SKIP_BEDROCK_AUTH",
  "CLAUDE_CODE_SKIP_MANTLE_AUTH",
  "CLAUDE_CODE_SKIP_VERTEX_AUTH",
  "CLAUDE_CODE_SKIP_FOUNDRY_AUTH",
  "CLAUDE_CODE_SUBPROCESS_ENV_SCRUB",
  "AWS_PROFILE",
  "AWS_REGION",
  "AWS_DEFAULT_REGION",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_BEARER_TOKEN_BEDROCK",
  "AWS_WEB_IDENTITY_TOKEN_FILE",
  "AWS_ROLE_ARN",
  "AWS_CONFIG_FILE",
  "AWS_SHARED_CREDENTIALS_FILE",
  "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
  "AWS_CONTAINER_CREDENTIALS_FULL_URI",
  "AWS_CONTAINER_AUTHORIZATION_TOKEN",
  "ANTHROPIC_BEDROCK_BASE_URL",
  "ANTHROPIC_BEDROCK_MANTLE_BASE_URL",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "CLOUDSDK_CONFIG",
  "CLOUD_ML_REGION",
  "ANTHROPIC_VERTEX_PROJECT_ID",
  "ANTHROPIC_VERTEX_BASE_URL",
  "ANTHROPIC_FOUNDRY_RESOURCE",
  "ANTHROPIC_FOUNDRY_BASE_URL",
  "ANTHROPIC_FOUNDRY_API_KEY",
  "AZURE_CLIENT_ID",
  "AZURE_TENANT_ID",
  "AZURE_CLIENT_SECRET",
  "AZURE_AUTHORITY_HOST",
  "AZURE_CONFIG_DIR",
  "ANTHROPIC_AWS_WORKSPACE_ID",
  "ANTHROPIC_AWS_BASE_URL",
  "OPENCODE_API_KEY",
  "OPENCODE_CONFIG",
  "OPENCODE_CONFIG_DIR",
  "GROK_HOME",
  "XAI_API_KEY",
];

const APP_ENV_KEYS = [
  "NODE_ENV",
  "REPLICANTOS_ALLOWED_ORIGINS",
  "REPLICANTOS_DATA_DIR",
  "REPLICANTOS_HOST",
  "REPLICANTOS_LIBRARY_ROOT",
  "REPLICANTOS_PORT",
  "REPLICANTOS_WEB_ROOT",
  "REPLICANTOS_WORKSPACE_ROOT",
];

function hasValue(value) {
  return value !== undefined && value.trim().length > 0;
}

function isLoopbackHost(host) {
  if (host === "localhost" || host === "::1") return true;
  return isIP(host) === 4 && host.startsWith("127.");
}

function isLoopbackHostname(hostname) {
  const address =
    hostname.startsWith("[") && hostname.endsWith("]")
      ? hostname.slice(1, -1)
      : hostname;
  return isLoopbackHost(address);
}

function parsePort(value) {
  if (value === undefined) return 8_787;
  if (!/^\d{1,5}$/u.test(value)) {
    throw new TypeError("REPLICANTOS_PORT must be an integer from 1 to 65535.");
  }
  const port = Number(value);
  if (port < 1 || port > 65_535) {
    throw new TypeError("REPLICANTOS_PORT must be an integer from 1 to 65535.");
  }
  return port;
}

function parseOrigin(value) {
  try {
    const url = new URL(value);
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.origin !== value ||
      url.username !== "" ||
      url.password !== "" ||
      value === "null"
    ) {
      throw new Error("non-canonical origin");
    }
    return url;
  } catch {
    throw new TypeError(
      "REPLICANTOS_ALLOWED_ORIGINS must contain exact canonical HTTP origins.",
    );
  }
}

function resolvedDataPath(value, rootDirectory) {
  if (value !== undefined && value.trim().length === 0) {
    throw new TypeError("REPLICANTOS_DATA_DIR cannot be empty.");
  }
  const target = resolve(rootDirectory, value ?? "data");
  if (target === parse(target).root || target === rootDirectory) {
    throw new TypeError(
      "REPLICANTOS_DATA_DIR must be a dedicated directory, not a filesystem or repository root.",
    );
  }
  return target;
}

function resolvedApprovedRoot(key, value, fallback) {
  if (value === undefined) return fallback;
  if (!hasValue(value) || !isAbsolute(value)) {
    throw new TypeError(`${key} must be a non-empty absolute path.`);
  }
  return resolve(value);
}

function pathsOverlap(left, right) {
  const fromLeft = relative(left, right);
  const fromRight = relative(right, left);
  const isContained = (value) =>
    value === "" || (!value.startsWith("..") && !isAbsolute(value));
  return isContained(fromLeft) || isContained(fromRight);
}

export function resolveOperatorConfig(
  environment,
  rootDirectory = repositoryRoot,
) {
  const host = environment.REPLICANTOS_HOST?.trim() || "127.0.0.1";
  if (!isLoopbackHost(host)) {
    throw new TypeError(
      "REPLICANTOS_HOST must remain loopback-only. Put an HTTPS reverse proxy in front for network access.",
    );
  }

  const port = parsePort(environment.REPLICANTOS_PORT);
  const configuredOrigins = environment.REPLICANTOS_ALLOWED_ORIGINS?.split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
  if (
    environment.REPLICANTOS_ALLOWED_ORIGINS !== undefined &&
    configuredOrigins?.length === 0
  ) {
    throw new TypeError("REPLICANTOS_ALLOWED_ORIGINS cannot be empty.");
  }
  const origins = configuredOrigins ?? [`http://127.0.0.1:${port}`];
  const parsedOrigins = origins.map(parseOrigin);
  const protocols = new Set(parsedOrigins.map((origin) => origin.protocol));
  if (protocols.size !== 1) {
    throw new TypeError(
      "REPLICANTOS_ALLOWED_ORIGINS cannot mix loopback HTTP and HTTPS origins.",
    );
  }
  if (origins.length !== 1) {
    throw new TypeError(
      "REPLICANTOS_ALLOWED_ORIGINS must contain exactly one browser origin.",
    );
  }

  const exposureMode =
    parsedOrigins[0]?.protocol === "https:"
      ? "reverse-proxy-https"
      : "loopback-http";
  if (exposureMode === "loopback-http") {
    for (const origin of parsedOrigins) {
      if (!isLoopbackHostname(origin.hostname)) {
        throw new TypeError(
          "Plain HTTP origins must be loopback-only. Use one exact HTTPS origin for network access.",
        );
      }
      const originPort = Number(origin.port || "80");
      if (originPort !== port) {
        throw new TypeError(
          "A loopback HTTP origin must use the configured REPLICANTOS_PORT.",
        );
      }
    }
  }

  const dataDirectory = resolvedDataPath(
    environment.REPLICANTOS_DATA_DIR,
    rootDirectory,
  );
  const workspaceRoot = resolvedApprovedRoot(
    "REPLICANTOS_WORKSPACE_ROOT",
    environment.REPLICANTOS_WORKSPACE_ROOT,
    join(dataDirectory, "files", "workspace"),
  );
  const libraryRoot = resolvedApprovedRoot(
    "REPLICANTOS_LIBRARY_ROOT",
    environment.REPLICANTOS_LIBRARY_ROOT,
    join(dataDirectory, "files", "library"),
  );
  if (pathsOverlap(workspaceRoot, libraryRoot)) {
    throw new TypeError(
      "REPLICANTOS_WORKSPACE_ROOT and REPLICANTOS_LIBRARY_ROOT must be distinct, non-overlapping directories.",
    );
  }

  const defaultWebRoot = join(rootDirectory, "apps", "web", "dist");
  const webRoot = environment.REPLICANTOS_WEB_ROOT;
  if (webRoot !== undefined && (!hasValue(webRoot) || !isAbsolute(webRoot))) {
    throw new TypeError(
      "REPLICANTOS_WEB_ROOT must be a non-empty absolute path.",
    );
  }

  return {
    allowedOrigins: origins,
    dataDirectory,
    exposureMode,
    host,
    libraryRoot,
    port,
    webRoot: webRoot === undefined ? defaultWebRoot : resolve(webRoot),
    workspaceRoot,
  };
}

export function createServerEnvironment(source, config) {
  const child = {};
  for (const key of [...HOST_ENV_KEYS, ...PROVIDER_ENV_KEYS]) {
    if (source[key] !== undefined) child[key] = source[key];
  }

  return {
    ...child,
    NODE_ENV: "production",
    REPLICANTOS_ALLOWED_ORIGINS: config.allowedOrigins.join(","),
    REPLICANTOS_DATA_DIR: config.dataDirectory,
    REPLICANTOS_HOST: config.host,
    REPLICANTOS_LIBRARY_ROOT: config.libraryRoot,
    REPLICANTOS_PORT: String(config.port),
    REPLICANTOS_WEB_ROOT: config.webRoot,
    REPLICANTOS_WORKSPACE_ROOT: config.workspaceRoot,
  };
}

export async function loadOperatorEnvironment(
  source,
  rootDirectory = repositoryRoot,
) {
  const environmentPath = join(rootDirectory, ".env");
  let metadata;
  try {
    metadata = await lstat(environmentPath);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { environment: { ...source }, localFilePresent: false };
    }
    throw new Error("ReplicantOS could not inspect the local .env file.");
  }
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new TypeError("The local .env path must be a regular file.");
  }
  if (metadata.size > MAX_ENV_FILE_BYTES) {
    throw new TypeError("The local .env file exceeds the 64 KiB limit.");
  }

  let parsed;
  try {
    parsed = parseEnv(await readFile(environmentPath, "utf8"));
  } catch {
    throw new TypeError("The local .env file could not be parsed.");
  }
  return {
    environment: { ...parsed, ...source },
    localFilePresent: true,
  };
}

function runtimeArtifacts(rootDirectory, webRoot) {
  return [
    {
      kind: "directory",
      label: "Dependencies",
      path: join(rootDirectory, "node_modules"),
    },
    {
      kind: "file",
      label: "Server build",
      path: join(rootDirectory, "apps", "server", "dist", "index.js"),
    },
    {
      kind: "file",
      label: "Web build",
      path: join(webRoot, "index.html"),
    },
    {
      kind: "directory",
      label: "Web assets",
      path: join(webRoot, "assets"),
    },
    ...["core", "db", "harnesses", "protocol", "runtime"].map((name) => ({
      kind: "file",
      label: `Package build: ${name}`,
      path: join(rootDirectory, "packages", name, "dist", "index.js"),
    })),
  ];
}

async function artifactCheck(label, path, kind) {
  try {
    const metadata = await lstat(path);
    const correctKind =
      kind === "file"
        ? metadata.isFile() && metadata.size > 0
        : metadata.isDirectory();
    return {
      label,
      message: correctKind ? "ready" : `expected a regular ${kind}`,
      ok: correctKind && !metadata.isSymbolicLink(),
    };
  } catch {
    return {
      label,
      message: "missing; run pnpm install and pnpm build",
      ok: false,
    };
  }
}

async function nearestExistingDirectory(target) {
  let candidate = target;
  while (true) {
    try {
      const metadata = await lstat(candidate);
      if (!metadata.isDirectory()) {
        throw new TypeError(
          "The configured data path has a non-directory parent.",
        );
      }
      return candidate;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      const parent = dirname(candidate);
      if (parent === candidate) throw error;
      candidate = parent;
    }
  }
}

export async function inspectReadiness(options) {
  const rootDirectory = options.rootDirectory ?? repositoryRoot;
  const nodeVersion = options.nodeVersion ?? process.versions.node;
  const nodeMajor = Number(nodeVersion.split(".")[0]);
  const checks = [
    {
      label: "Node.js",
      message:
        Number.isInteger(nodeMajor) && nodeMajor >= MINIMUM_NODE_MAJOR
          ? "supported"
          : `Node.js ${MINIMUM_NODE_MAJOR} or newer is required`,
      ok: Number.isInteger(nodeMajor) && nodeMajor >= MINIMUM_NODE_MAJOR,
    },
    {
      label: "Local configuration",
      message: options.localFilePresent ? ".env loaded" : "secure defaults",
      ok: true,
    },
  ];

  let config = null;
  try {
    config = resolveOperatorConfig(options.environment, rootDirectory);
    checks.push({
      label: "Exposure policy",
      message:
        config.exposureMode === "loopback-http"
          ? "loopback HTTP"
          : "loopback listener with HTTPS origin",
      ok: true,
    });
  } catch (error) {
    checks.push({
      label: "Configuration",
      message: error instanceof Error ? error.message : "invalid",
      ok: false,
    });
  }

  const selectedWebRoot =
    config?.webRoot ?? join(rootDirectory, "apps", "web", "dist");
  const artifactChecks = await Promise.all(
    runtimeArtifacts(rootDirectory, selectedWebRoot).map((artifact) =>
      artifactCheck(artifact.label, artifact.path, artifact.kind),
    ),
  );
  checks.push(...artifactChecks);

  if (config !== null) {
    try {
      const writableDirectory = await nearestExistingDirectory(
        config.dataDirectory,
      );
      await access(writableDirectory, fsConstants.W_OK);
      checks.push({ label: "Data directory", message: "writable", ok: true });
    } catch {
      checks.push({
        label: "Data directory",
        message: "nearest existing parent is not writable",
        ok: false,
      });
    }
  }

  return {
    checks,
    config,
    ready: config !== null && checks.every((check) => check.ok),
  };
}

export function createLaunchSpec(rootDirectory, environment) {
  return {
    args: [join(rootDirectory, "apps", "server", "dist", "index.js")],
    command: process.execPath,
    options: {
      cwd: rootDirectory,
      env: environment,
      shell: false,
      stdio: "inherit",
    },
  };
}

function printDoctor(result) {
  console.log("ReplicantOS doctor\n");
  for (const check of result.checks) {
    console.log(
      `[${check.ok ? "pass" : "fail"}] ${check.label}: ${check.message}`,
    );
  }
  console.log(
    `\n${result.ready ? "Ready for a source-build start." : "Not ready. Resolve the failed checks before starting."}`,
  );
  console.log(
    "No default account is installed; the first browser visit creates the owner.",
  );
}

function printHelp() {
  console.log(`ReplicantOS operator entrypoint

Usage:
  pnpm run doctor   Validate Node.js, configuration, build output, and data access
  pnpm start    Start the previously built self-hosted server

pnpm start never installs dependencies or builds source automatically.`);
}

async function launch(environment) {
  const loaded = await loadOperatorEnvironment(environment);
  const readiness = await inspectReadiness({
    environment: loaded.environment,
    localFilePresent: loaded.localFilePresent,
  });
  const command = process.argv[2];
  if (command === "--help" || command === "-h") {
    printHelp();
    return;
  }
  if (command !== undefined && command !== "--doctor") {
    throw new TypeError("Unknown option. Run pnpm start -- --help for usage.");
  }
  if (command === "--doctor") {
    printDoctor(readiness);
    if (!readiness.ready) process.exitCode = 1;
    return;
  }
  if (!readiness.ready || readiness.config === null) {
    throw new Error(
      "Readiness checks failed. Run pnpm run doctor, then pnpm install and pnpm build as directed.",
    );
  }

  const serverEnvironment = createServerEnvironment(
    loaded.environment,
    readiness.config,
  );
  const spec = createLaunchSpec(repositoryRoot, serverEnvironment);
  console.log("Starting the verified ReplicantOS production build.");
  const child = spawn(spec.command, spec.args, spec.options);
  const forward = (signal) => {
    if (child.exitCode === null && child.signalCode === null)
      child.kill(signal);
  };
  const onInterrupt = () => forward("SIGINT");
  const onTerminate = () => forward("SIGTERM");
  process.once("SIGINT", onInterrupt);
  process.once("SIGTERM", onTerminate);

  try {
    const exitCode = await new Promise((resolvePromise, reject) => {
      child.once("error", reject);
      child.once("exit", (code) => resolvePromise(code ?? 1));
    });
    process.exitCode = exitCode;
  } finally {
    process.off("SIGINT", onInterrupt);
    process.off("SIGTERM", onTerminate);
  }
}

if (process.argv[1] !== undefined) {
  let invokedPath = null;
  try {
    invokedPath = await realpath(resolve(process.argv[1]));
  } catch {
    // A missing invocation path cannot be this module's executable entrypoint.
  }
  if (invokedPath === (await realpath(scriptPath))) {
    try {
      await launch(process.env);
    } catch (error) {
      console.error(
        `ReplicantOS startup failed: ${error instanceof Error ? error.message : "unknown error"}`,
      );
      process.exitCode = 1;
    }
  }
}

export { APP_ENV_KEYS, HOST_ENV_KEYS, PROVIDER_ENV_KEYS };
