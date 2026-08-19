import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { EvaluationObservation, EvolutionEvalCase, EvolutionPairedTrialRequest, EvolutionSourceRef } from "../../shared/contracts/evolution.js";
import { EvidenceLedger } from "../evidence/evidence-ledger.js";
import { writeJson } from "../storage/json.js";
import { workspaceEvolutionTrialDispatchFile } from "../storage/paths.js";
import type { EvolutionTrialPort } from "../evolution/trial-port.js";
import type { WorkspaceStore } from "../storage/workspace-store.js";
import { AgentStore } from "../agent-engine/agent-store.js";
import { AgentTraceStore } from "../agent-engine/trace-store.js";
import { MissionStore } from "../mission-process/mission-store.js";
import { RuntimeHostStore } from "../runtime/runtime-host-store.js";
import { TicketStore } from "../tickets/ticket-store.js";

export interface EvolutionTrialRuntimeFacade {
  available(workspaceId: string): Promise<boolean>;
  start(input: {
    workspaceId: string; taskId: string; title: string; objective: string;
    trial: { trialId: string; caseId: string; group: EvolutionEvalCase["group"]; assertions: string[]; variant: "baseline" | "candidate"; candidateId: string; candidateHash: string; baselineRef: EvolutionPairedTrialRequest["baselineRef"] };
  }): Promise<void>;
  observe(input: { workspaceId: string; taskId: string }): Promise<
    | { status: "pending" | "running" }
    | { status: "infrastructure_failed"; message: string }
    | { status: "succeeded" | "failed"; observation: EvaluationObservation; evidenceRefs: EvolutionSourceRef[] }
  >;
}

interface DispatchRecord {
  schemaVersion: 2; trialId: string; requestHash: string; generation: number;
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
      record = { ...record, schemaVersion: 2, generation: record.generation ?? 1 };
      const observations = await Promise.all(record.tasks.flatMap((task) => [task.baselineTaskId, task.candidateTaskId]).map((taskId) => this.runtime.observe({ workspaceId: this.workspaceId, taskId })));
      if (observations.some((item) => item.status === "infrastructure_failed")) {
        const generation = record.generation + 1;
        record = { ...record, generation, tasks: input.request.cases.map((item) => ({
          caseId: item.caseId, group: item.group, partition: item.partition,
          baselineTaskId: stableId("trial_task", input.trialId, item.caseId, "baseline", String(generation)),
          candidateTaskId: stableId("trial_task", input.trialId, item.caseId, "candidate", String(generation)),
        })) };
        await writeJson(file, record);
      }
    } else {
      record = {
        schemaVersion: 2, trialId: input.trialId, requestHash, generation: 1,
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
          trial: { trialId: input.trialId, caseId: evalCase.caseId, group: evalCase.group, assertions: [...evalCase.assertions], variant, candidateId: input.request.candidateId, candidateHash: input.request.expectedContentHash, baselineRef: input.request.baselineRef },
        });
      }
    }
    return { dispatchRef: `${input.trialId}:${record.generation}` };
  }

  async observe(input: { workspaceId: string; trialId: string; dispatchRef: string }): ReturnType<EvolutionTrialPort["observe"]> {
    this.assertWorkspace(input.workspaceId);
    if (input.dispatchRef !== input.trialId && !input.dispatchRef.startsWith(`${input.trialId}:`)) throw new Error("Evolution trial dispatch reference conflict");
    const raw = await readOptional(workspaceEvolutionTrialDispatchFile(this.workspaceRoot, input.trialId));
    if (!raw) return { status: "pending" };
    const record = JSON.parse(raw) as DispatchRecord;
    const generation = record.generation ?? 1;
    if (input.dispatchRef !== `${input.trialId}:${generation}` && !(generation === 1 && input.dispatchRef === input.trialId)) throw new Error("Evolution trial dispatch generation conflict");
    const observations = await Promise.all(record.tasks.map(async (task) => ({
      task,
      baseline: await this.runtime.observe({ workspaceId: this.workspaceId, taskId: task.baselineTaskId }),
      candidate: await this.runtime.observe({ workspaceId: this.workspaceId, taskId: task.candidateTaskId }),
    })));
    const infrastructureFailures = observations.flatMap(({ baseline, candidate }) => [baseline, candidate])
      .filter((item): item is Extract<typeof item, { status: "infrastructure_failed" }> => item.status === "infrastructure_failed");
    if (infrastructureFailures.length) return {
      status: "inconclusive", category: "transient",
      message: infrastructureFailures.map((item) => item.message).join("; "),
    };
    if (observations.some(({ baseline, candidate }) => baseline.status === "pending" || baseline.status === "running" || candidate.status === "pending" || candidate.status === "running")) {
      return { status: "running" };
    }
    const caseResults = [];
    for (const { task, baseline, candidate } of observations) {
      if (baseline.status === "infrastructure_failed" || candidate.status === "infrastructure_failed") return {
        status: "inconclusive", category: "transient",
        message: [baseline, candidate].filter((item) => item.status === "infrastructure_failed").map((item) => item.message).join("; "),
      };
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
    const source = await resolveTrialInput(this.workspaceRoot, evalCase.inputRef);
    if (!source) throw new Error(`Evolution trial input evidence is missing: ${evalCase.inputRef.ref}`);
    if (evalCase.group === "target") {
      const material = JSON.stringify({ assertions: evalCase.assertions, historicalSourceRef: evalCase.inputRef }).slice(0, 24_000);
      return `Execute only the frozen assertions as the current project task. The historical source reference explains why this case exists, but its original request and acceptance contract are not current requirements. Do not discuss the experiment or change the assertions.\n\n${material}`;
    }
    const material = JSON.stringify({ source: boundedReplaySource(source, evalCase.inputRef), assertions: evalCase.assertions });
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
function boundedReplaySource(source: unknown, sourceRef: EvolutionSourceRef): unknown {
  const compact = compactTicketReplaySource(source) ?? source;
  const serialized = JSON.stringify(compact);
  if (serialized.length <= 16_000) return compact;
  return { sourceRef, truncated: true, serializedExcerpt: serialized.slice(0, 16_000) };
}
function compactTicketReplaySource(source: unknown): unknown | undefined {
  if (!isRecord(source) || !isRecord(source.ticket) || !isRecord(source.definition)) return undefined;
  const ticket = source.ticket;
  const completion = isRecord(ticket.completion) && isRecord(ticket.completion.handoff) ? ticket.completion.handoff : undefined;
  const attempts = Array.isArray(ticket.attempts) ? ticket.attempts.filter(isRecord) : [];
  const lastCompleted = [...attempts].reverse().find((attempt) => attempt.status === "completed" && isRecord(attempt.handoff));
  const handoff = completion ?? (lastCompleted && isRecord(lastCompleted.handoff) ? lastCompleted.handoff : undefined);
  return {
    definition: source.definition,
    formalBaseline: handoff?.output,
    completionSummary: handoff?.summary,
    residualRisks: handoff?.residualRisks,
  };
}
async function readOptional(file: string): Promise<string | undefined> { try { return await readFile(file, "utf8"); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; } }
function stableId(prefix: string, ...parts: string[]): string { return `${prefix}_${hash(parts.join("\0")).slice(0, 32)}`; }
function hash(value: string): string { return createHash("sha256").update(value, "utf8").digest("hex"); }
function canonical(value: unknown): string { if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`; if (value && typeof value === "object") return `{${Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`; return JSON.stringify(value); }

async function resolveTrialInput(root: string, ref: EvolutionSourceRef): Promise<unknown> {
  if (ref.kind === "evidence") return new EvidenceLedger(root).get(ref.ref);
  if (ref.kind === "mission") return new MissionStore(root, ref.ref).read();
  if (ref.kind === "ticket" && ref.taskId && ref.taskRunId) {
    const task = await new RuntimeHostStore(root).get(ref.taskId);
    const mission = task ? await new MissionStore(root, task.missionId).read() : undefined;
    const aggregate = mission ? await new TicketStore(root, ref.taskId, ref.taskRunId).read(mission.record.planId) : undefined;
    return aggregate ? { ticket: aggregate.tickets.find((item) => item.ticketId === ref.ref), definition: aggregate.definitionsByTicketId[ref.ref], plan: aggregate.plan } : undefined;
  }
  if (ref.kind === "trace" && ref.agentId) return (await new AgentTraceStore(root, ref.agentId).list()).find((item) => item.traceId === ref.ref);
  if (!ref.agentId) return undefined;
  const agent = await new AgentStore(root, ref.agentId).read();
  if (ref.kind === "goal_proposal") return agent.proposals.find((item) => item.proposalId === ref.ref);
  if (ref.kind === "goal_decision") return agent.decisions.find((item) => item.decisionId === ref.ref);
  if (ref.kind === "human_feedback") return agent.payloads.map((item) => item.value).find((item) => isRecord(item) && item.messageId === ref.ref);
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
