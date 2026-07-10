import { startServer } from "./bootstrap.js";
import { loadConfig } from "./config.js";

const config = loadConfig();
const server = await startServer(config);

function shutdown() {
  server.stopRuntimeHosts();
  server.close(() => process.exit(0));
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

console.log(`AutoAgent listening on http://127.0.0.1:${config.port}`);
