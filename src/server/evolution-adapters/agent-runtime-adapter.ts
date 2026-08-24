import { createHash } from "node:crypto";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { AgentEvolutionRuntimePort, EvolutionToolBinding } from "../agent-engine/evolution-runtime-port.js";
import type { AgentToolRuntime } from "../agent-engine/tool-runtime.js";
import { EvolutionActivationStore } from "../evolution/activation-store.js";
import { EvolutionEvaluationStore } from "../evolution/evaluation-store.js";
import { EvolutionStore } from "../evolution/evolution-store.js";
import { IsolatedPluginHost, pluginToolName } from "../evolution/plugin-host.js";
import { runtimeEvolutionProjection, runtimeEvolutionStateFingerprint } from "../evolution/runtime-projection.js";
import type { OrganizationMemorySource, RuntimeEvolutionExtension, SharedEvolutionLayerSource } from "../../shared/contracts/evolution-runtime.js";

export class EvolutionAgentRuntimeAdapter implements AgentEvolutionRuntimePort {
  constructor(
    private readonly workspaceRoot: string,
    private readonly workspaceId: string,
    private readonly options: {
      now?: () => Date;
      organizationMemorySources?: () => Promise<OrganizationMemorySource[]>;
      sharedEvolutionLayerSources?: (profileId: string) => Promise<SharedEvolutionLayerSource[]>;
    } = {},
  ) {}

  async fingerprint(profileId: string): Promise<string> {
    return runtimeEvolutionStateFingerprint(this.workspaceRoot, await this.options.organizationMemorySources?.() ?? [], await this.options.sharedEvolutionLayerSources?.(profileId) ?? []);
  }

  async project(input: Parameters<AgentEvolutionRuntimePort["project"]>[0]) {
    return runtimeEvolutionProjection(this.workspaceRoot, input.workspaceId, input.profile, input.agent, {
      assignmentKey: input.assignmentKey, taskType: input.taskType, objective: input.objective, constraints: input.constraints, tools: input.tools,
      organizationMemorySources: await this.options.organizationMemorySources?.() ?? [],
      sharedReleaseSources: await this.options.sharedEvolutionLayerSources?.(input.profile.id) ?? [],
    });
  }

  agentTools(input: { enabled: boolean; agentId: string }): ToolDefinition[] {
    return input.enabled ? [proposeEvolutionCandidateTool(this.workspaceRoot, this.workspaceId, input.agentId), queryEvolutionStatusTool(this.workspaceRoot, this.workspaceId)] : [];
  }

  mountTools(input: { baseTools: ToolDefinition[]; projection: Awaited<ReturnType<AgentEvolutionRuntimePort["project"]>>; toolRuntime: AgentToolRuntime; binding: EvolutionToolBinding }) {
    const pluginTools = evolutionPluginTools(input.projection.plugins, input.toolRuntime, input.binding);
    return {
      tools: withEvolutionHarnesses([...input.baseTools, ...pluginTools], input.projection.harnesses, input.toolRuntime, input.binding),
      evolutionToolNames: pluginTools.map((tool) => tool.name),
    };
  }

  async observe(input: Parameters<AgentEvolutionRuntimePort["observe"]>[0]): Promise<void> {
    const sharedSources = await this.options.sharedEvolutionLayerSources?.(input.traceRef.profileId ?? "") ?? [];
    const storeFor = (ownerLevel: typeof input.projection.resolvedReleases[number]["ownerLevel"]) => {
      const source = (ownerLevel === "agent" || ownerLevel === "company") ? sharedSources.find((item) => item.ownerLevel === ownerLevel) : undefined;
      return new EvolutionActivationStore(source?.layerRoot ?? this.workspaceRoot, this.options.now);
    };
    const observe = (assetKind: "skill" | "memory" | "plugin" | "harness" | "prompt" | "agent_profile", target: string, item: { releaseId: string; releaseVersion: string; contentHash: string; generation: number; ownerLevel: "agent_project" | "agent" | "project" | "company" }, runtimeKind: "turn" | "session") => storeFor(item.ownerLevel).observe({
      assetKind, target, releaseRef: { id: item.releaseId, version: item.releaseVersion, contentHash: item.contentHash },
      desiredGeneration: item.generation, actualGeneration: item.generation, ownerLevel: item.ownerLevel,
      runtimeKind, runtimeRef: runtimeKind === "turn" ? input.turnId : input.sessionId,
      runtimeSnapshotHash: input.projection.snapshotHash, traceRef: input.traceRef,
    });
    await Promise.all([
      ...input.projection.skills.map((item) => observe("skill", item.name, item, "turn")),
      ...input.projection.memories.filter((item) => !item.sourceWorkspaceId).map((item) => observe("memory", item.target, item, "turn")),
      ...input.projection.plugins.map((item) => observe("plugin", item.name, item, "session")),
      ...input.projection.harnesses.map((item) => observe("harness", item.name, item, "session")),
      ...input.projection.prompts.map((item) => observe("prompt", item.target, item, "turn")),
      ...input.projection.agentProfiles.map((item) => observe("agent_profile", item.target, item, "session")),
    ]);
  }
}

function proposeEvolutionCandidateTool(workspaceRoot: string, workspaceId: string, agentId: string): ToolDefinition {
  return defineTool({
    name: "propose_evolution_candidate", label: "提出公司进化候选",
    description: "基于当前任务的可验证证据提出版本化候选。该工具只能提案，不能自行验证、评分、晋升或修改当前 Runtime。",
    parameters: Type.Object({
      kind: Type.Optional(Type.Union([Type.Literal("memory"), Type.Literal("skill"), Type.Literal("prompt"), Type.Literal("workflow"), Type.Literal("agent_profile"), Type.Literal("plugin"), Type.Literal("harness")])),
      target: Type.String(), title: Type.String(), rationale: Type.String(), hypothesis: Type.String(), artifactContent: Type.String(),
      sourceRefs: Type.Array(Type.Object({ kind: Type.Union([Type.Literal("ticket"), Type.Literal("goal_proposal"), Type.Literal("goal_decision"), Type.Literal("evidence"), Type.Literal("trace"), Type.Literal("mission"), Type.Literal("human_feedback")]), ref: Type.String() }), { minItems: 1, maxItems: 32 }),
      expectedMetrics: Type.Array(Type.Object({ metric: Type.String(), direction: Type.Union([Type.Literal("increase"), Type.Literal("decrease"), Type.Literal("maintain")]), minimumDelta: Type.Optional(Type.Number()), maximumRegression: Type.Optional(Type.Number()) }), { minItems: 1, maxItems: 16 }),
      riskLevel: Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high"), Type.Literal("critical")]),
      roles: Type.Optional(Type.Array(Type.String(), { maxItems: 16 })), taskTypes: Type.Optional(Type.Array(Type.String(), { maxItems: 16 })), tools: Type.Optional(Type.Array(Type.String(), { maxItems: 16 })),
    }),
    async execute(_callId, params) {
      const candidate = await new EvolutionStore(workspaceId, workspaceRoot).create({
        commandId: createHash("sha256").update(JSON.stringify({ agentId, ...params })).digest("hex"), kind: params.kind ?? "skill",
        target: params.target, title: params.title, rationale: params.rationale, hypothesis: params.hypothesis, artifactContent: params.artifactContent,
        sourceRefs: params.sourceRefs.map((ref) => ({ ...ref, workspaceId, agentId })),
        scope: { workspaceId, ...(params.roles ? { roles: params.roles } : {}), ...(params.taskTypes ? { taskTypes: params.taskTypes } : {}), ...(params.tools ? { tools: params.tools } : {}) },
        expectedMetrics: params.expectedMetrics, riskLevel: params.riskLevel, proposedBy: { type: "agent", id: agentId },
      });
      return { content: [{ type: "text", text: JSON.stringify({ proposed: true, candidateId: candidate.candidateId, revision: candidate.revision, status: candidate.status, productionChanged: false }) }], details: { candidate } };
    },
  });
}

function queryEvolutionStatusTool(workspaceRoot: string, workspaceId: string): ToolDefinition {
  return defineTool({
    name: "query_evolution_status", label: "查询公司进化状态", description: "只读查询候选、独立评测和分级发布状态。该工具不能验证、评分、晋升或回滚任何候选。",
    parameters: Type.Object({ candidateId: Type.Optional(Type.String()) }),
    async execute(_callId, params) {
      const candidates = new EvolutionStore(workspaceId, workspaceRoot);
      const evaluations = new EvolutionEvaluationStore(workspaceId, workspaceRoot, candidates);
      const selected = params.candidateId ? [await candidates.get(params.candidateId)] : (await candidates.list()).slice(-20);
      const promotions = await evaluations.listPromotions();
      const result = await Promise.all(selected.map(async (candidate) => ({
        candidateId: candidate.candidateId, revision: candidate.revision, kind: candidate.kind, target: candidate.target, contentHash: candidate.contentHash, status: candidate.status,
        evaluations: (await evaluations.listEvaluations(candidate.candidateId)).map((run) => ({ evaluationId: run.evaluationId, decision: run.decision, createdAt: run.createdAt })),
        promotions: promotions.filter((record) => record.candidateId === candidate.candidateId).map((record) => ({ promotionId: record.promotionId, stage: record.stage, status: record.status, release: record.toRelease })),
      })));
      return { content: [{ type: "text", text: JSON.stringify({ candidates: result }) }], details: { candidates: result } };
    },
  });
}

function evolutionPluginTools(plugins: RuntimeEvolutionExtension[], tools: AgentToolRuntime, binding: EvolutionToolBinding): ToolDefinition[] {
  const names = new Set<string>(); const definitions: ToolDefinition[] = [];
  for (const plugin of plugins) for (const contribution of plugin.manifest.contributions.tools) {
    const name = pluginToolName(plugin.name, contribution.name);
    if (names.has(name)) throw new Error(`Evolution plugin tool collision: ${name}`);
    names.add(name);
    definitions.push(defineTool({
      name, label: `${plugin.name}: ${contribution.name}`, description: contribution.description,
      parameters: Type.Unsafe<Record<string, unknown>>(contribution.inputSchema), executionMode: "sequential",
      async execute(callId, params) {
        const result = await new IsolatedPluginHost(plugin, tools, binding).invokeTool(contribution.name, params, callId);
        return { content: [{ type: "text", text: typeof result === "string" ? result : JSON.stringify(result) }], details: { plugin: plugin.name, releaseId: plugin.releaseId, result } };
      },
    }));
  }
  return definitions;
}

export function withEvolutionHarnesses(definitions: ToolDefinition[], harnesses: RuntimeEvolutionExtension[], tools: AgentToolRuntime, binding: EvolutionToolBinding): ToolDefinition[] {
  const names = new Set<string>();
  for (const definition of definitions) { if (names.has(definition.name)) throw new Error(`Runtime tool collision while mounting evolution extensions: ${definition.name}`); names.add(definition.name); }
  if (!harnesses.length) return definitions;
  return definitions.map((definition) => {
    const guards = harnesses.flatMap((harness) => harness.manifest.contributions.guardrails.filter((guard) => guard.tools.includes("*") || guard.tools.includes(definition.name)).map((guard) => ({ harness, guard })));
    if (!guards.length) return definition;
    return { ...definition, async execute(callId, params, signal, onUpdate, context) {
      for (const { harness, guard } of guards.filter((item) => item.guard.phase === "pre_tool")) {
        const decision = await new IsolatedPluginHost(harness, tools, binding).guard(guard, definition.name, params, undefined, `${callId}:pre:${guard.name}`);
        if (decision.behavior === "reject") return harnessRejection(harness, guard.name, definition.name, decision.message);
      }
      const output = await definition.execute(callId, params, signal, onUpdate, context);
      for (const { harness, guard } of guards.filter((item) => item.guard.phase === "post_tool")) {
        const decision = await new IsolatedPluginHost(harness, tools, binding).guard(guard, definition.name, params, output, `${callId}:post:${guard.name}`);
        if (decision.behavior === "reject") return harnessRejection(harness, guard.name, definition.name, decision.message);
      }
      return output;
    } };
  });
}

function harnessRejection(harness: RuntimeEvolutionExtension, guardrail: string, tool: string, message?: string) {
  const reason = message ?? `Evolution harness ${harness.name} rejected ${tool}`;
  return { content: [{ type: "text" as const, text: reason }], details: { ok: false, rejected: true, harness: harness.name, releaseId: harness.releaseId, guardrail, tool, reason } };
}
