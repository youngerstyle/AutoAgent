import { describe, expect, it } from "vitest";
import { assertCommandAllowed } from "../../src/server/policy/command-policy.js";
import type { EffectivePolicy } from "../../src/server/policy/policy.js";

const policy: EffectivePolicy = {
  profile: "development",
  workspaceRoot: "C:\\workspace",
  canReadWorkspace: true,
  canWriteWorkspace: true,
  canExecuteCommands: true,
};

describe("command policy", () => {
  it.each([
    "taskkill /F /IM node.exe >nul 2>&1 & npm test",
    "taskkill.exe /PID 123 /T /F",
    "Get-Process node | Stop-Process -Force",
    "pkill -f vite",
    "killall node",
    "wmic process where name='node.exe' delete",
  ])("rejects host-level process termination: %s", (command) => {
    expect(() => assertCommandAllowed(policy, command)).toThrow("Host process termination is not allowed");
  });

  it.each([
    "npm test",
    "npm run dev -- --port 4173",
    "node tests/integration.js",
  ])("allows ordinary project commands: %s", (command) => {
    expect(() => assertCommandAllowed(policy, command)).not.toThrow();
  });
});
