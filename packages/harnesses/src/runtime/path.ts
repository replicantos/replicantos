import path from "node:path";

/** Converts provider paths to workspace-relative wire paths and rejects escapes. */
export function toWorkspacePath(
  cwd: string,
  candidate: string,
): string | undefined {
  if (!candidate.trim()) return undefined;
  const windows =
    path.win32.isAbsolute(cwd) || path.win32.isAbsolute(candidate);
  const pathApi = windows ? path.win32 : path.posix;
  const root = pathApi.resolve(cwd);
  const absolute = pathApi.isAbsolute(candidate)
    ? pathApi.normalize(candidate)
    : pathApi.resolve(root, candidate);
  const relative = pathApi.relative(root, absolute);
  if (
    relative === "" ||
    relative === ".." ||
    relative.startsWith(`..${pathApi.sep}`) ||
    pathApi.isAbsolute(relative)
  ) {
    return relative === "" ? "." : undefined;
  }
  return relative.split(pathApi.sep).join("/");
}
