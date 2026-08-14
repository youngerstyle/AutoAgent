import { randomUUID } from "node:crypto";
import type {
  EvaluationObservation, EvolutionEvalCase, EvolutionPrincipalRef, EvolutionSourceRef, VersionedEvolutionRef,
} from "../../shared/contracts/evolution.js";
import { HttpError } from "../errors.js";
import type { EvolutionStore } from "./evolution-store.js";
import type { EvolutionEvaluationStore } from "./evaluation-store.js";
import type { EvolutionEvalSuiteStore } from "./eval-suite-store.js";

export interface EvaluationCaseExecutor {
  readonly isolation: "sandboxed";
  execute(input: {
    case: EvolutionEvalCase;
    variant: "baseline" | "candidate";
    artifactContent?: string;
    runtimeSnapshotRef: string;
  }): Promise<{ observation: EvaluationObservation; evidenceRefs: EvolutionSourceRef[] }>;
}

export class EvolutionEvaluationRunner {
  constructor(
    private readonly workspaceId: string,
    private readonly candidates: EvolutionStore,
    private readonly suites: EvolutionEvalSuiteStore,
    private readonly evaluations: EvolutionEvaluationStore,
    private readonly executor: EvaluationCaseExecutor,
  ) {}

  async run(input: {
    commandId?: string;
    candidateId: string;
    expectedContentHash: string;
    suiteRef: VersionedEvolutionRef;
    baselineRef: VersionedEvolutionRef;
    runtimeSnapshotRef: string;
    evaluatorPrincipal: EvolutionPrincipalRef;
  }) {
    if (this.executor.isolation !== "sandboxed") throw new HttpError(409, "Evaluation executor must be sandboxed", "EVOLUTION_EVALUATION_ISOLATION_REQUIRED");
    const candidate = await this.candidates.get(input.candidateId);
    if (candidate.status !== "ready_for_eval" || candidate.contentHash !== input.expectedContentHash) throw new HttpError(409, "Evaluation candidate is not the suite-bound immutable revision", "EVOLUTION_CONFLICT");
    if (!candidate.evaluationSuiteRefs?.some((ref) => JSON.stringify(ref) === JSON.stringify(input.suiteRef))) throw new HttpError(409, "Evaluation suite is not bound to the candidate revision", "EVOLUTION_CONFLICT");
    const suite = await this.suites.get(input.suiteRef);
    const artifactContent = await this.candidates.artifactContent(candidate.candidateId);
    const caseResults = [];
    for (const evalCase of suite.cases) {
      const baseline = await this.executor.execute({ case: evalCase, variant: "baseline", runtimeSnapshotRef: input.runtimeSnapshotRef });
      const changed = await this.executor.execute({ case: evalCase, variant: "candidate", artifactContent, runtimeSnapshotRef: input.runtimeSnapshotRef });
      caseResults.push({
        caseId: evalCase.caseId, group: evalCase.group, partition: evalCase.partition, baseline: baseline.observation, candidate: changed.observation,
        evidenceRefs: uniqueEvidence([...baseline.evidenceRefs, ...changed.evidenceRefs], this.workspaceId),
      });
    }
    return this.evaluations.recordEvaluation({
      commandId: input.commandId ?? randomUUID(), candidateId: candidate.candidateId, expectedContentHash: candidate.contentHash,
      suiteRef: suite.suiteRef, baselineRef: input.baselineRef, runtimeSnapshotRef: input.runtimeSnapshotRef,
      caseResults, evaluatorPrincipal: input.evaluatorPrincipal,
      grader: { id: "evolution-deterministic-gate", version: "1", type: "deterministic" },
    });
  }
}

function uniqueEvidence(refs: EvolutionSourceRef[], workspaceId: string): EvolutionSourceRef[] {
  if (!refs.length || refs.some((ref) => ref.workspaceId !== workspaceId)) throw new HttpError(400, "Evaluation executor returned invalid evidence", "INVALID_EVOLUTION_EVALUATION");
  return [...new Map(refs.map((ref) => [`${ref.kind}:${ref.ref}`, structuredClone(ref)])).values()];
}
