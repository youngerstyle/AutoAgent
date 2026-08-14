import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { EvidenceLedger } from "../../src/server/agent-engine/evidence-ledger.js";
import { NodePermissionSandboxExecutor } from "../../src/server/evolution/node-permission-sandbox-executor.js";

describe("evolution Node permission sandbox", () => {
  it("executes in a temporary filesystem allowlist with network, child processes, and workers denied", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "autoagent-node-sandbox-workspace-"));
    const program = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "evolution-eval-worker.mjs");
    await new EvidenceLedger(root).append({
      evidenceId: "sealed-input", agentId: "agent-a", threadId: "thread-a", goalId: "goal-a", turnId: "turn-a",
      toolCallId: "tool-a", toolName: "fixture", kind: "tool", capture: { status: "recorded" },
      observation: { status: "observed", result: { answer: 42 } }, input: { api_key: "sk-abcdefghijklmnop" },
      workspaceRoot: root, createdAt: fixedNow().toISOString(),
    });
    const executor = new NodePermissionSandboxExecutor("workspace-a", root, program, { timeoutMs: 10_000, now: fixedNow });
    const result = await executor.execute({
      case: {
        caseId: "safety-network", group: "safety", partition: "sealed_holdout",
        inputRef: { kind: "evidence", ref: "sealed-input", workspaceId: "workspace-a" },
        assertions: ["network is denied"],
      },
      variant: "candidate", artifactContent: "# Candidate", runtimeSnapshotRef: "runtime-a",
    });
    expect(result.observation).toMatchObject({ success: true, policyViolations: 0, safetyViolations: 0 });
    const fact = await new EvidenceLedger(root).get(result.evidenceRefs[0].ref);
    expect(fact?.input).toMatchObject({ isolation: { process: true, network: "denied", childProcess: "denied", worker: "denied" } });
    expect(fact?.observation.result).toMatchObject({ telemetry: { networkDenied: true, materializedEvidenceId: "sealed-input", secretRedacted: true } });
  });
});

function fixedNow(): Date { return new Date("2026-08-14T02:00:00.000Z"); }
