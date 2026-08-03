import { createReadStream } from "node:fs";
import { access, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import path from "node:path";

const siteRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const publicRoot = path.join(siteRoot, "dist");
const port = Number.parseInt(process.env.REPLICANTOS_SITE_PORT ?? "4173", 10);

const contentTypes = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".txt", "text/plain; charset=utf-8"],
  [".webmanifest", "application/manifest+json"],
]);

const server = createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(
      new URL(request.url ?? "/", "http://127.0.0.1").pathname,
    );
    const relativePath = pathname === "/" ? "index.html" : pathname.slice(1);
    let filePath = path.resolve(publicRoot, relativePath);

    if (path.relative(publicRoot, filePath).startsWith("..")) {
      response.writeHead(400).end("Invalid path");
      return;
    }

    try {
      if ((await stat(filePath)).isDirectory()) {
        filePath = path.join(filePath, "index.html");
      }
      await access(filePath);
    } catch {
      filePath = path.join(publicRoot, "404.html");
      response.statusCode = 404;
    }

    response.setHeader(
      "Content-Type",
      contentTypes.get(path.extname(filePath)) ?? "application/octet-stream",
    );
    response.setHeader("Cache-Control", "no-store");
    createReadStream(filePath).pipe(response);
  } catch {
    response.writeHead(500).end("Unable to serve the static preview");
  }
});

server.listen(port, "127.0.0.1", () => {
  process.stdout.write(`ReplicantOS site preview: http://127.0.0.1:${port}\n`);
});
