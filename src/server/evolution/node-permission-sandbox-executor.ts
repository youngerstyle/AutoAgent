import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createId } from "../../shared/ids.js";
import type { EvaluationObservation, EvolutionSourceRef } from "../../shared/contracts/evolution.js";
import { EvidenceLedger } from "../agent-engine/evidence-ledger.js";
import { HttpError } from "../errors.js";
import { managedProcessDetached, terminateManagedProcessTree } from "../agent-engine/managed-process-tree.js";
import type { EvaluationCaseExecutor } from "./evaluation-runner.js";
import { redactEvolutionText } from "./secret-redactor.js";

interface SandboxOutput {
  observation: EvaluationObservation;
  assertions?: Array<{ assertion: string; passed: boolean }>;
  telemetry?: Record<string, unknown>;
}

export class NodePermissionSandboxExecutor implements EvaluationCaseExecutor {
  readonly isolation = "sandboxed" as const;

  constructor(
    private readonly workspaceId: string,
    private readonly workspaceRoot: string,
    private readonly programPath: string,
    private readonly options: { timeoutMs?: number; maxOutputBytes?: number; now?: () => Date } = {},
  ) {
    if (!path.isAbsolute(programPath)) throw new Error("Evaluation sandbox program path must be absolute");
  }

  async execute(input: Parameters<EvaluationCaseExecutor["execute"]>[0]): Promise<{ observation: EvaluationObservation; evidenceRefs: EvolutionSourceRef[] }> {
    const sandboxRoot = await mkdtemp(path.join(os.tmpdir(), "autoagent-eval-sandbox-"));
    const inputFile = path.join(sandboxRoot, "input.json");
    const outputFile = path.join(sandboxRoot, "output.json");
    const startedAt = this.now().toISOString();
    try {
      const materializedInput = await this.materialize(input.case.inputRef);
      await writeFile(inputFile, `${JSON.stringify({ schemaVersion: 2, ...input, materializedInput })}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
      const execution = await runPermissionedNode({
        programPath: this.programPath, sandboxRoot, inputFile, outputFile,
        timeoutMs: this.options.timeoutMs ?? 30_000,
      });
      if (execution.exitCode !== 0) throw new HttpError(409, `Sandbox evaluator exited with code ${execution.exitCode}`, "EVOLUTION_SANDBOX_EXECUTION_FAILED");
      const info = await stat(outputFile).catch(() => undefined);
      const maxOutputBytes = this.options.maxOutputBytes ?? 256_000;
      if (!info || info.size < 2 || info.size > maxOutputBytes) throw new HttpError(409, "Sandbox evaluator output is missing or exceeds its bound", "EVOLUTION_SANDBOX_OUTPUT_INVALID");
      const output = parseOutput(await readFile(outputFile, "utf8"));
      const evidenceId = createId("evidence");
      await new EvidenceLedger(this.workspaceRoot).append({
        evidenceId, agentId: "evolution-evaluator", threadId: `evaluation:${input.case.caseId}`,
        goalId: `evaluation:${input.case.caseId}:${input.variant}`, attemptId: createId("attempt"),
        turnId: createId("turn"), toolCallId: createId("toolcall"), toolName: "node-permission-sandbox-evaluator", kind: "tool",
        capture: { status: "recorded" }, observation: { status: "observed", result: output },
        workspaceRoot: this.workspaceRoot, createdAt: this.now().toISOString(),
        input: {
          caseId: input.case.caseId, variant: input.variant, runtimeSnapshotRef: input.runtimeSnapshotRef,
          isolation: { process: true, filesystem: "temporary-allowlist", network: "denied", childProcess: "denied", worker: "denied" },
          startedAt,
        },
      });
      return { observation: output.observation, evidenceRefs: [{ kind: "evidence", ref: evidenceId, workspaceId: this.workspaceId }] };
    } finally {
      await rm(sandboxRoot, { recursive: true, force: true });
    }
  }

  private now(): Date { return (this.options.now ?? (() => new Date()))(); }

  private async materialize(ref: EvolutionSourceRef): Promise<{ evidence: unknown; redaction: { count: number; rules: string[]; policyRef: string } }> {
    if (ref.workspaceId !== this.workspaceId || ref.kind !== "evidence") {
      throw new HttpError(409, "Sandbox evaluation input must be a local Evidence Ledger fact", "EVOLUTION_SANDBOX_INPUT_INVALID");
    }
    const fact = await new EvidenceLedger(this.workspaceRoot).get(ref.ref);
    if (!fact) throw new HttpError(409, `Sandbox evaluation evidence is missing: ${ref.ref}`, "EVOLUTION_SANDBOX_INPUT_INVALID");
    const bounded = {
      evidenceId: fact.evidenceId,
      kind: fact.kind,
      toolName: fact.toolName,
      capture: fact.capture,
      observation: fact.observation,
      input: fact.input,
      createdAt: fact.createdAt,
      ...(fact.artifact ? { artifact: { size: fact.artifact.size, modifiedAt: fact.artifact.modifiedAt, sha256: fact.artifact.sha256 } } : {}),
    };
    const raw = JSON.stringify(bounded);
    if (Buffer.byteLength(raw, "utf8") > 256_000) throw new HttpError(409, "Sandbox evaluation evidence exceeds its materialization bound", "EVOLUTION_SANDBOX_INPUT_INVALID");
    const redacted = redactMaterializedValue(bounded);
    return {
      evidence: redacted.value,
      redaction: { count: redacted.count, rules: redacted.rules, policyRef: "evolution-secret-redaction/v1" },
    };
  }
}

function redactMaterializedValue(input: unknown): { value: unknown; count: number; rules: string[] } {
  if (typeof input === "string") return redactEvolutionText(input);
  if (Array.isArray(input)) {
    const items = input.map(redactMaterializedValue);
    return { value: items.map((item) => item.value), count: items.reduce((sum, item) => sum + item.count, 0), rules: unique(items.flatMap((item) => item.rules)) };
  }
  if (input && typeof input === "object") {
    let count = 0;
    const rules: string[] = [];
    const value: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(input)) {
      if (/^(?:api[_-]?key|access[_-]?token|authorization|secret|password)$/i.test(key)) {
        value[key] = "[REDACTED]";
        count += 1;
        rules.push("named-secret");
      } else {
        const redacted = redactMaterializedValue(child);
        value[key] = redacted.value;
        count += redacted.count;
        rules.push(...redacted.rules);
      }
    }
    return { value, count, rules: unique(rules) };
  }
  return { value: input, count: 0, rules: [] };
}

function unique(values: string[]): string[] { return [...new Set(values)]; }

async function runPermissionedNode(input: { programPath: string; sandboxRoot: string; inputFile: string; outputFile: string; timeoutMs: number }): Promise<{ exitCode: number | null }> {
  const child = spawn(process.execPath, [
    "--permission",
    `--allow-fs-read=${input.sandboxRoot}`,
    `--allow-fs-read=${input.programPath}`,
    `--allow-fs-write=${input.sandboxRoot}`,
    "--disable-proto=delete",
    input.programPath,
    input.inputFile,
    input.outputFile,
  ], {
    cwd: input.sandboxRoot, shell: false, windowsHide: true, detached: managedProcessDetached(), stdio: "ignore",
    env: minimalEnvironment(input.sandboxRoot),
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      new Promise<{ exitCode: number | null }>((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", (exitCode) => resolve({ exitCode }));
      }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new HttpError(408, "Sandbox evaluator timed out", "EVOLUTION_SANDBOX_TIMEOUT")), input.timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    if (child.pid) await terminateManagedProcessTree(child.pid, { graceMs: 100, forceWaitMs: 1_000 });
  }
}

function minimalEnvironment(sandboxRoot: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    ComSpec: process.env.ComSpec,
    TEMP: sandboxRoot,
    TMP: sandboxRoot,
    NODE_NO_WARNINGS: "1",
  };
}

function parseOutput(raw: string): SandboxOutput {
  let output: SandboxOutput;
  try { output = JSON.parse(raw) as SandboxOutput; } catch { throw new HttpError(409, "Sandbox evaluator returned invalid JSON", "EVOLUTION_SANDBOX_OUTPUT_INVALID"); }
  const observation = output?.observation;
  if (!observation || typeof observation.success !== "boolean"
    || typeof observation.costMeasured !== "boolean"
    || ![observation.qualityScore, observation.costUsd, observation.latencyMs, observation.toolFailures, observation.policyViolations, observation.safetyViolations]
      .every((value) => Number.isFinite(value) && value >= 0)) {
    throw new HttpError(409, "Sandbox evaluator returned an invalid observation", "EVOLUTION_SANDBOX_OUTPUT_INVALID");
  }
  if (![observation.inputTokens, observation.outputTokens, observation.totalTokens, observation.qaReturns, observation.repeatedToolCalls, observation.humanInterventions, observation.evidenceCompleteness]
    .every((value) => value === undefined || (Number.isFinite(value) && value >= 0)) || (observation.evidenceCompleteness ?? 0) > 1) {
    throw new HttpError(409, "Sandbox evaluator returned invalid optional observation metrics", "EVOLUTION_SANDBOX_OUTPUT_INVALID");
  }
  if (output.assertions !== undefined && (!Array.isArray(output.assertions) || output.assertions.some((item) => !item || typeof item.assertion !== "string" || typeof item.passed !== "boolean"))) {
    throw new HttpError(409, "Sandbox evaluator returned invalid assertions", "EVOLUTION_SANDBOX_OUTPUT_INVALID");
  }
  return output;
}
