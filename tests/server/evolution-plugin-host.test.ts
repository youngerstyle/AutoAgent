import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { PluginArtifactManifest } from "../../src/shared/contracts/evolution.js";
import { AgentToolRuntime } from "../../src/server/agent-engine/tool-runtime.js";
import { IsolatedPluginHost } from "../../src/server/evolution/plugin-host.js";
import type { RuntimeEvolutionExtension } from "../../src/server/evolution/runtime-projection.js";
import { withEvolutionHarnesses } from "../../src/server/evolution-adapters/agent-runtime-adapter.js";
import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";

describe("isolated evolution extension host", () => {
  it("executes a real Plugin and brokers an allowlisted, evidence-captured workspace read", async () => {
    const fixture = await hostFixture("export default { async health(){ return {ok:true}; }, async invokeTool({input,context}) { const value = await context.requestCapability('workspace.read', {path: input.path}); return {text:value.content, evidenceId:value.evidenceId}; } };\n");
    await writeFile(path.join(fixture.root, "docs", "release.md"), "release evidence", "utf8");
    const result = await fixture.host.invokeTool("summarize", { path: "docs/release.md" }, "plugin-call");
    expect(result).toMatchObject({ text: "release evidence", evidenceId: expect.any(String) });
    await expect(fixture.host.invokeTool("summarize", { path: "secret.txt" }, "plugin-denied"))
      .rejects.toThrow("outside its manifest allowlist");
  });

  it("fails closed on timeout and protocol pollution without affecting the parent", async () => {
    const timeout = await hostFixture("export default { async health(){return {ok:true}}, async invokeTool(){ return new Promise(() => {}); } };\n", 100);
    await expect(timeout.host.invokeTool("summarize", {}, "timeout-call")).rejects.toThrow("timed out");
    const polluted = await hostFixture("process.stdout.write('not-json\\n'); export default { async health(){return {ok:true}}, async invokeTool(){return 'bad'} };\n");
    await expect(polluted.host.invokeTool("summarize", {}, "polluted-call")).rejects.toThrow("polluted");
  });

  it("runs a Harness guardrail as an isolated pre-tool decision", async () => {
    const fixture = await hostFixture("export default { async health(){return {ok:true}}, async guard({input}) { return input?.dangerous ? {behavior:'reject',message:'dangerous input'} : {behavior:'allow'}; } };\n", 2_000, "harness");
    const guard = fixture.extension.manifest.contributions.guardrails[0]!;
    await expect(fixture.host.guard(guard, "writeFile", { dangerous: false }, undefined, "guard-allow")).resolves.toEqual({ behavior: "allow" });
    await expect(fixture.host.guard(guard, "writeFile", { dangerous: true }, undefined, "guard-reject")).resolves.toEqual({ behavior: "reject", message: "dangerous input" });
  });

  it("pre-tool Harness rejection prevents the underlying runtime tool from executing", async () => {
    const fixture = await hostFixture("export default { async health(){return {ok:true}}, async guard(){ return {behavior:'reject',message:'blocked by harness'}; } };\n", 2_000, "harness");
    let executions = 0;
    const base = defineTool({
      name: "writeFile", label: "write", description: "write fixture", parameters: Type.Object({ dangerous: Type.Boolean() }),
      async execute() { executions += 1; return { content: [{ type: "text", text: "executed" }], details: { executed: true } }; },
    });
    const runtime = new AgentToolRuntime({ profile: "development", workspaceRoot: fixture.root, canReadWorkspace: true, canWriteWorkspace: false, canExecuteCommands: false }, ["readFile"]);
    const wrapped = withEvolutionHarnesses([base], [fixture.extension], runtime, { agentId: "agent-a", threadId: "thread-a", turnId: "turn-a" });
    const result = await wrapped[0]!.execute("call-a", { dangerous: true }, undefined, undefined, {} as never);
    expect(executions).toBe(0);
    expect(result).toMatchObject({ details: { rejected: true, harness: "release_review" } });
  });
});

async function hostFixture(source: string, timeout = 2_000, kind: "plugin" | "harness" = "plugin") {
  const root = await mkdtemp(path.join(os.tmpdir(), "autoagent-plugin-host-"));
  const directory = path.join(root, "bundle");
  await mkdir(path.join(root, "docs"), { recursive: true });
  await mkdir(directory, { recursive: true });
  const entrypoint = path.join(directory, "index.mjs");
  await writeFile(entrypoint, source, "utf8");
  const manifest: PluginArtifactManifest = {
    schemaVersion: 1, kind, name: "release_review", version: "1.0.0", apiVersion: "autoagent.plugin/v1", entrypoint: "index.mjs",
    contentHash: "content-hash", scope: { workspaceId: "workspace-a", tools: ["readFile"] }, riskLevel: "critical", sourceRefs: [],
    permissions: { workspaceRead: ["docs/**"] },
    contributions: {
      tools: kind === "plugin" ? [{ name: "summarize", description: "summary", inputSchema: { type: "object", additionalProperties: false } }] : [],
      guardrails: kind === "harness" ? [{ name: "deny_dangerous", phase: "pre_tool", tools: ["writeFile"] }] : [],
    },
    lifecycle: { activation: "onDemand", invokeTimeoutMs: timeout }, files: [],
    compatibility: { runtime: "autoagent", manifestVersion: 1, hostApi: "autoagent.plugin/v1" },
    scanner: { scannerRef: { id: "scanner", version: "1", contentHash: "scanner-hash" }, candidateHash: "content-hash", decision: "pass", declaredCapabilities: ["workspace.read"], detectedCapabilities: [], findings: [], scannedAt: "2026-08-14T00:00:00.000Z" },
  };
  const extension: RuntimeEvolutionExtension = { name: manifest.name, kind, directory, entrypoint, releaseId: "release-a", releaseVersion: "1", contentHash: manifest.contentHash, generation: 1, stage: "production", ownerLevel: "project", manifest };
  const runtime = new AgentToolRuntime({ profile: "development", workspaceRoot: root, canReadWorkspace: true, canWriteWorkspace: false, canExecuteCommands: false }, ["readFile"]);
  const host = new IsolatedPluginHost(extension, runtime, { agentId: "agent-a", threadId: "thread-a", goalId: "goal-a", turnId: "turn-a" });
  return { root, extension, host };
}
