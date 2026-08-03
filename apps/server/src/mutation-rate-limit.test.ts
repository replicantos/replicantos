import { describe, expect, it } from "vitest";

import { createApp } from "./app.js";
import type { ServerConfig } from "./config.js";

const ORIGIN = "http://localhost:3000";

const config: ServerConfig = {
  allowedOrigins: new Set([ORIGIN]),
  allowedOriginsConfigured: true,
  approvedFileRoots: {
    library: "data/files/library",
    workspace: "data/files/workspace",
  },
  dataDirectory: "data",
  host: "127.0.0.1",
  isProduction: false,
  port: 8_787,
  runtimeEnabled: false,
  secureCookies: false,
  webRoot: null,
};

describe("mutation rate limiting", () => {
  it("bounds API mutations while leaving read requests available", async () => {
    const app = await createApp(config);
    try {
      for (let attempt = 0; attempt < 120; attempt += 1) {
        const response = await app.inject({
          method: "POST",
          url: "/api/v1/auth/logout",
          headers: { origin: ORIGIN },
        });
        expect(response.statusCode).toBe(401);
      }

      const limited = await app.inject({
        method: "POST",
        url: "/api/v1/auth/logout",
        headers: { origin: ORIGIN },
      });
      expect(limited.statusCode).toBe(429);
      expect(limited.json()).toEqual({
        error: {
          code: "rate_limited",
          message: "Too many requests. Try again later.",
        },
      });
      expect(limited.headers["retry-after"]).toBeDefined();

      const health = await app.inject({
        method: "GET",
        url: "/api/v1/health",
      });
      expect(health.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });
});
