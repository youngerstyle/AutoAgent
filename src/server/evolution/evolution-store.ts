import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createId } from "../../shared/ids.js";
import {
  EVOLUTION_ARTIFACT_KINDS,
  EVOLUTION_SOURCE_KINDS,
  DEFAULT_EVOLUTION_ACTIVATION_BOUNDARY,
  type CreateEvolutionCandidateInput,
  type EvolutionCandidate,
  type EvolutionLedgerEvent,
  type EvolutionSourceRef,
  type EvolutionValidationCheck,
  type SkillArtifactManifest,
  type SkillScanReport,
  type PluginArtifactManifest,
  type PluginScanReport,
  type EvolutionSourcePatchArtifact,
  type EvolutionRuntimeConfigArtifact,
  type ValidateEvolutionCandidateInput,
  type VersionedEvolutionRef,
} from "../../shared/contracts/evolution.js";
import { HttpError } from "../errors.js";
import { writeJson } from "../storage/json.js";
import { workspaceEvolutionArtifactFile, workspaceEvolutionArtifactManifestFile, workspaceEvolutionLedgerFile, workspaceEvolutionSkillEntrypointFile } from "../storage/paths.js";
import { scanSkillArtifact } from "./skill-scanner.js";
import { materializePluginBundle, parseAndScanPluginBundle, type ParsedPluginBundle } from "./plugin-scanner.js";
import { EvidenceLedger } from "../agent-engine/evidence-ledger.js";
import { AgentTraceStore } from "../agent-engine/trace-store.js";
import { AgentStore } from "../agent-engine/agent-store.js";
import { MissionStore } from "../mission-process/mission-store.js";
import { TicketStore } from "../tickets/ticket-store.js";
import { EvolutionReleaseRegistry } from "./release-registry.js";

const ledgerQueues = new Map<string, Promise<void>>();

export interface EvolutionScopeAuthority {
  organizationId?: string;
  organizationWorkspaceIds?: string[];
}

export class EvolutionStore {
  constructor(
    private readonly workspaceId: string,
    private readonly workspaceRoot: string,
    private readonly now: () => Date = () => new Date(),
    private readonly scopeAuthority: EvolutionScopeAuthority = {},
  ) {}

  async list(): Promise<EvolutionCandidate[]> {
    return [...(await this.project()).candidates.values()]
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.candidateId.localeCompare(right.candidateId));
  }

  async get(candidateId: string): Promise<EvolutionCandidate> {
    const candidate = (await this.project()).candidates.get(candidateId);
    if (!candidate) throw new HttpError(404, `Evolution candidate not found: ${candidateId}`, "EVOLUTION_CANDIDATE_NOT_FOUND");
    return structuredClone(candidate);
  }

  async create(raw: CreateEvolutionCandidateInput): Promise<EvolutionCandidate> {
    return this.exclusive(async () => {
      const input = parseCreateEvolutionCandidateInput(raw, this.workspaceId, this.scopeAuthority);
      const state = await this.project();
    const replay = state.commands.get(input.commandId);
    if (replay) {
      if (replay.type !== "candidate.proposed") throw conflict("Evolution command was already used for another operation");
      const existingArtifact = await this.readArtifact(replay.candidate.artifactRef);
      if (candidateInputFingerprint(input) !== candidateInputFingerprint({
        commandId: replay.commandId,
        kind: replay.candidate.kind,
        target: replay.candidate.target,
        title: replay.candidate.title,
        rationale: replay.candidate.rationale,
        hypothesis: replay.candidate.hypothesis,
        artifactContent: existingArtifact,
        baseVersion: replay.candidate.baseVersion,
        sourceRefs: replay.candidate.sourceRefs,
        scope: replay.candidate.scope,
        expectedMetrics: replay.candidate.expectedMetrics,
        riskLevel: replay.candidate.riskLevel,
        proposedBy: replay.candidate.proposedBy,
      })) throw conflict("Evolution command idempotency conflict");
      return structuredClone(replay.candidate);
    }

    const contentHash = hash(input.artifactContent);
    const artifactRef = relativeArtifactRef(contentHash);
    await this.writeArtifact(contentHash, input.artifactContent);
    const timestamp = this.now().toISOString();
    const revision = [...state.candidates.values()]
      .filter((candidate) => candidate.kind === input.kind && candidate.target === input.target)
      .reduce((maximum, candidate) => Math.max(maximum, candidate.revision), 0) + 1;
    const candidate: EvolutionCandidate = {
      candidateId: createId("evo"), revision, kind: input.kind, target: input.target, title: input.title,
      rationale: input.rationale, ...(input.baseVersion ? { baseVersion: input.baseVersion } : {}),
      artifactRef, contentHash, hypothesis: input.hypothesis, sourceRefs: input.sourceRefs,
      scope: input.scope, expectedMetrics: input.expectedMetrics, riskLevel: input.riskLevel,
      status: "proposed", proposedBy: input.proposedBy, createdAt: timestamp, updatedAt: timestamp,
    };
    const current = await new EvolutionReleaseRegistry(this.workspaceRoot, this.now).current("production", candidate);
    const sourcePatch = candidate.kind === "source_patch" ? parseSourcePatchArtifact(input.artifactContent) : undefined;
    const baseRef = sourcePatch
      ? { id: `scm:${sourcePatch.repositoryId}`, version: sourcePatch.baseCommit, contentHash: hash(sourcePatch.baseCommit) }
      : current?.active && current.release ? current.release : genesisRef(candidate);
    if (input.baseVersion && ![baseRef.id, baseRef.version].includes(input.baseVersion)) throw conflict(`Evolution baseVersion does not match active base ${baseRef.version}`);
    candidate.mutationSet = {
      assetKind: candidate.kind, target: candidate.target, baseRef: structuredClone(baseRef),
      candidateRef: { id: candidate.candidateId, version: String(candidate.revision), contentHash: candidate.contentHash },
      representation: candidate.kind === "source_patch" ? "unified_diff" : "full",
      activationBoundary: DEFAULT_EVOLUTION_ACTIVATION_BOUNDARY[candidate.kind],
      compatibility: { runtime: "autoagent", mutationContract: "1" }, rollbackRef: structuredClone(baseRef),
    };
      await this.append({ eventId: createId("eve"), commandId: input.commandId, type: "candidate.proposed", occurredAt: timestamp, candidate });
      return candidate;
    });
  }

  async validate(raw: ValidateEvolutionCandidateInput): Promise<EvolutionCandidate> {
    return this.exclusive(async () => {
      const input = parseValidateEvolutionCandidateInput(raw);
      const state = await this.project();
    const replay = state.commands.get(input.commandId);
    if (replay) {
      if (replay.type !== "candidate.validated" || replay.candidateId !== input.candidateId || replay.expectedContentHash !== input.expectedContentHash) {
        throw conflict("Evolution command idempotency conflict");
      }
      return this.get(input.candidateId);
    }
    const candidate = state.candidates.get(input.candidateId);
    if (!candidate) throw new HttpError(404, `Evolution candidate not found: ${input.candidateId}`, "EVOLUTION_CANDIDATE_NOT_FOUND");
    if (candidate.status !== "proposed") throw conflict(`Evolution candidate is ${candidate.status}`);
    if (candidate.contentHash !== input.expectedContentHash) throw conflict("Evolution candidate content changed");
    const content = await this.readArtifact(candidate.artifactRef);
    const scanner = candidate.kind === "skill" ? scanSkillArtifact(content, candidate.contentHash, this.now) : undefined;
    let pluginBundle: ParsedPluginBundle | undefined;
    let pluginParseError: string | undefined;
    if (candidate.kind === "plugin" || candidate.kind === "harness") {
      try { pluginBundle = parseAndScanPluginBundle(content, candidate, this.now); }
      catch (error) { pluginParseError = error instanceof Error ? error.message : String(error); }
    }
    const sourceVerification = await Promise.all(candidate.sourceRefs.map((ref) => this.verifySourceRef(ref)));
    const checks = validateCandidate(candidate, content, scanner, sourceVerification, pluginBundle, pluginParseError);
    const timestamp = this.now().toISOString();
    const artifactManifestRef = scanner || pluginBundle ? relativeArtifactManifestRef(candidate.contentHash, candidate.candidateId) : undefined;
    let artifactManifestHash: string | undefined;
    if (artifactManifestRef && pluginBundle) {
      const manifest: PluginArtifactManifest = pluginBundle.manifest;
      artifactManifestHash = hash(canonical(manifest));
      await writeJson(workspaceEvolutionArtifactManifestFile(this.workspaceRoot, candidate.contentHash, candidate.candidateId), manifest);
    } else if (artifactManifestRef && scanner) {
      const manifest: SkillArtifactManifest = {
        schemaVersion: 1, kind: "skill", name: candidate.target, version: String(candidate.revision),
        entrypoint: "SKILL.md", contentHash: candidate.contentHash, scope: structuredClone(candidate.scope),
        requiredTools: [...(candidate.scope.tools ?? [])].sort(), riskLevel: candidate.riskLevel,
        sourceRefs: structuredClone(candidate.sourceRefs), files: [{ path: "SKILL.md", sha256: candidate.contentHash }],
        compatibility: { runtime: "autoagent", manifestVersion: 1 },
        declaredCapabilities: scanner.declaredCapabilities, scanner,
      };
      artifactManifestHash = hash(canonical(manifest));
      await writeJson(workspaceEvolutionArtifactManifestFile(this.workspaceRoot, candidate.contentHash, candidate.candidateId), manifest);
    }
    const validation = {
      passed: checks.every((check) => check.passed), checkedAt: timestamp, checks,
      ...(scanner ? { scanner, artifactManifestRef, artifactManifestHash } : {}),
      ...(pluginBundle ? { pluginScanner: pluginBundle.scan, artifactManifestRef, artifactManifestHash } : {}),
    };
    if (candidate.kind === "skill" && validation.passed) await writeImmutableSkillEntrypoint(this.workspaceRoot, candidate.contentHash, content);
    if ((candidate.kind === "plugin" || candidate.kind === "harness") && validation.passed && pluginBundle) await materializePluginBundle(this.workspaceRoot, pluginBundle);
      await this.append({
        eventId: createId("eve"), commandId: input.commandId, type: "candidate.validated", occurredAt: timestamp,
        candidateId: candidate.candidateId, expectedContentHash: candidate.contentHash, validation,
      });
      return this.get(candidate.candidateId);
    });
  }

  async requestPromotion(candidateId: string): Promise<never> {
    await this.get(candidateId);
    throw new HttpError(409, "Candidate promotion requires an independent passing EvaluationRun; Evaluation Gate is not active yet", "EVOLUTION_EVALUATION_REQUIRED");
  }

  async markReadyForEvaluation(input: { commandId: string; candidateId: string; expectedContentHash: string; suiteRef: VersionedEvolutionRef }): Promise<EvolutionCandidate> {
    return this.exclusive(async () => {
      if (!input.commandId?.trim() || !input.candidateId || !/^[a-f0-9]{64}$/.test(input.expectedContentHash) || !input.suiteRef?.id || !input.suiteRef.version || !input.suiteRef.contentHash) {
        throw invalid("Evaluation request identity is invalid");
      }
      const state = await this.project();
      const replay = state.commands.get(input.commandId);
      if (replay) {
        if (replay.type !== "candidate.evaluation_requested" || replay.candidateId !== input.candidateId || replay.expectedContentHash !== input.expectedContentHash || canonical(replay.suiteRef) !== canonical(input.suiteRef)) throw conflict("Evolution command idempotency conflict");
        return this.get(input.candidateId);
      }
      const candidate = state.candidates.get(input.candidateId);
      if (!candidate) throw new HttpError(404, `Evolution candidate not found: ${input.candidateId}`, "EVOLUTION_CANDIDATE_NOT_FOUND");
      if (!candidate.validation?.passed || !["validated", "ready_for_eval"].includes(candidate.status) || candidate.contentHash !== input.expectedContentHash) throw conflict("Only the validated immutable candidate revision can request evaluation");
      const occurredAt = this.now().toISOString();
      await this.append({ eventId: createId("eve"), commandId: input.commandId.trim(), type: "candidate.evaluation_requested", occurredAt, candidateId: candidate.candidateId, expectedContentHash: candidate.contentHash, suiteRef: structuredClone(input.suiteRef) });
      return this.get(candidate.candidateId);
    });
  }

  async artifactContent(candidateId: string): Promise<string> {
    return this.readArtifact((await this.get(candidateId)).artifactRef);
  }

  private async project(): Promise<{ candidates: Map<string, EvolutionCandidate>; commands: Map<string, EvolutionLedgerEvent> }> {
    const candidates = new Map<string, EvolutionCandidate>();
    const commands = new Map<string, EvolutionLedgerEvent>();
    for (const event of await readLedger(workspaceEvolutionLedgerFile(this.workspaceRoot))) {
      const previousCommand = commands.get(event.commandId);
      if (previousCommand && JSON.stringify(previousCommand) !== JSON.stringify(event)) throw new Error("Evolution ledger command conflict");
      commands.set(event.commandId, event);
      if (event.type === "candidate.proposed") {
        if (event.candidate.scope.workspaceId !== this.workspaceId || event.candidate.sourceRefs.some((ref) => ref.workspaceId !== this.workspaceId)) {
          throw new Error("Evolution candidate crossed its workspace boundary");
        }
        const existing = candidates.get(event.candidate.candidateId);
        if (existing && JSON.stringify(existing) !== JSON.stringify(event.candidate)) throw new Error("Evolution candidate id conflict");
        candidates.set(event.candidate.candidateId, structuredClone(event.candidate));
      } else if (event.type === "candidate.validated") {
        const candidate = candidates.get(event.candidateId);
        if (!candidate) throw new Error("Evolution validation references a missing candidate");
        if (candidate.contentHash !== event.expectedContentHash) throw new Error("Evolution validation content hash mismatch");
        candidates.set(candidate.candidateId, {
          ...candidate,
          status: event.validation.passed ? "validated" : "rejected",
          validation: structuredClone(event.validation),
          updatedAt: event.occurredAt,
        });
      } else {
        const candidate = candidates.get(event.candidateId);
        if (!candidate || !candidate.validation?.passed || candidate.contentHash !== event.expectedContentHash) throw new Error("Evolution evaluation request references an invalid candidate");
        const refs = candidate.evaluationSuiteRefs ?? [];
        const exists = refs.some((ref) => canonical(ref) === canonical(event.suiteRef));
        candidates.set(candidate.candidateId, {
          ...candidate, status: "ready_for_eval", updatedAt: event.occurredAt,
          evaluationSuiteRefs: exists ? refs : [...refs, structuredClone(event.suiteRef)],
        });
      }
    }
    return { candidates, commands };
  }

  private async append(event: EvolutionLedgerEvent): Promise<void> {
    const file = workspaceEvolutionLedgerFile(this.workspaceRoot);
    const state = await this.project();
    const replay = state.commands.get(event.commandId);
    if (replay) {
      if (JSON.stringify(replay) !== JSON.stringify(event)) throw conflict("Evolution command idempotency conflict");
      return;
    }
    await mkdir(path.dirname(file), { recursive: true });
    await appendFile(file, `${JSON.stringify(event)}\n`, { encoding: "utf8", mode: 0o600, flush: true });
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const key = workspaceEvolutionLedgerFile(this.workspaceRoot).toLowerCase();
    const previous = ledgerQueues.get(key) ?? Promise.resolve();
    const pending = previous.catch(() => undefined).then(operation);
    const settled = pending.then(() => undefined, () => undefined);
    ledgerQueues.set(key, settled);
    return pending.finally(() => { if (ledgerQueues.get(key) === settled) ledgerQueues.delete(key); });
  }

  private async writeArtifact(contentHash: string, content: string): Promise<void> {
    const file = workspaceEvolutionArtifactFile(this.workspaceRoot, contentHash);
    const existing = await readOptional(file);
    if (existing !== undefined) {
      if (hash(existing) !== contentHash || existing !== content) throw new Error("Evolution artifact content conflict");
      return;
    }
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content, { encoding: "utf8", mode: 0o600, flag: "wx" }).catch(async (error) => {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" || await readFile(file, "utf8") !== content) throw error;
    });
  }

  private readArtifact(artifactRef: string): Promise<string> {
    const root = path.resolve(this.workspaceRoot, ".autoagent", "evolution", "artifacts");
    const file = path.resolve(this.workspaceRoot, ".autoagent", "evolution", artifactRef);
    if (!file.startsWith(`${root}${path.sep}`)) throw new Error("Evolution artifact escaped its storage root");
    return readFile(file, "utf8");
  }

  private async verifySourceRef(ref: EvolutionSourceRef): Promise<boolean> {
    if (ref.workspaceId !== this.workspaceId) return false;
    if (ref.kind === "evidence" || ref.kind === "human_feedback") return Boolean(await new EvidenceLedger(this.workspaceRoot).get(ref.ref));
    if (ref.kind === "trace") {
      return Boolean(ref.agentId && (await new AgentTraceStore(this.workspaceRoot, ref.agentId).list()).some((trace) => trace.traceId === ref.ref));
    }
    if (ref.kind === "goal_proposal" || ref.kind === "goal_decision") {
      if (!ref.agentId) return false;
      const aggregate = await new AgentStore(this.workspaceRoot, ref.agentId).read();
      return ref.kind === "goal_proposal"
        ? aggregate.proposals.some((proposal) => proposal.proposalId === ref.ref)
        : aggregate.decisions.some((decision) => decision.decisionId === ref.ref);
    }
    if (ref.kind === "mission") return Boolean(await new MissionStore(this.workspaceRoot, ref.ref).read());
    if (ref.kind === "ticket") {
      if (!ref.taskId || !ref.taskRunId) return false;
      const tickets = new TicketStore(this.workspaceRoot, ref.taskId, ref.taskRunId);
      for (const planId of await tickets.listPlanIds()) if ((await tickets.read(planId))?.tickets.some((ticket) => ticket.ticketId === ref.ref)) return true;
    }
    return false;
  }
}

export function parseCreateEvolutionCandidateInput(raw: CreateEvolutionCandidateInput, workspaceId: string, authority: EvolutionScopeAuthority = {}): CreateEvolutionCandidateInput {
  if (!raw || typeof raw !== "object") throw invalid("Evolution candidate must be an object");
  const input = structuredClone(raw);
  for (const field of ["commandId", "target", "title", "rationale", "hypothesis", "artifactContent"] as const) {
    if (typeof input[field] !== "string" || !input[field].trim()) throw invalid(`${field} is required`);
    input[field] = input[field].trim() as never;
  }
  if (!EVOLUTION_ARTIFACT_KINDS.includes(input.kind)) throw invalid("Unknown evolution artifact kind");
  if (!["skill", "memory", "prompt", "agent_profile", "workflow", "runtime_config", "source_patch", "plugin", "harness"].includes(input.kind)) throw invalid("This evolution asset kind is not implemented yet");
  if (!/^[a-z0-9][a-z0-9._-]{0,79}$/i.test(input.target)) throw invalid("Evolution target is invalid");
  if (input.artifactContent.length > (input.kind === "plugin" || input.kind === "harness" ? 750_000 : 200_000)) throw invalid("Evolution artifact is too large");
  if (!Array.isArray(input.sourceRefs) || input.sourceRefs.length === 0) throw invalid("At least one sourceRef is required");
  input.sourceRefs = input.sourceRefs.map((ref) => {
    if (!ref || !EVOLUTION_SOURCE_KINDS.includes(ref.kind) || typeof ref.ref !== "string" || !ref.ref.trim()) throw invalid("Evolution sourceRef is invalid");
    if (ref.workspaceId !== workspaceId) throw invalid("Evolution sourceRef crossed its workspace boundary");
    return { ...ref, ref: ref.ref.trim() };
  });
  if (!input.scope || input.scope.workspaceId !== workspaceId) throw invalid("Evolution scope must match the workspace");
  if (input.scope.organization) {
    const organization = input.scope.organization;
    const targets = [...new Set(organization.workspaceIds ?? [])].sort();
    const allowed = new Set(authority.organizationWorkspaceIds ?? []);
    if (input.kind !== "memory" || input.proposedBy?.type !== "human" || !["high", "critical"].includes(input.riskLevel)
      || !organization.id || organization.id !== authority.organizationId || !targets.length
      || targets.includes(workspaceId) || targets.some((target) => !allowed.has(target))) {
      throw invalid("Organization Memory requires a human proposal, high risk, matching organization authority, and explicit target workspaces");
    }
    input.scope.organization = { id: organization.id, workspaceIds: targets };
  }
  if (!Array.isArray(input.expectedMetrics) || input.expectedMetrics.length === 0) throw invalid("At least one expected metric is required");
  for (const metric of input.expectedMetrics) {
    if (!metric || typeof metric.metric !== "string" || !metric.metric.trim() || !["increase", "decrease", "maintain"].includes(metric.direction)) throw invalid("Evolution metric expectation is invalid");
  }
  if (!["low", "medium", "high", "critical"].includes(input.riskLevel)) throw invalid("Evolution risk level is invalid");
  if ((input.kind === "plugin" || input.kind === "harness") && input.riskLevel !== "critical") throw invalid("Plugin and harness candidates must be critical risk");
  if (input.kind === "source_patch" && input.riskLevel !== "critical") throw invalid("Source Patch candidates must be critical risk");
  if ((input.kind === "prompt" || input.kind === "agent_profile" || input.kind === "workflow" || input.kind === "runtime_config") && !["high", "critical"].includes(input.riskLevel)) throw invalid("Prompt, Agent Profile, Workflow, and Runtime Config candidates must be high or critical risk");
  if (!input.proposedBy || !["agent", "human", "system"].includes(input.proposedBy.type) || typeof input.proposedBy.id !== "string" || !input.proposedBy.id) throw invalid("Evolution proposer is invalid");
  return input;
}

function parseValidateEvolutionCandidateInput(raw: ValidateEvolutionCandidateInput): ValidateEvolutionCandidateInput {
  if (!raw || typeof raw.commandId !== "string" || !raw.commandId.trim() || typeof raw.candidateId !== "string" || !raw.candidateId || !/^[a-f0-9]{64}$/.test(raw.expectedContentHash)) {
    throw invalid("Evolution validation input is invalid");
  }
  return { ...raw, commandId: raw.commandId.trim() };
}

function validateCandidate(
  candidate: EvolutionCandidate,
  content: string,
  scanner: SkillScanReport | undefined,
  sourceVerification: boolean[],
  pluginBundle?: ParsedPluginBundle,
  pluginParseError?: string,
): EvolutionValidationCheck[] {
  const mutation = candidate.mutationSet;
  const common: EvolutionValidationCheck[] = [
    { name: "source_evidence", passed: candidate.sourceRefs.length > 0 && sourceVerification.length === candidate.sourceRefs.length && sourceVerification.every(Boolean), message: "Candidate source references resolve in authoritative workspace stores" },
    { name: "metric_hypothesis", passed: candidate.expectedMetrics.length > 0 && candidate.hypothesis.length >= 20, message: "Candidate has a falsifiable metric hypothesis" },
    { name: "scope_boundary", passed: candidate.sourceRefs.every((ref) => ref.workspaceId === candidate.scope.workspaceId), message: "Candidate is workspace scoped" },
    { name: "mutation_contract", passed: Boolean(mutation && mutation.assetKind === candidate.kind && mutation.target === candidate.target && mutation.candidateRef.id === candidate.candidateId && mutation.candidateRef.version === String(candidate.revision) && mutation.candidateRef.contentHash === candidate.contentHash && mutation.activationBoundary === DEFAULT_EVOLUTION_ACTIVATION_BOUNDARY[candidate.kind] && mutation.rollbackRef.id === mutation.baseRef.id && mutation.rollbackRef.contentHash === mutation.baseRef.contentHash), message: "MutationSet identity, base, rollback, and activation boundary match the immutable Candidate" },
  ];
  if (candidate.kind === "memory") return [...common,
    { name: "memory_body", passed: content.length >= 80 && content.length <= 50_000, message: "Memory contains a bounded operational lesson" },
    { name: "memory_safety", passed: !/-----BEGIN [A-Z ]*PRIVATE KEY-----|\bsk-[A-Za-z0-9_-]{16,}\b|\bignore\s+(?:all\s+)?previous\s+instructions\b|\bdisable\s+(?:the\s+)?(?:sandbox|approval|guardrails?)\b|\brm\s+-rf\s+\//i.test(content), message: "Memory contains no credential, governance bypass, or destructive directive" },
  ];
  if (candidate.kind === "prompt") return [...common,
    { name: "prompt_body", passed: content.length >= 40 && content.length <= 20_000, message: "Prompt fragment is non-empty and bounded" },
    { name: "prompt_safety", passed: !/-----BEGIN [A-Z ]*PRIVATE KEY-----|\bsk-[A-Za-z0-9_-]{16,}\b|ignore\s+(?:all\s+)?previous\s+instructions|disable\s+(?:the\s+)?(?:approval|guardrails?)/i.test(content), message: "Prompt contains no credential or governance bypass" },
  ];
  if (candidate.kind === "agent_profile") {
    const profile = parseAgentProfileArtifact(content);
    return [...common,
      { name: "agent_profile_contract", passed: Boolean(profile && profile.id === candidate.target), message: "Agent Profile artifact has schemaVersion 1 and matches the target profile" },
      { name: "agent_profile_permissions", passed: Boolean(profile && !Object.keys(profile).some((key) => ["defaultPolicy", "defaultProvider", "defaultModel"].includes(key))), message: "V1 Agent Profile evolution cannot expand policy or change provider/model" },
    ];
  }
  if (candidate.kind === "workflow") {
    const workflow = parseWorkflowArtifact(content);
    return [...common,
      { name: "workflow_contract", passed: Boolean(workflow && workflow.templateId === candidate.target), message: "Workflow artifact has schemaVersion 1 and matches the target template" },
      { name: "workflow_graph", passed: Boolean(workflow && Array.isArray(workflow.initialChange?.additions) && workflow.initialChange.additions.length > 0 && Array.isArray(workflow.initialChange?.requiredTerminalRefs) && workflow.initialChange.requiredTerminalRefs.length > 0), message: "Workflow declares initial tickets and at least one terminal reference" },
    ];
  }
  if (candidate.kind === "source_patch") {
    const patch = parseSourcePatchArtifact(content);
    return [...common,
      { name: "source_patch_contract", passed: Boolean(patch), message: "Source Patch declares repository, exact base commit, bounded paths, required checks, and unified diff" },
      { name: "source_patch_scope", passed: Boolean(patch && patch.files.every(safeSourcePatchPath)), message: "Source Patch files remain inside the allowed repository scope" },
      { name: "source_patch_sensitive_roots", passed: Boolean(patch && patch.files.every((file) => !/^(?:\.git|\.autoagent|node_modules|dist)(?:\/|$)/.test(file))), message: "Source Patch does not modify runtime state, SCM metadata, dependencies, or build output" },
    ];
  }
  if (candidate.kind === "runtime_config") {
    const runtimeConfig = parseRuntimeConfigArtifact(content);
    return [...common,
      { name: "runtime_config_contract", passed: Boolean(runtimeConfig && candidate.target === "runtime-host"), message: "Runtime Config uses the restricted schema and targets runtime-host" },
      { name: "runtime_config_bounds", passed: Boolean(runtimeConfig && validRuntimeConfigBounds(runtimeConfig)), message: "Runtime Config values stay inside operational safety bounds" },
    ];
  }
  if (candidate.kind === "plugin" || candidate.kind === "harness") return [...common,
    { name: "plugin_bundle", passed: Boolean(pluginBundle), message: pluginBundle ? "Plugin bundle contract is valid" : `Plugin bundle is invalid: ${pluginParseError ?? "schema validation failed"}` },
    { name: "plugin_static_scan", passed: pluginBundle?.scan.decision === "pass", message: pluginBundle?.scan.decision === "pass" ? "Plugin static scan passed" : `Plugin static scan requires ${pluginBundle?.scan.decision ?? "block"}` },
    { name: "plugin_risk_classification", passed: candidate.riskLevel === "critical", message: "Executable extensions are classified critical risk" },
    { name: "plugin_capability_scope", passed: !pluginBundle?.manifest.permissions.workspaceRead.length || candidate.scope.tools?.includes("readFile") === true, message: "Brokered workspace reads require readFile in Candidate scope" },
  ];
  if (candidate.kind !== "skill") return common;
  const frontmatterName = /^---\s*[\s\S]*?\bname:\s*([^\r\n]+)[\s\S]*?---/m.exec(content)?.[1]?.trim();
  return [...common,
    { name: "skill_frontmatter", passed: content.startsWith("---") && /\bdescription:\s*\S+/m.test(content), message: "Skill declares frontmatter and description" },
    { name: "skill_name", passed: frontmatterName === candidate.target, message: "Skill name matches target" },
    { name: "skill_body", passed: /^#\s+\S+/m.test(content) && content.length >= 120, message: "Skill contains focused instructions" },
    { name: "skill_static_scan", passed: scanner?.decision === "pass", message: scanner?.decision === "pass" ? "Static Skill scan passed" : `Static Skill scan requires ${scanner?.decision ?? "block"}` },
    { name: "skill_risk_classification", passed: !(scanner?.detectedCapabilities.some((item) => item === "shell" || item === "process")) || ["high", "critical"].includes(candidate.riskLevel), message: "Executable Skill content is classified high or critical risk" },
  ];
}

async function readLedger(file: string): Promise<EvolutionLedgerEvent[]> {
  const content = await readOptional(file);
  if (content === undefined) return [];
  return content.split(/\r?\n/).filter(Boolean).map((line, index) => {
    try {
      const event = JSON.parse(line) as EvolutionLedgerEvent;
      if (!event || typeof event.eventId !== "string" || typeof event.commandId !== "string" || !["candidate.proposed", "candidate.validated", "candidate.evaluation_requested"].includes(event.type)) throw new Error("invalid event");
      return event;
    } catch (error) {
      throw new Error(`Evolution ledger is corrupt at line ${index + 1}: ${(error as Error).message}`);
    }
  });
}

async function readOptional(file: string): Promise<string | undefined> {
  try { return await readFile(file, "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}

async function writeImmutableSkillEntrypoint(workspaceRoot: string, contentHash: string, content: string): Promise<void> {
  const file = workspaceEvolutionSkillEntrypointFile(workspaceRoot, contentHash);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content, { encoding: "utf8", mode: 0o600, flag: "wx" }).catch(async (error) => {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST" || await readFile(file, "utf8") !== content) throw error;
  });
}

function relativeArtifactRef(contentHash: string): string { return path.join("artifacts", contentHash, "artifact.txt").replaceAll("\\", "/"); }
function relativeArtifactManifestRef(contentHash: string, candidateId: string): string { return path.join("artifacts", contentHash, "manifests", `${candidateId}.json`).replaceAll("\\", "/"); }
function hash(content: string): string { return createHash("sha256").update(content, "utf8").digest("hex"); }
function parseAgentProfileArtifact(content: string): Record<string, unknown> | undefined {
  let value: Record<string, unknown>;
  try { value = JSON.parse(content) as Record<string, unknown>; } catch { return undefined; }
  const allowed = new Set(["schemaVersion", "id", "identity", "soul", "agentMd", "capabilities", "defaultSkills"]);
  if (value.schemaVersion !== 1 || typeof value.id !== "string" || Object.keys(value).some((key) => !allowed.has(key))) return undefined;
  for (const key of ["identity", "soul", "agentMd"] as const) if (value[key] !== undefined && (typeof value[key] !== "string" || value[key].length > 50_000)) return undefined;
  for (const key of ["capabilities", "defaultSkills"] as const) if (value[key] !== undefined && (!Array.isArray(value[key]) || value[key].length > 128 || value[key].some((item) => typeof item !== "string" || !item.trim()))) return undefined;
  return value;
}
function parseWorkflowArtifact(content: string): { templateId: string; initialChange?: { additions?: unknown[]; requiredTerminalRefs?: unknown[] } } | undefined {
  let value: Record<string, unknown>;
  try { value = JSON.parse(content) as Record<string, unknown>; } catch { return undefined; }
  const allowed = new Set(["schemaVersion", "templateId", "definitionVersion", "plannerAssignment", "amendmentTemplate", "initialChange"]);
  if (value.schemaVersion !== 1 || typeof value.templateId !== "string" || !Number.isSafeInteger(value.definitionVersion) || Object.keys(value).some((key) => !allowed.has(key))) return undefined;
  if (!value.plannerAssignment || typeof value.plannerAssignment !== "object" || !value.amendmentTemplate || typeof value.amendmentTemplate !== "object" || !value.initialChange || typeof value.initialChange !== "object") return undefined;
  return value as unknown as { templateId: string; initialChange: { additions?: unknown[]; requiredTerminalRefs?: unknown[] } };
}
function parseSourcePatchArtifact(content: string): EvolutionSourcePatchArtifact | undefined {
  let value: EvolutionSourcePatchArtifact;
  try { value = JSON.parse(content) as EvolutionSourcePatchArtifact; } catch { return undefined; }
  if (value?.schemaVersion !== 1 || !/^[a-z0-9][a-z0-9._/-]{0,199}$/i.test(value.repositoryId) || !/^[a-f0-9]{40,64}$/i.test(value.baseCommit)
    || !/^[a-z0-9][a-z0-9._/-]{0,199}$/i.test(value.targetBranch) || !Array.isArray(value.files) || !value.files.length || value.files.length > 128
    || value.files.some((file) => !safeSourcePatchPath(file)) || !Array.isArray(value.requiredChecks) || !value.requiredChecks.length || value.requiredChecks.length > 32
    || value.requiredChecks.some((name) => typeof name !== "string" || !name.trim()) || typeof value.patch !== "string" || value.patch.length > 500_000
    || !value.patch.startsWith("diff --git ") || /GIT binary patch|Binary files .* differ/.test(value.patch)) return undefined;
  const declared = new Set(value.files);
  const patched = new Set<string>();
  for (const match of value.patch.matchAll(/^diff --git a\/(.+) b\/(.+)$/gm)) {
    if (match[1] !== match[2] || !declared.has(match[1]!)) return undefined;
    patched.add(match[1]!);
  }
  if (patched.size !== declared.size || [...declared].some((file) => !patched.has(file))) return undefined;
  return value;
}

function parseRuntimeConfigArtifact(content: string): EvolutionRuntimeConfigArtifact | undefined {
  let value: unknown;
  try { value = JSON.parse(content) as unknown; } catch { return undefined; }
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== 1 || record.target !== "runtime-host" || !record.settings || typeof record.settings !== "object" || Array.isArray(record.settings)) return undefined;
  if (Object.keys(record).some((key) => !["schemaVersion", "target", "settings"].includes(key))) return undefined;
  const allowed = new Set(["intervalMs", "providerRetryBaseMs", "providerRetryMaxMs", "staffingProviderFailureLimit", "staffingProviderRetryBaseMs", "staffingProviderRetryMaxMs"]);
  const settings = record.settings as Record<string, unknown>;
  if (Object.keys(settings).some((key) => !allowed.has(key))) return undefined;
  if (Object.values(settings).some((item) => typeof item !== "number" || !Number.isSafeInteger(item))) return undefined;
  return value as EvolutionRuntimeConfigArtifact;
}

function validRuntimeConfigBounds(value: EvolutionRuntimeConfigArtifact): boolean {
  const settings = value.settings;
  const inRange = (item: number | undefined, min: number, max: number) => item === undefined || (item >= min && item <= max);
  if (!inRange(settings.intervalMs, 100, 60_000)
    || !inRange(settings.providerRetryBaseMs, 100, 300_000)
    || !inRange(settings.providerRetryMaxMs, 100, 900_000)
    || !inRange(settings.staffingProviderFailureLimit, 1, 20)
    || !inRange(settings.staffingProviderRetryBaseMs, 100, 300_000)
    || !inRange(settings.staffingProviderRetryMaxMs, 100, 900_000)) return false;
  if (settings.providerRetryBaseMs !== undefined && settings.providerRetryMaxMs !== undefined && settings.providerRetryMaxMs < settings.providerRetryBaseMs) return false;
  return !(settings.staffingProviderRetryBaseMs !== undefined && settings.staffingProviderRetryMaxMs !== undefined && settings.staffingProviderRetryMaxMs < settings.staffingProviderRetryBaseMs);
}
function safeSourcePatchPath(value: string): boolean {
  if (!value || value.includes("\\") || value.includes("\0") || path.posix.isAbsolute(value)) return false;
  const normalized = path.posix.normalize(value);
  return normalized === value && normalized !== ".." && !normalized.startsWith("../");
}
function genesisRef(candidate: Pick<EvolutionCandidate, "kind" | "target" | "scope">): VersionedEvolutionRef {
  return { id: `genesis:${hash(canonical({ kind: candidate.kind, target: candidate.target, scope: candidate.scope })).slice(0, 24)}`, version: "0", contentHash: hash("") };
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value);
}
function candidateInputFingerprint(input: CreateEvolutionCandidateInput): string { return hash(JSON.stringify(input)); }
function invalid(message: string): HttpError { return new HttpError(400, message, "INVALID_EVOLUTION_CANDIDATE"); }
function conflict(message: string): HttpError { return new HttpError(409, message, "EVOLUTION_CONFLICT"); }
