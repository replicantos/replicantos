import { realpath, stat } from "node:fs/promises";
import path from "node:path";

export interface ApprovedCwdResolver {
  /** Returns a canonical cwd after enforcing the host's approved-root policy. */
  resolve(cwd: string): Promise<string>;
}

export interface ApprovedRootCwdResolverOptions {
  approvedRoots: readonly string[];
  realpath?: (target: string) => Promise<string>;
  stat?: (target: string) => Promise<{ isDirectory(): boolean }>;
}

export class CwdPolicyError extends Error {
  constructor(message = "cwd is not an approved real directory.") {
    super(message);
    this.name = "CwdPolicyError";
  }
}

export const rejectUnconfiguredCwdResolver: ApprovedCwdResolver = Object.freeze(
  {
    async resolve(): Promise<string> {
      throw new CwdPolicyError("No approved cwd resolver is configured.");
    },
  },
);

function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}

/**
 * Creates a fail-closed resolver. Both roots and requests are canonicalized,
 * symlinked request paths are rejected, and the returned path is guaranteed to
 * be a directory beneath one of the injected roots.
 */
export function createApprovedRootCwdResolver(
  options: ApprovedRootCwdResolverOptions,
): ApprovedCwdResolver {
  const resolveRealpath = options.realpath ?? realpath;
  const readStat = options.stat ?? stat;
  let roots: Promise<readonly string[]> | undefined;
  const loadRoots = (): Promise<readonly string[]> => {
    roots ??= Promise.all(
      options.approvedRoots.map(async (root) => {
        if (!path.isAbsolute(root)) throw new CwdPolicyError();
        const canonical = await resolveRealpath(root);
        const metadata = await readStat(canonical);
        if (!metadata.isDirectory()) throw new CwdPolicyError();
        return path.resolve(canonical);
      }),
    ).then((values) => [...new Set(values)]);
    return roots;
  };

  return Object.freeze({
    async resolve(cwd: string): Promise<string> {
      if (!path.isAbsolute(cwd)) throw new CwdPolicyError();
      try {
        const lexical = path.resolve(cwd);
        const canonical = path.resolve(await resolveRealpath(lexical));
        const metadata = await readStat(canonical);
        if (!metadata.isDirectory() || lexical !== canonical) {
          throw new CwdPolicyError();
        }
        const approvedRoots = await loadRoots();
        if (!approvedRoots.some((root) => isInside(root, canonical))) {
          throw new CwdPolicyError();
        }
        return canonical;
      } catch (error) {
        if (error instanceof CwdPolicyError) throw error;
        throw new CwdPolicyError();
      }
    },
  });
}
