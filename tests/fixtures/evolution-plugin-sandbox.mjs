import readline from "node:readline";
import { pathToFileURL } from "node:url";

const pending = new Map();
let sequence = 0;
const send = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const requestCapability = (capability, input) => new Promise((resolve, reject) => {
  const requestId = `cap-${++sequence}`;
  pending.set(requestId, { resolve, reject });
  send({ type: "capability_request", requestId, capability, input });
});
console.log = (...values) => process.stderr.write(`${values.map(String).join(" ").slice(0, 4_000)}\n`);
console.info = console.warn = console.error = console.log;

readline.createInterface({ input: process.stdin, crlfDelay: Infinity }).on("line", async (line) => {
  let message;
  try { message = JSON.parse(line); } catch { return send({ type: "fatal", error: "malformed input" }); }
  if (message.type === "capability_result") {
    const item = pending.get(message.requestId);
    if (!item) return;
    pending.delete(message.requestId);
    return message.ok ? item.resolve(message.result) : item.reject(new Error(message.error || "capability failed"));
  }
  if (message.type !== "invoke") return;
  let extension;
  const context = Object.freeze({ ...message.context, requestCapability });
  try {
    extension = (await import(pathToFileURL(process.argv[2]).href)).default;
    if (extension.activate) await extension.activate(context);
    if (extension.health && (await extension.health(context))?.ok !== true) throw new Error("health check failed");
    const result = message.operation === "tool"
      ? await extension.invokeTool({ name: message.name, input: message.input, context })
      : await extension.guard({ name: message.name, phase: message.phase, tool: message.tool, input: message.input, output: message.output, context });
    if (extension.deactivate) await extension.deactivate(context);
    send({ type: "result", requestId: message.requestId, result });
  } catch (error) {
    try { if (extension?.deactivate) await extension.deactivate(context); } catch {}
    send({ type: "result", requestId: message.requestId, error: error instanceof Error ? error.message : String(error) });
  }
});
