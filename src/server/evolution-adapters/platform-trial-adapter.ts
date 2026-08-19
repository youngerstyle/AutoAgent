import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { EvaluationObservation, EvolutionEvalCase, EvolutionPairedTrialRequest, EvolutionSourceRef } from "../../shared/contracts/evolution.js";
import { EvidenceLedger } from "../evidence/evidence-ledger.js";
import { writeJson } from "../storage/json.js";
import { workspaceEvolutionTrialDispatchFile } from "../storage/paths.js";
import type { EvolutionTrialPort } from "../evolution/trial-port.js";
import type { WorkspaceStore } from "../storage/workspace-store.js";

export interface EvolutionTrialRuntimeFacade {
  available(workspaceId: string): Promise<boolean>;
  start(input: {
    workspaceId: string; taskId: string; title: string; objective: string;
    trial: { trialId: string; caseId: string; variant: "baseline" | "candidate"; candidateId: string; candidateHash: string; baselineRef: EvolutionPairedTrialRequest["baselineRef"] };
  }): Promise<void>;
  observe(input: { workspaceId: string; taskId: string }): Promise<
    | { status: "pending" | "running" }
    | { status: "succeeded" | "failed"; observation: EvaluationObservation; evidenceRefs: EvolutionSourceRef[] }
  >;
}

interface DispatchRecord {
  schemaVersion: 1; trialId: string; requestHash: string;
  tasks: Array<{ caseId: string; group: EvolutionEvalCase["group"]; partition: EvolutionEvalCase["partition"]; baselineTaskId: string; candidateTaskId: string }>;
}

/** Platform-owned adapter: Evol sees only the port while real Missions remain platform concerns. */
export class PlatformEvolutionTrialAdapter implements EvolutionTrialPort {
  constructor(private readonly workspaceId: string, private readonly workspaceRoot: string, private readonly runtime: EvolutionTrialRuntimeFacade) {}

  available(workspaceId: string): Promise<boolean> { return workspaceId === this.workspaceId ? this.runtime.available(workspaceId) : Promise.resolve(false); }

  async dispatch(input: { workspaceId: string; trialId: string; request: EvolutionPairedTrialRequest }): Promise<{ dispatchRef: string }> {
    this.assertWorkspace(input.workspaceId);
    const file = workspaceEvolutionTrialDispatchFile(this.workspaceRoot, input.trialId);
    const requestHash = hash(canonical(input.request));
    const existing = await readOptional(file);
    let record: DispatchRecord;
    if (existing) {
      record = JSON.parse(existing) as DispatchRecord;
      if (record.trialId !== input.trialId || record.requestHash !== requestHash) throw new Error("Evolution trial dispatch snapshot conflict");
    } else {
      record = {
        schemaVersion: 1, trialId: input.trialId, requestHash,
        tasks: input.request.cases.map((item) => ({
          caseId: item.caseId, group: item.group, partition: item.partition,
          baselineTaskId: stableId("trial_task", input.trialId, item.caseId, "baseline"),
          candidateTaskId: stableId("trial_task", input.trialId, item.caseId, "candidate"),
        })),
      };
      await writeJson(file, record);
    }
    const cases = new Map(input.request.cases.map((item) => [item.caseId, item]));
    for (const task of record.tasks) {
      const evalCase = cases.get(task.caseId)!;
      const objective = await this.objective(evalCase);
      for (const variant of ["baseline", "candidate"] as const) {
        await this.runtime.start({
          workspaceId: this.workspaceId, taskId: variant === "baseline" ? task.baselineTaskId : task.candidateTaskId,
          title: `Evol ${variant} trial · ${evalCase.caseId}`, objective,
          trial: { trialId: input.trialId, caseId: evalCase.caseId, variant, candidateId: input.request.candidateId, candidateHash: input.request.expectedContentHash, baselineRef: input.request.baselineRef },
        });
      }
    }
    return { dispatchRef: input.trialId };
  }

  async observe(input: { workspaceId: string; trialId: string; dispatchRef: string }): ReturnType<EvolutionTrialPort["observe"]> {
    this.assertWorkspace(input.workspaceId);
    if (input.dispatchRef !== input.trialId) throw new Error("Evolution trial dispatch reference conflict");
    const raw = await readOptional(workspaceEvolutionTrialDispatchFile(this.workspaceRoot, input.trialId));
    if (!raw) return { status: "pending" };
    const record = JSON.parse(raw) as DispatchRecord;
    const caseResults = [];
    for (const task of record.tasks) {
      const baseline = await this.runtime.observe({ workspaceId: this.workspaceId, taskId: task.baselineTaskId });
      const candidate = await this.runtime.observe({ workspaceId: this.workspaceId, taskId: task.candidateTaskId });
      if (baseline.status === "pending" || baseline.status === "running" || candidate.status === "pending" || candidate.status === "running") return { status: "running" };
      if (!("observation" in baseline) || !("observation" in candidate)) return { status: "running" };
      const evidenceId = stableId("evidence_paired_trial", input.trialId, task.caseId);
      const ledger = new EvidenceLedger(this.workspaceRoot);
      if (!await ledger.get(evidenceId)) await ledger.append({
        evidenceId, agentId: "evolution-trial-adapter", threadId: `paired-trial:${input.trialId}`, goalId: `paired-trial:${task.caseId}`,
        turnId: task.caseId, toolCallId: stableId("paired_trial_pair", input.trialId, task.caseId), toolName: "platform-evolution-trial-adapter", kind: "tool",
        capture: { status: "recorded" }, observation: { status: "observed", result: { baselineTaskId: task.baselineTaskId, candidateTaskId: task.candidateTaskId, baselineStatus: baseline.status, candidateStatus: candidate.status } },
        input: { trialId: input.trialId, caseId: task.caseId }, workspaceRoot: this.workspaceRoot, createdAt: new Date().toISOString(),
      });
      caseResults.push({
        caseId: task.caseId, group: task.group, partition: task.partition,
        baseline: baseline.observation, candidate: candidate.observation,
        evidenceRefs: uniqueRefs([...baseline.evidenceRefs, ...candidate.evidenceRefs, { kind: "evidence", ref: evidenceId, workspaceId: this.workspaceId }]),
      });
    }
    return { status: "succeeded", caseResults };
  }

  private async objective(evalCase: EvolutionEvalCase): Promise<string> {
    const source = await new EvidenceLedger(this.workspaceRoot).get(evalCase.inputRef.ref);
    if (!source) throw new Error(`Evolution trial input evidence is missing: ${evalCase.inputRef.ref}`);
    const material = JSON.stringify({ input: source.input, observation: source.observation, assertions: evalCase.assertions }).slice(0, 24_000);
    return `Execute this frozen evaluation case as a normal project task. Do not discuss the experiment or change its assertions.\n\n${material}`;
  }

  private assertWorkspace(workspaceId: string): void { if (workspaceId !== this.workspaceId) throw new Error("Evolution trial crossed its workspace boundary"); }
}

export class PlatformEvolutionTrialRouter implements EvolutionTrialPort {
  constructor(private readonly workspaces: WorkspaceStore, private readonly runtime: EvolutionTrialRuntimeFacade) {}
  available(workspaceId: string): Promise<boolean> { return this.runtime.available(workspaceId); }
  async dispatch(input: { workspaceId: string; trialId: string; request: EvolutionPairedTrialRequest }) {
    const workspace = await this.workspaces.get(input.workspaceId);
    return new PlatformEvolutionTrialAdapter(workspace.id, workspace.rootPath, this.runtime).dispatch(input);
  }
  async observe(input: { workspaceId: string; trialId: string; dispatchRef: string }) {
    const workspace = await this.workspaces.get(input.workspaceId);
    return new PlatformEvolutionTrialAdapter(workspace.id, workspace.rootPath, this.runtime).observe(input);
  }
}

function uniqueRefs(values: EvolutionSourceRef[]): EvolutionSourceRef[] { return [...new Map(values.map((item) => [`${item.kind}:${item.ref}`, item])).values()]; }
async function readOptional(file: string): Promise<string | undefined> { try { return await readFile(file, "utf8"); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; } }
function stableId(prefix: string, ...parts: string[]): string { return `${prefix}_${hash(parts.join("\0")).slice(0, 32)}`; }
function hash(value: string): string { return createHash("sha256").update(value, "utf8").digest("hex"); }
function canonical(value: unknown): string { if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`; if (value && typeof value === "object") return `{${Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`; return JSON.stringify(value); }
