import { access, appendFile, mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/server/app.js";
import { EvidenceLedger } from "../../src/server/agent-engine/evidence-ledger.js";

const artifactContent = `---
name: failure-retrospective
description: Turn repeated delivery failures into a bounded and testable process improvement.
---
# Failure retrospective

Collect durable evidence from failed attempts, distinguish external failures from capability defects, propose one scoped change, and define a metric that can disprove the hypothesis.
`;

describe("workspace evolution candidate control plane", () => {
  let homeDir: string;
  let workspaceRoot: string;

  beforeEach(async () => {
    process.env.NODE_ENV = "test";
    homeDir = await mkdtemp(path.join(os.tmpdir(), "autoagent-evolution-home-"));
    workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "autoagent-evolution-workspace-"));
    process.env.AUTOAGENT_HOME = homeDir;
  });

  it("persists and validates an evidence-backed candidate without changing the active runtime", async () => {
    const { app, base } = await fixture();
    const worker = await request(app).get(`${base}/worker`).expect(200);
    expect(worker.body.worker).toMatchObject({ running: false, evaluatorConfigured: false });
    expect(worker.body.worker).not.toHaveProperty("pluginSandboxConfigured");
    const input = candidateInput("candidate-create-a");
    const created = await request(app).post(`${base}/candidates`).send(input).expect(201);
    expect(created.body.candidate).toMatchObject({
      kind: "skill", target: "failure-retrospective", revision: 1, status: "proposed",
      proposedBy: { type: "human", id: "api-user" },
    });
    expect(created.body.candidate.artifactRef).toContain("artifacts/");
    expect(created.body.candidate.sourceRefs[0]).toMatchObject({ kind: "evidence", ref: "evidence-a" });

    const replayed = await request(app).post(`${base}/candidates`).send(input).expect(201);
    expect(replayed.body.candidate.candidateId).toBe(created.body.candidate.candidateId);

    const validated = await request(app)
      .post(`${base}/candidates/${created.body.candidate.candidateId}/validate`)
      .send({ commandId: "candidate-validate-a", expectedContentHash: created.body.candidate.contentHash })
      .expect(200);
    expect(validated.body.candidate).toMatchObject({ status: "validated", validation: { passed: true } });

    await request(app).post(`${base}/candidates/${created.body.candidate.candidateId}/promotions`).send({
      commandId: "promotion-without-evaluation",
      evaluationId: "missing-evaluation",
      expectedContentHash: created.body.candidate.contentHash,
      stage: "shadow",
      policyRef: { id: "policy-a", version: "1", contentHash: "policy-hash" },
    }).expect(409)
      .expect(({ body }) => expect(body.code).toBe("EVOLUTION_EVALUATION_REQUIRED"));

    const activeSkill = path.join(workspaceRoot, ".agents", "skills", "failure-retrospective", "SKILL.md");
    await expect(access(activeSkill)).rejects.toMatchObject({ code: "ENOENT" });
    const ledger = await readFile(path.join(workspaceRoot, ".autoagent", "evolution", "ledger.jsonl"), "utf8");
    expect(ledger.trim().split(/\r?\n/)).toHaveLength(2);
  });

  it("requires evidence, metrics, workspace scope, and immutable command content", async () => {
    const { app, base } = await fixture();
    await request(app).post(`${base}/candidates`).send({ ...candidateInput("missing-evidence"), sourceRefs: [] }).expect(400);
    await request(app).post(`${base}/candidates`).send({ ...candidateInput("missing-metrics"), expectedMetrics: [] }).expect(400);
    await request(app).post(`${base}/candidates`).send({ ...candidateInput("bad-target"), target: "../escape" }).expect(400);

    await request(app).post(`${base}/candidates`).send(candidateInput("same-command")).expect(201);
    await request(app).post(`${base}/candidates`).send({ ...candidateInput("same-command"), hypothesis: "A different hypothesis must not reuse the command id." }).expect(409);
  });

  it("accepts a human Plugin bundle through the governance API and exposes scanner provenance", async () => {
    const { app, base } = await fixture();
    const input = {
      ...candidateInput("plugin-via-api"), kind: "plugin", target: "api_review", riskLevel: "critical",
      scope: { workspaceId: "ignored-by-route", tools: ["readFile"] },
      artifactContent: JSON.stringify({ schemaVersion: 1, manifest: {
        id: "api_review", version: "1.0.0", kind: "plugin", apiVersion: "autoagent.plugin/v1", entrypoint: "index.mjs",
        description: "Read an allowlisted API fixture and return deterministic evidence.", permissions: { workspaceRead: ["docs/**"] },
        contributions: { tools: [{ name: "inspect", description: "Inspect evidence.", inputSchema: { type: "object", additionalProperties: false, properties: {} } }], guardrails: [] },
        lifecycle: { activation: "onDemand", invokeTimeoutMs: 2_000 },
      }, files: [{ path: "index.mjs", content: "export default { async health(){return {ok:true}}, async invokeTool(){return {ok:true}} };\n" }] }),
    };
    const created = await request(app).post(`${base}/candidates`).send(input).expect(201);
    const validated = await request(app).post(`${base}/candidates/${created.body.candidate.candidateId}/validate`)
      .send({ commandId: "plugin-api-validate", expectedContentHash: created.body.candidate.contentHash }).expect(200);
    expect(validated.body.candidate).toMatchObject({ kind: "plugin", status: "validated", validation: { passed: true, pluginScanner: { decision: "pass" } } });
  });

  it("fails closed when the append-only ledger is corrupt", async () => {
    const { app, base } = await fixture();
    await request(app).post(`${base}/candidates`).send(candidateInput("before-corruption")).expect(201);
    await appendFile(path.join(workspaceRoot, ".autoagent", "evolution", "ledger.jsonl"), "not-json\n", "utf8");
    await request(app).get(`${base}/candidates`).expect(500)
      .expect(({ body }) => expect(body.error).toContain("Evolution ledger is corrupt"));
  });

  it("exposes Practice lineage and governs scope promotion without legacy direct consolidation", async () => {
    const { app, base, workspaceId } = await fixture();
    await request(app).get(`${base}/practices`).expect(200).expect(({ body }) => {
      expect(body).toEqual({ drafts: [], practices: [], bindings: [] });
    });
    const created = await request(app).post(`${base}/scope-promotions`).send({
      commandId: "api-scope-promotion", origin: { ownerLevel: "agent_project", workspaceId, profileId: "profile-a" },
      targetScope: { ownerLevel: "agent", profileId: "profile-a" },
      originReleaseRef: { id: "release-a", version: "1", contentHash: "a".repeat(64) },
      practiceRef: { id: "practice-a", version: "1", contentHash: "b".repeat(64) },
      inheritanceProofRefs: ["proof-a"], effectWindowRefs: ["effect-a"], generalizationRisks: [],
    }).expect(409);
    expect(created.body).toMatchObject({ code: "INVALID_SCOPE_PROMOTION_EVIDENCE" });
    await request(app).get(`${base}/scope-promotions`).expect(200).expect(({ body }) => {
      expect(body.proposals).toEqual([]);
    });
    await request(app).post(`${base}/memory-candidates/consolidate`).send({ minimumEpisodes: 2 }).expect(404);
  });

  it("manages immutable evaluation suites without exposing a score-submission endpoint", async () => {
    const { app, base } = await fixture();
    const cases = [
      { caseId: "target-a", group: "target", partition: "historical", inputRef: { kind: "evidence", ref: "history-a", workspaceId: "ignored" }, assertions: ["target succeeds"] },
      { caseId: "regression-a", group: "regression", partition: "sealed_holdout", inputRef: { kind: "evidence", ref: "holdout-a", workspaceId: "ignored" }, assertions: ["quality is preserved"] },
      { caseId: "safety-a", group: "safety", partition: "sealed_holdout", inputRef: { kind: "evidence", ref: "safety-a", workspaceId: "ignored" }, assertions: ["policy remains intact"] },
    ];
    const created = await request(app).post(`${base}/eval-suites`).send({ id: "suite-a", version: "1", title: "Evolution gate", cases }).expect(201);
    expect(created.body.suite).toMatchObject({ suiteRef: { id: "suite-a", version: "1" } });
    expect(created.body.suite.cases.every((item: { inputRef: { workspaceId: string } }) => item.inputRef.workspaceId !== "ignored")).toBe(true);
    await request(app).get(`${base}/eval-suites`).expect(200)
      .expect(({ body }) => expect(body.suites).toEqual([created.body.suite.suiteRef]));
    await request(app).post(`${base}/eval-suites`).send({ id: "suite-a", version: "1", title: "Mutated", cases }).expect(409);
    await request(app).post(`${base}/evaluations`).send({ caseResults: [] }).expect(404);

    const candidateResponse = await request(app).post(`${base}/candidates`).send(candidateInput("candidate-for-job")).expect(201);
    const candidate = candidateResponse.body.candidate;
    await request(app).post(`${base}/candidates/${candidate.candidateId}/validate`)
      .send({ commandId: "validate-for-job", expectedContentHash: candidate.contentHash }).expect(200);
    const queued = await request(app).post(`${base}/candidates/${candidate.candidateId}/evaluation-jobs`).send({
      commandId: "evaluation-job-api-a", expectedContentHash: candidate.contentHash, suiteRef: created.body.suite.suiteRef,
      baselineRef: { id: "baseline-a", version: "1", contentHash: "baseline-hash-a" }, runtimeSnapshotRef: "runtime-snapshot-a",
    }).expect(202);
    expect(queued.body.job).toMatchObject({ status: "pending", request: { evaluatorPrincipal: { type: "system", id: "evolution-evaluation-worker" } } });
    await request(app).get(`${base}/evaluation-jobs`).expect(200)
      .expect(({ body }) => expect(body.jobs).toEqual([expect.objectContaining({ jobId: queued.body.job.jobId })]));
  });

  async function fixture() {
    const app = createApp();
    const workspace = await request(app).post("/api/workspaces").send({ name: "Evolving company", rootPath: workspaceRoot }).expect(201);
    await new EvidenceLedger(workspaceRoot).append({ evidenceId: "evidence-a", agentId: "api-user", threadId: "thread", goalId: "goal", turnId: "turn", toolCallId: "call", toolName: "fixture", kind: "tool", capture: { status: "recorded" }, observation: { status: "observed", result: {} }, workspaceRoot, createdAt: "2026-08-14T00:00:00.000Z", input: {} });
    return { app, base: `/api/workspaces/${workspace.body.workspace.id}/evolution`, workspaceId: workspace.body.workspace.id as string };
  }

  function candidateInput(commandId: string) {
    return {
      commandId,
      kind: "skill",
      target: "failure-retrospective",
      title: "Learn from repeated failures",
      rationale: "Two delivery attempts repeated the same evidence omission.",
      hypothesis: "Evidence-first retrospectives will reduce repeated tool failures by at least ten percent.",
      artifactContent,
      sourceRefs: [{ kind: "evidence", ref: "evidence-a", workspaceId: "ignored-by-route" }],
      scope: { workspaceId: "ignored-by-route", roles: ["dev"] },
      expectedMetrics: [{ metric: "repeated_tool_failure_rate", direction: "decrease", minimumDelta: 0.1 }],
      riskLevel: "medium",
    };
  }
});
