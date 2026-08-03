import { isIP } from "node:net";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

import type { ApprovedFileRoots } from "./file-service.js";

const explicitRoot = z
  .string()
  .trim()
  .min(1)
  .refine(isAbsolute, "Configured filesystem roots must be absolute paths");

const environmentSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  REPLICANTOS_ALLOWED_ORIGINS: z.string().optional(),
  REPLICANTOS_DATA_DIR: z.string().trim().min(1).optional(),
  REPLICANTOS_HOST: z.string().default("127.0.0.1"),
  REPLICANTOS_LIBRARY_ROOT: explicitRoot.optional(),
  REPLICANTOS_PORT: z.coerce.number().int().min(1).max(65_535).default(8_787),
  REPLICANTOS_RUNTIME_ENABLED: z.enum(["true", "false"]).optional(),
  REPLICANTOS_WEB_ROOT: explicitRoot.optional(),
  REPLICANTOS_WORKSPACE_ROOT: explicitRoot.optional(),
});

export interface ServerConfig {
  allowedOrigins: ReadonlySet<string>;
  allowedOriginsConfigured: boolean;
  approvedFileRoots: ApprovedFileRoots;
  dataDirectory: string;
  host: string;
  isProduction: boolean;
  port: number;
  runtimeEnabled: boolean;
  secureCookies: boolean;
  webRoot: string | null;
}

const localOrigins = ["http://127.0.0.1:4310", "http://localhost:4310"];
const productionWebRoot = resolve(
  fileURLToPath(new URL("../../web/dist/", import.meta.url)),
);

function validatedOrigin(value: string): string {
  try {
    const url = new URL(value);
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.origin !== value ||
      url.username !== "" ||
      url.password !== "" ||
      value === "null"
    ) {
      throw new Error("invalid origin");
    }
    return value;
  } catch {
    throw new TypeError(
      "REPLICANTOS_ALLOWED_ORIGINS must contain canonical HTTP origins.",
    );
  }
}

export function isLoopbackHost(hostname: string): boolean {
  if (hostname === "localhost") return true;
  const address =
    hostname.startsWith("[") && hostname.endsWith("]")
      ? hostname.slice(1, -1)
      : hostname;
  return (
    address === "::1" || (isIP(address) === 4 && address.startsWith("127."))
  );
}

export function deriveSecureCookiePolicy(
  origins: ReadonlySet<string>,
  isProduction: boolean,
): boolean {
  const urls = [...origins].map((origin) => new URL(validatedOrigin(origin)));
  const httpOrigins = urls.filter((url) => url.protocol === "http:");

  if (isProduction) {
    if (httpOrigins.some((url) => !isLoopbackHost(url.hostname))) {
      throw new TypeError(
        "Production HTTP origins must use an explicit loopback host. Use HTTPS for network access.",
      );
    }
    if (httpOrigins.length > 0 && httpOrigins.length !== urls.length) {
      throw new TypeError(
        "Production origins cannot mix HTTPS with loopback HTTP because session cookies use one security policy.",
      );
    }
  }

  return httpOrigins.length === 0;
}

export function loadServerConfig(
  environment: NodeJS.ProcessEnv = process.env,
): ServerConfig {
  const parsed = environmentSchema.parse(environment);
  const origins = parsed.REPLICANTOS_ALLOWED_ORIGINS?.split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
  const allowedOriginsConfigured = origins !== undefined && origins.length > 0;
  if (parsed.NODE_ENV === "production" && !allowedOriginsConfigured) {
    throw new TypeError(
      "REPLICANTOS_ALLOWED_ORIGINS must be explicitly configured in production.",
    );
  }
  const dataDirectory = resolve(parsed.REPLICANTOS_DATA_DIR ?? "data");
  const allowedOrigins = new Set(
    (origins?.length ? origins : localOrigins).map(validatedOrigin),
  );
  const isProduction = parsed.NODE_ENV === "production";
  const secureCookies = deriveSecureCookiePolicy(allowedOrigins, isProduction);
  if (
    isProduction &&
    !secureCookies &&
    !isLoopbackHost(parsed.REPLICANTOS_HOST)
  ) {
    throw new TypeError(
      "Production loopback HTTP origins require a loopback REPLICANTOS_HOST. Use HTTPS origins for network access.",
    );
  }

  return {
    allowedOrigins,
    allowedOriginsConfigured,
    approvedFileRoots: {
      library:
        parsed.REPLICANTOS_LIBRARY_ROOT === undefined
          ? resolve(dataDirectory, "files/library")
          : resolve(parsed.REPLICANTOS_LIBRARY_ROOT),
      workspace:
        parsed.REPLICANTOS_WORKSPACE_ROOT === undefined
          ? resolve(dataDirectory, "files/workspace")
          : resolve(parsed.REPLICANTOS_WORKSPACE_ROOT),
    },
    dataDirectory,
    host: parsed.REPLICANTOS_HOST,
    isProduction,
    port: parsed.REPLICANTOS_PORT,
    runtimeEnabled:
      parsed.REPLICANTOS_RUNTIME_ENABLED === undefined
        ? parsed.NODE_ENV !== "test"
        : parsed.REPLICANTOS_RUNTIME_ENABLED === "true",
    secureCookies,
    webRoot:
      (parsed.REPLICANTOS_WEB_ROOT === undefined
        ? undefined
        : resolve(parsed.REPLICANTOS_WEB_ROOT)) ??
      (parsed.NODE_ENV === "production" ? productionWebRoot : null),
  };
}
