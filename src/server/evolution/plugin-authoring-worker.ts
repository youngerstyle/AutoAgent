import type { EvolutionPractice, EvolutionScope } from "../../shared/contracts/evolution.js";
import type { ProviderRegistry } from "../providers/provider-registry.js";
import { EvolutionStore } from "./evolution-store.js";
import { PluginAuthoringJobStore } from "./plugin-authoring-job-store.js";
import { PracticeBindingStore } from "./practice-binding-store.js";
import { PracticeStore } from "./practice-store.js";

export interface PluginArtifactAuthor { available(): Promise<boolean>; author(practice: EvolutionPractice, target: string): Promise<string> }

export class ProviderPluginArtifactAuthor implements PluginArtifactAuthor {
  constructor(private readonly providers: ProviderRegistry) {}
  async available(): Promise<boolean> { const status = await this.providers.status(); return status.openai.configured || status.anthropic.configured; }
  async author(practice: EvolutionPractice, target: string): Promise<string> {
    const configs = await this.providers.modelConfigs();
    const selected = configs.find((item) => item.isDefault) ?? configs[0];
    if (!selected) throw new Error("No real Provider model is configured for Plugin authoring");
    const result = await this.providers.runModelTurnWithRetry({ provider: selected.provider, model: selected.model, tools: [], instructions: pluginAuthorInstructions(target), history: [{ type: "user_message", content: JSON.stringify({ practice: { statement: practice.statement, trigger: practice.trigger, procedure: practice.procedure, contraindications: practice.contraindications, expectedOutcome: practice.expectedOutcome }, target }) }] });
    const text = result.items.filter((item): item is Extract<typeof item, { type: "assistant_message" }> => item.type === "assistant_message").map((item) => item.content).join("\n").trim();
    const json = extractJson(text); JSON.parse(json); return json;
  }
}

/** Authors code only as an immutable critical-risk Candidate; it never activates or executes the generated Plugin. */
export class PluginAuthoringWorker {
  constructor(
    private readonly workspaceId: string,
    private readonly workspaceRoot: string,
    private readonly author: PluginArtifactAuthor,
    private readonly now: () => Date = () => new Date(),
    private readonly candidates = new EvolutionStore(workspaceId, workspaceRoot, now),
  ) {}
  async run(): Promise<{ jobsInspected: number; candidatesCreated: number }> {
    const bindings = new PracticeBindingStore(this.workspaceRoot, this.now); const practices = new PracticeStore(this.workspaceId, this.workspaceRoot, this.now);
    const candidates = this.candidates; const jobs = new PluginAuthoringJobStore(this.workspaceRoot, this.now);
    const pending = (await bindings.list()).filter((item) => item.kind === "plugin" && item.status === "proposed");
    for (const binding of pending) await jobs.enqueue(`plugin-authoring:${binding.bindingId}`, binding.bindingId, binding.practiceRef.id, Number(binding.practiceRef.version));
    if (!await this.author.available()) return { jobsInspected: pending.length, candidatesCreated: 0 };
    let created = 0;
    for (const queued of (await jobs.list()).filter((item) => ["pending", "retry_wait"].includes(item.status))) {
      const job = await jobs.claim(queued.jobId); if (!job) continue;
      try {
        const binding = (await bindings.list()).find((item) => item.bindingId === job.bindingId);
        const practice = (await practices.list()).find((item) => item.practiceId === job.practiceId && item.version === job.practiceVersion);
        if (!binding || binding.kind !== "plugin" || binding.status !== "proposed" || !practice || practice.provenanceHash !== binding.practiceRef.contentHash) throw new TerminalAuthoringError("Plugin authoring lineage no longer resolves");
        const scope: EvolutionScope = { workspaceId: this.workspaceId, ownerLevel: practice.applicability.ownerLevel, ...(practice.applicability.profileId ? { profileId: practice.applicability.profileId } : {}), ...(practice.applicability.roles ? { roles: practice.applicability.roles } : {}), ...(practice.applicability.taskTypes ? { taskTypes: practice.applicability.taskTypes } : {}) };
        const artifactContent = await this.author.author(practice, binding.target);
        const candidate = await candidates.create({ commandId: `plugin-authoring-candidate:${job.jobId}`, kind: "plugin", target: binding.target, title: `Learned local Plugin: ${practice.statement.slice(0, 80)}`, rationale: `A tool-level Practice supported by ${practice.sourceEpisodeRefs.length} Episodes requires a locally loaded capability. Provider-authored code remains critical-risk, statically scanned, evaluated, human-approved, and next-session activated.`, hypothesis: "The narrowly permissioned local Plugin improves the Practice metrics without policy or safety regressions.", artifactContent, sourceRefs: structuredClone(practice.sourceRefs), scope, expectedMetrics: structuredClone(practice.expectedOutcome), riskLevel: "critical", proposedBy: { type: "system", id: "plugin-authoring-worker/v1" }, practiceRef: binding.practiceRef });
        const validated = await candidates.validate({ commandId: `plugin-authoring-validate:${job.jobId}`, candidateId: candidate.candidateId, expectedContentHash: candidate.contentHash });
        if (!validated.validation?.passed || validated.validation.pluginScanner?.decision !== "pass") throw new TerminalAuthoringError(`Generated Plugin failed validation: ${validated.validation?.checks.filter((item) => !item.passed).map((item) => item.name).join(", ") || validated.validation?.pluginScanner?.decision}`);
        await bindings.attachCandidate(`plugin-authoring-attach:${job.jobId}`, binding.bindingId, { id: validated.candidateId, version: String(validated.revision), contentHash: validated.contentHash });
        await jobs.succeed(job.jobId, validated.candidateId); created += 1;
      } catch (error) { await jobs.fail(job.jobId, error instanceof Error ? error.message : String(error), error instanceof TerminalAuthoringError); }
    }
    return { jobsInspected: pending.length, candidatesCreated: created };
  }
}

class TerminalAuthoringError extends Error {}
function extractJson(value: string): string { const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(value); if (fenced) return fenced[1]!; const start = value.indexOf("{"); const end = value.lastIndexOf("}"); if (start < 0 || end <= start) throw new Error("Plugin author did not return a JSON bundle"); return value.slice(start, end + 1); }
function pluginAuthorInstructions(target: string): string { return `Return only one JSON object conforming to AutoAgent PluginBundle schemaVersion 1. manifest.id must be ${target}, kind plugin, apiVersion autoagent.plugin/v1, entrypoint index.mjs, semantic version 1.0.0, lifecycle activation onDemand and invokeTimeoutMs 100-15000. Contribute at least one narrowly named tool with a closed JSON object inputSchema. Use the minimum workspaceRead permissions (prefer []). files must contain index.mjs exporting a default object with async health() returning {ok:true} and async invokeTool({name,input,context}). No network, process execution, dynamic code, secrets, package imports, filesystem APIs, governance bypass, or undeclared capabilities. If workspace reads are essential, call context.requestCapability("workspace.read", {path}) only for declared safe relative paths. Implement only the supplied learned Practice; do not add unrelated capabilities.`; }
