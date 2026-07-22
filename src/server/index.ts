import { startServer } from "./bootstrap.js";
import { loadConfig } from "./config.js";

const config = loadConfig();
const server = await startServer(config);

async function shutdown() {
  await server.stopRuntimeHosts();
  server.close(() => process.exit(0));
}

process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());

console.log(`AutoAgent listening on http://127.0.0.1:${config.port}`);
