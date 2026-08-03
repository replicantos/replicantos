import { createProductionApp } from "./app.js";
import { loadServerConfig } from "./config.js";

const config = loadServerConfig();
const app = await createProductionApp(config);

const shutdown = async (signal: string) => {
  app.log.info({ signal }, "stopping ReplicantOS server");
  await app.close();
  process.exit(0);
};

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

try {
  await app.listen({ host: config.host, port: config.port });
} catch (error) {
  await app.close();
  throw error;
}
