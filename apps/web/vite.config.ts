import react from "@vitejs/plugin-react";
import { loadEnv } from "vite";
import { defineConfig } from "vitest/config";

export default defineConfig(({ mode }) => {
  const environment = loadEnv(mode, process.cwd(), "REPLICANTOS_");
  return {
    plugins: [react()],
    server: {
      port: 4_310,
      proxy: {
        "/api": {
          changeOrigin: false,
          target: environment.REPLICANTOS_API_TARGET ?? "http://127.0.0.1:8787",
          ws: true,
        },
      },
      strictPort: true,
    },
    test: {
      environment: "jsdom",
      setupFiles: ["./src/test-setup.ts"],
    },
  };
});
