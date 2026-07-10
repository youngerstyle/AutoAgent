import { startServer } from "./bootstrap.js";
import { loadConfig } from "./config.js";

const config = loadConfig();
await startServer(config);

console.log(`AutoAgent listening on http://127.0.0.1:${config.port}`);
