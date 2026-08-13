#!/usr/bin/env node
import { spawn } from "node:child_process";

if (process.platform !== "linux") {
  console.error(`verify-linux-node requires native Linux Node; detected ${process.platform}`);
  process.exit(2);
}

const steps = [
  ["event-ledger-lock-recovery", ["run", "test:run", "--", "tests/server/event-ledger-lock-recovery.test.ts"]],
  ["runtime-host", ["run", "test:run", "--", "tests/server/runtime-host.test.ts"]],
  ["test:run", ["run", "test:run"]],
  ["typecheck", ["run", "typecheck"]],
  ["build", ["run", "build"]],
];

const npm = "npm";
const startedAt = new Date().toISOString();
console.log(JSON.stringify({ event: "linux-node-verification-start", platform: process.platform, node: process.version, npm, startedAt }));

function runStep(name, args) {
  return new Promise((resolve, reject) => {
    const command = `${npm} ${args.join(" ")}`;
    const stepStartedAt = new Date().toISOString();
    console.log(JSON.stringify({ event: "step-start", name, command, startedAt: stepStartedAt }));
    const child = spawn(npm, args, { stdio: "inherit", shell: false, windowsHide: false });
    child.on("error", (error) => reject(new Error(`${name}: failed to start ${command}: ${error.message}`, { cause: error })));
    child.on("close", (code, signal) => {
      const exitCode = typeof code === "number" ? code : 1;
      console.log(JSON.stringify({ event: "step-finish", name, command, exitCode, signal, finishedAt: new Date().toISOString() }));
      if (exitCode !== 0) {
        reject(new Error(`${name} failed with exit code ${exitCode}${signal ? ` (signal ${signal})` : ""}`));
        return;
      }
      resolve();
    });
  });
}

try {
  for (const [name, args] of steps) await runStep(name, args);
  console.log(JSON.stringify({ event: "linux-node-verification-finish", exitCode: 0, finishedAt: new Date().toISOString() }));
} catch (error) {
  console.error(JSON.stringify({ event: "linux-node-verification-finish", exitCode: 1, error: error.message, finishedAt: new Date().toISOString() }));
  process.exit(1);
}
