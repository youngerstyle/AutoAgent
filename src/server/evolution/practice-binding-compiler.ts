import { createHash } from "node:crypto";
import type { AttributionComponent, EvolutionArtifactKind, EvolutionCandidate, EvolutionPractice, EvolutionScope, VersionedEvolutionRef } from "../../shared/contracts/evolution.js";
import { EvolutionStore } from "./evolution-store.js";
import { PracticeBindingStore } from "./practice-binding-store.js";
import { PracticeStore } from "./practice-store.js";
import { createMinimalTeamPlanDefinition, DEFAULT_PLAN_TEMPLATE_ID } from "../product/plan-template.js";

export interface PracticeBindingResult { practicesInspected: number; bindingsProposed: number; candidatesCreated: EvolutionCandidate[] }

export class PracticeBindingCompiler {
  constructor(
    private readonly workspaceId: string,
    private readonly practices: PracticeStore,
    private readonly bindings: PracticeBindingStore,
    private readonly candidates: EvolutionStore,
  ) {}

  async compile(): Promise<PracticeBindingResult> {
    const practices = (await this.practices.list()).filter((practice) => practice.status === "candidate");
    const existing = await this.bindings.list();
    let proposed = 0;
    const candidates: EvolutionCandidate[] = [];
    for (const practice of practices) {
      if (practice.applicability.workspaceId !== this.workspaceId) throw new Error("Practice binding crossed its workspace boundary");
      for (const kind of bindingKinds(practice.observedComponents)) {
        const practiceRef = versionedPracticeRef(practice);
        const target = targetFor(practice, kind);
        let binding = existing.find((item) => item.practiceRef.id === practice.practiceId && item.practiceRef.version === String(practice.version) && item.kind === kind);
        if (!binding) {
          binding = await this.bindings.propose(`practice-binding:${practice.practiceId}:${practice.version}:${kind}`, practiceRef, kind, target);
          existing.push(binding);
          proposed += 1;
        }
        if (binding.status !== "proposed" || !autoRenderable(kind)) continue;
        const candidate = await this.candidates.create(candidateInput(practice, practiceRef, kind, target));
        await this.bindings.attachCandidate(`practice-binding-candidate:${binding.bindingId}:${candidate.contentHash}`, binding.bindingId, {
          id: candidate.candidateId, version: String(candidate.revision), contentHash: candidate.contentHash,
        });
        candidates.push(candidate);
      }
    }
    return { practicesInspected: practices.length, bindingsProposed: proposed, candidatesCreated: candidates };
  }
}

function bindingKinds(components: AttributionComponent[]): EvolutionArtifactKind[] {
  const kinds = components.map((component): EvolutionArtifactKind | undefined => {
    if (["memory", "provider", "environment"].includes(component)) return "memory";
    if (component === "tool") return "plugin";
    if (component === "prompt") return "prompt";
    if (component === "skill") return "skill";
    if (["workflow", "plan"].includes(component)) return "workflow";
    if (component === "agent_profile") return "agent_profile";
    if (component === "runtime_config") return "runtime_config";
    return undefined;
  }).filter((value): value is EvolutionArtifactKind => Boolean(value));
  return [...new Set(kinds)].sort();
}

function autoRenderable(kind: EvolutionArtifactKind): kind is "memory" | "prompt" | "skill" | "workflow" {
  return ["memory", "prompt", "skill", "workflow"].includes(kind);
}
function versionedPracticeRef(practice: EvolutionPractice): VersionedEvolutionRef {
  return { id: practice.practiceId, version: String(practice.version), contentHash: practice.provenanceHash };
}
function targetFor(practice: EvolutionPractice, kind: EvolutionArtifactKind): string {
  if (kind === "workflow") return DEFAULT_PLAN_TEMPLATE_ID;
  if (kind === "plugin") return `practice_plugin_${hash(`${practice.practiceId}:${practice.version}`).slice(0, 16)}`;
  return `practice.${kind}.${hash(`${practice.practiceId}:${practice.version}`).slice(0, 16)}`;
}
function candidateInput(practice: EvolutionPractice, practiceRef: VersionedEvolutionRef, kind: "memory" | "prompt" | "skill" | "workflow", target: string) {
  const scope: EvolutionScope = {
    workspaceId: practice.applicability.workspaceId!, ownerLevel: practice.applicability.ownerLevel,
    ...(practice.applicability.profileId ? { profileId: practice.applicability.profileId } : {}),
    ...(practice.applicability.roles ? { roles: practice.applicability.roles } : {}),
    ...(practice.applicability.taskTypes ? { taskTypes: practice.applicability.taskTypes } : {}),
  };
  return {
    commandId: `practice-candidate:${practice.practiceId}:${practice.version}:${kind}`,
    kind, target, title: `Learned ${kind}: ${short(practice.statement, 80)}`,
    rationale: `Practice ${practice.practiceId} is supported by ${practice.sourceEpisodeRefs.length} independent episodes and is being compiled into its smallest applicable asset binding.`,
    hypothesis: `Applying this ${kind} only in the declared scope will improve the expected metrics without increasing policy or safety violations.`,
    artifactContent: render(practice, kind, target), sourceRefs: structuredClone(practice.sourceRefs), scope,
    expectedMetrics: structuredClone(practice.expectedOutcome),
    riskLevel: kind === "memory" ? "low" as const : kind === "skill" ? "medium" as const : "high" as const,
    proposedBy: { type: "system" as const, id: "practice-binding-compiler/v1" }, practiceRef,
  };
}
function render(practice: EvolutionPractice, kind: "memory" | "prompt" | "skill" | "workflow", target: string): string {
  const support = `Support episodes: ${practice.sourceEpisodeRefs.join(", ")}`;
  if (kind === "memory") return ["# Scoped operational memory", "", `Trigger: ${practice.trigger}`, `Learned practice: ${practice.statement}`, "", "## Procedure", "", practice.procedure, "", "Apply only when current evidence matches the trigger. Stop when counter-evidence appears.", "", support, ""].join("\n");
  if (kind === "prompt") return ["## Evidence-backed behavior constraint", "", `When current evidence matches: ${practice.trigger}`, "", `Follow this learned practice: ${practice.statement}`, `Procedure: ${practice.procedure}`, "If the trigger is absent or counter-evidence appears, do not apply this fragment.", "", support, ""].join("\n");
  if (kind === "workflow") {
    const base = createMinimalTeamPlanDefinition({ policyId: "runtime-supplied", policyVersion: 1, contentHash: "runtime-supplied" }, "Compile an evidence-backed learned Practice into the mission workflow.");
    const practiceStep = {
      clientRef: `evolution-practice-${hash(practice.practiceId).slice(0, 8)}`,
      title: short(practice.statement, 80), objective: `${practice.procedure}\n\nActivation condition: ${practice.trigger}`,
      successCriteria: [`The learned Practice was executed only when its trigger matched.`, `The result preserves the Practice provenance ${practice.practiceId}@${practice.version}.`],
      assignment: { requiredCapabilities: ["plan:plan"] }, outputContract: { schemaRef: "evolution-practice-result-v1" },
      contextPolicy: { includeOriginalRequest: true, requiresMissionBaseline: true },
    };
    const intakeRef = base.initialChange.additions[0]!.clientRef; const planningRef = base.initialChange.additions[1]!.clientRef;
    return JSON.stringify({ schemaVersion: 1, templateId: target, definitionVersion: base.definitionVersion + practice.version,
      plannerAssignment: base.plannerAssignment, amendmentTemplate: base.amendmentTemplate,
      initialChange: { ...base.initialChange, additions: [...base.initialChange.additions, practiceStep], dependencyAdditions: [{ from: { clientRef: intakeRef }, to: { clientRef: practiceStep.clientRef } }, { from: { clientRef: practiceStep.clientRef }, to: { clientRef: planningRef } }] },
    });
  }
  return ["---", `name: ${target}`, `description: Evidence-backed procedure for ${plain(practice.trigger, 120)}`, "---", `# ${target}`, "", "## Activation rule", "", `Use only when current evidence matches: ${practice.trigger}`, "", "## Procedure", "", practice.procedure, "", "## Stop condition", "", "Stop and request review when counter-evidence appears.", "", "## Provenance", "", support, ""].join("\n");
}
function plain(value: string, length: number): string { return short(value.replace(/[\r\n]+/g, " ").replace(/[:#]/g, " "), length); }
function short(value: string, length: number): string { return value.length <= length ? value : `${value.slice(0, length - 1)}...`; }
function hash(value: string): string { return createHash("sha256").update(value, "utf8").digest("hex"); }
