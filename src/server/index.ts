import { createApp } from "./app.js";
import { loadConfig } from "./config.js";

const config = loadConfig();
const app = createApp();

app.listen(config.port, () => {
  console.log(`AutoAgent listening on http://127.0.0.1:${config.port}`);
});
