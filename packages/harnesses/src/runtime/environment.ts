/**
 * Environment variables required for ordinary child-process execution. Provider
 * credentials and provider-specific configuration are added by each adapter.
 */
export const BASE_CHILD_ENV_KEYS = [
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
] as const;

const ENVIRONMENT_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
const CREDENTIAL_KEY =
  /(?:^|_)(?:AUTH|COOKIE|CREDENTIALS?|KEY|PASSWORD|PROXY|SECRETS?|TOKENS?)(?:_|$)/i;

export interface ChildEnvironment {
  /** A new object containing only explicitly allowed variables. */
  env: NodeJS.ProcessEnv;
  /** Credential values that must never cross the normalized event boundary. */
  secretValues: readonly string[];
}

/**
 * Copies an explicit allowlist from a source environment. Variable names, not
 * values, are the opt-in boundary; adapters supply their provider-specific set.
 */
export function buildChildEnvironment(
  source: NodeJS.ProcessEnv,
  providerKeys: readonly string[],
  additionalKeys: readonly string[] = [],
): ChildEnvironment {
  const env: NodeJS.ProcessEnv = {};
  const secretValues = new Set<string>();
  const keys = new Set<string>([
    ...BASE_CHILD_ENV_KEYS,
    ...providerKeys,
    ...additionalKeys,
  ]);

  for (const key of keys) {
    if (!ENVIRONMENT_KEY.test(key)) {
      throw new Error(
        "Environment allowlist contains an invalid variable name.",
      );
    }
    const value = source[key];
    if (value === undefined) continue;
    env[key] = value;
    if (CREDENTIAL_KEY.test(key) && value.length > 0) {
      secretValues.add(value);
    }
  }

  return {
    env,
    secretValues: [...secretValues].sort(
      (left, right) => right.length - left.length,
    ),
  };
}

export type TextRedactor = (value: string) => string;

export function createSecretRedactor(
  secretValues: readonly string[],
  additionalValues: readonly string[] = [],
): TextRedactor {
  const values = [...new Set([...secretValues, ...additionalValues])]
    .filter((value) => value.length > 0)
    .sort((left, right) => right.length - left.length);
  if (values.length === 0) return (value) => value;
  return (value) => {
    let redacted = value;
    for (const secret of values) {
      redacted = redacted.split(secret).join("[redacted]");
    }
    return redacted;
  };
}

export function redactStrings<T>(value: T, redact: TextRedactor): T {
  if (typeof value === "string") return redact(value) as T;
  if (Array.isArray(value)) {
    return value.map((entry) => redactStrings(entry, redact)) as T;
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        redactStrings(entry, redact),
      ]),
    ) as T;
  }
  return value;
}
