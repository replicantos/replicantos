import { lstatSync, realpathSync } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, join, resolve, sep } from "node:path";

import fastifyStatic from "@fastify/static";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import {
  deriveSecureCookiePolicy,
  isLoopbackHost,
  type ServerConfig,
} from "./config.js";

const API_PREFIX = "/api";
const HTML_ACCEPT_TYPES = ["text/html", "application/xhtml+xml"];
const HASHED_ASSET = /^\/assets\/.*-[A-Za-z0-9_-]{8,}\.[A-Za-z0-9]+$/u;
const MAX_DECODE_PASSES = 5;
const SECURITY_POLICY = [
  "default-src 'self'",
  "base-uri 'self'",
  "connect-src 'self'",
  "font-src 'self' data:",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "img-src 'self' data: blob:",
  "manifest-src 'self'",
  "media-src 'self' blob:",
  "object-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "worker-src 'self' blob:",
].join("; ");

interface RequestPath {
  decoded: string;
  safe: boolean;
}

function failure(code: string, message: string) {
  return { error: { code, message } };
}

function requestPath(rawUrl: string): RequestPath {
  const queryIndex = rawUrl.indexOf("?");
  const rawPath = queryIndex === -1 ? rawUrl : rawUrl.slice(0, queryIndex);
  if (!rawPath.startsWith("/") || rawPath.startsWith("//")) {
    return { decoded: rawPath, safe: false };
  }

  let decoded = rawPath;
  try {
    for (let pass = 0; pass < MAX_DECODE_PASSES; pass += 1) {
      const next = decodeURIComponent(decoded);
      if (next === decoded) break;
      decoded = next;
    }
  } catch {
    return { decoded, safe: false };
  }

  if (
    decoded.includes("\\") ||
    decoded.includes("\0") ||
    decoded.includes("//") ||
    /%(?:00|25|2e|2f|5c)/iu.test(decoded)
  ) {
    return { decoded, safe: false };
  }

  const segments = decoded.split("/").slice(1);
  if (segments.some((segment) => segment.startsWith("."))) {
    return { decoded, safe: false };
  }

  return { decoded, safe: true };
}

function isApiPath(path: string): boolean {
  return path === API_PREFIX || path.startsWith(`${API_PREFIX}/`);
}

function isInsideRoot(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${sep}`);
}

function isAllowedStaticPath(root: string, pathName: string): boolean {
  const normalized = pathName.startsWith("/") ? pathName : `/${pathName}`;
  const inspected = requestPath(normalized);
  if (!inspected.safe || isApiPath(inspected.decoded)) return false;

  const candidate = resolve(root, `.${inspected.decoded}`);
  if (!isInsideRoot(root, candidate)) return false;

  try {
    let current = root;
    for (const segment of inspected.decoded.split("/").filter(Boolean)) {
      current = join(current, segment);
      if (lstatSync(current).isSymbolicLink()) return false;
    }
    return isInsideRoot(root, realpathSync(candidate));
  } catch {
    return false;
  }
}

function acceptsHtml(request: FastifyRequest): boolean {
  const accept = request.headers.accept?.toLowerCase();
  return (
    accept !== undefined &&
    HTML_ACCEPT_TYPES.some((contentType) => accept.includes(contentType))
  );
}

function hasFileExtension(path: string): boolean {
  const segment = path.split("/").at(-1) ?? "";
  return /\.[A-Za-z0-9]{1,16}$/u.test(segment);
}

function shouldServeApplicationShell(request: FastifyRequest): boolean {
  if (request.method !== "GET" && request.method !== "HEAD") return false;
  const path = requestPath(request.raw.url ?? request.url);
  return (
    path.safe &&
    !isApiPath(path.decoded) &&
    !hasFileExtension(path.decoded) &&
    acceptsHtml(request)
  );
}

async function sendApplicationShell(reply: FastifyReply): Promise<void> {
  reply.code(200).type("text/html; charset=utf-8");
  await reply.sendFile("index.html", {
    cacheControl: false,
    dotfiles: "deny",
    etag: true,
    index: false,
    lastModified: true,
  });
}

function contentType(reply: FastifyReply): string {
  const header = reply.getHeader("content-type");
  return header === undefined ? "" : String(header).toLowerCase();
}

function setNoStore(reply: FastifyReply): void {
  reply.header("Cache-Control", "no-store, max-age=0");
  reply.header("Pragma", "no-cache");
  reply.header("Expires", "0");
}

function setResponseHeaders(
  request: FastifyRequest,
  reply: FastifyReply,
  config: ServerConfig,
): void {
  reply.header("Content-Security-Policy", SECURITY_POLICY);
  reply.header("Cross-Origin-Opener-Policy", "same-origin");
  reply.header("Cross-Origin-Resource-Policy", "same-origin");
  reply.header(
    "Permissions-Policy",
    "camera=(), geolocation=(), microphone=(), payment=(), usb=()",
  );
  reply.header("Referrer-Policy", "no-referrer");
  reply.header("X-Content-Type-Options", "nosniff");
  reply.header("X-DNS-Prefetch-Control", "off");
  reply.header("X-Frame-Options", "DENY");

  if (
    config.isProduction &&
    [...config.allowedOrigins].every((origin) => origin.startsWith("https://"))
  ) {
    reply.header("Strict-Transport-Security", "max-age=31536000");
  }

  const path = requestPath(request.raw.url ?? request.url);
  const responseType = contentType(reply);
  if (isApiPath(path.decoded) || reply.getHeader("set-cookie") !== undefined) {
    setNoStore(reply);
    return;
  }

  if (
    path.decoded === "/sw.js" ||
    path.decoded === "/manifest.webmanifest" ||
    responseType.includes("text/html")
  ) {
    reply.header("Cache-Control", "no-cache, max-age=0, must-revalidate");
    return;
  }

  if (responseType.includes("application/json")) {
    setNoStore(reply);
    return;
  }

  if (HASHED_ASSET.test(path.decoded)) {
    reply.header("Cache-Control", "public, max-age=31536000, immutable");
    return;
  }

  if (reply.statusCode >= 400 || !path.safe) {
    setNoStore(reply);
    return;
  }

  reply.header("Cache-Control", "public, max-age=3600, must-revalidate");
}

export function assertServerStartupConfig(config: ServerConfig): void {
  if (!config.isProduction) return;
  if (!config.allowedOriginsConfigured || config.allowedOrigins.size === 0) {
    throw new TypeError(
      "REPLICANTOS_ALLOWED_ORIGINS must be explicitly configured in production.",
    );
  }
  const secureCookies = deriveSecureCookiePolicy(
    config.allowedOrigins,
    config.isProduction,
  );
  if (config.secureCookies !== secureCookies) {
    throw new TypeError(
      "The session cookie policy does not match the configured production origins.",
    );
  }
  if (!secureCookies && !isLoopbackHost(config.host)) {
    throw new TypeError(
      "Production loopback HTTP origins require a loopback REPLICANTOS_HOST. Use HTTPS origins for network access.",
    );
  }
  if (config.webRoot === null) {
    throw new TypeError("A production web build is required.");
  }
}

export async function validateWebRoot(webRoot: string): Promise<string> {
  if (!isAbsolute(webRoot)) {
    throw new TypeError("REPLICANTOS_WEB_ROOT must be an absolute path.");
  }

  let rootInformation;
  try {
    rootInformation = await lstat(webRoot);
  } catch {
    throw new TypeError(`The web build directory does not exist: ${webRoot}`);
  }
  if (!rootInformation.isDirectory() || rootInformation.isSymbolicLink()) {
    throw new TypeError(
      "REPLICANTOS_WEB_ROOT must identify a real build directory.",
    );
  }

  const canonicalRoot = await realpath(webRoot);
  let indexInformation;
  try {
    indexInformation = await lstat(join(canonicalRoot, "index.html"));
  } catch {
    throw new TypeError(
      `The production web build is missing index.html: ${canonicalRoot}`,
    );
  }
  if (!indexInformation.isFile() || indexInformation.isSymbolicLink()) {
    throw new TypeError(
      "The production web build index.html must be a regular file.",
    );
  }

  return canonicalRoot;
}

export function registerResponsePolicy(
  app: FastifyInstance,
  config: ServerConfig,
): void {
  app.addHook("onSend", async (request, reply, payload) => {
    setResponseHeaders(request, reply, config);
    return payload;
  });
}

export function registerUnsafePathRejection(app: FastifyInstance): void {
  app.addHook("onRequest", async (request, reply) => {
    if (request.method !== "GET" && request.method !== "HEAD") return;
    if (requestPath(request.raw.url ?? request.url).safe) return;
    await reply
      .code(404)
      .send(failure("not_found", "The requested resource does not exist."));
  });
}

export async function registerWebApplication(
  app: FastifyInstance,
  webRoot: string | null,
): Promise<boolean> {
  if (webRoot === null) return false;
  const canonicalRoot = await validateWebRoot(webRoot);
  await app.register(fastifyStatic, {
    root: canonicalRoot,
    prefix: "/",
    wildcard: true,
    index: false,
    redirect: false,
    list: false,
    dotfiles: "deny",
    cacheControl: false,
    etag: true,
    lastModified: true,
    allowedPath: (pathName) => isAllowedStaticPath(canonicalRoot, pathName),
  });
  app.route({
    method: ["GET", "HEAD"],
    url: "/",
    async handler(request, reply) {
      if (!shouldServeApplicationShell(request)) {
        reply.callNotFound();
        return;
      }
      await sendApplicationShell(reply);
    },
  });
  return true;
}

export async function sendNotFoundOrApplicationShell(
  request: FastifyRequest,
  reply: FastifyReply,
  webApplicationRegistered: boolean,
): Promise<void> {
  if (webApplicationRegistered && shouldServeApplicationShell(request)) {
    await sendApplicationShell(reply);
    return;
  }

  await reply
    .code(404)
    .send(failure("not_found", "The requested resource does not exist."));
}
