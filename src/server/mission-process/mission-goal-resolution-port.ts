import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import type {
  AgentGoal,
  EvidenceFact,
  EvidenceRef,
  GoalResolutionAttemptResult,
  GoalResolutionPort,
  GoalResolutionProposal,
  GoalResolutionStatus,
} from "../../shared/contracts/agent-engine.js";
import { EvidenceLedger } from "../agent-engine/evidence-ledger.js";
import { isWorkspacePath } from "../policy/path-policy.js";
import type { MissionTicketOutcome } from "./ticket-agent-adapter.js";
import { validateMissionTicketOutcome } from "./ticket-agent-adapter.js";

export class MissionGoalResolutionPort implements GoalResolutionPort<MissionTicketOutcome> {
  constructor(
    private readonly wake: (agentId: string, goalId: string, proposalId: string) => void,
    private readonly agentId: string,
    private readonly now: () => Date = () => new Date(),
    private readonly workspaceRoot?: string,
  ) {}

  async resolve<TStatus extends GoalResolutionStatus>(
    goal: AgentGoal,
    proposal: GoalResolutionProposal<TStatus, MissionTicketOutcome>,
  ): Promise<GoalResolutionAttemptResult<TStatus>> {
    const outcomeError = validateSuccessfulOutcomeCriteria(proposal);
    if (outcomeError) {
      return { settle: true, decision: { accepted: false, disposition: "correctable", reason: outcomeError } };
    }
    if (this.workspaceRoot) {
      const evidenceError = await validateEvidenceFacts(
        this.workspaceRoot,
        this.agentId,
        goal,
        proposal,
      );
      if (evidenceError) {
        return { settle: true, decision: { accepted: false, disposition: "correctable", reason: evidenceError } };
      }
    }
    const validation = validateMissionTicketOutcome(
      goal.spec.outputContract?.schemaRef,
      proposal.status,
      proposal.domainOutcome,
      proposal.humanInputRequest,
    );
    if (!validation.valid) {
      return {
        settle: true,
        decision: { accepted: false, disposition: "correctable", reason: validation.reason },
      };
    }
    this.wake(this.agentId, goal.spec.id, proposal.proposalId);
    return {
      settle: false,
      pending: "retry_later",
      reason: "Mission Process will settle the durable proposal",
      retryAfter: this.now().toISOString(),
    };
  }
}

function validateSuccessfulOutcomeCriteria(proposal: GoalResolutionProposal): string | undefined {
  if (proposal.status !== "completed") return undefined;
  const outcome = isRecord(proposal.domainOutcome) ? proposal.domainOutcome : undefined;
  const disposition = outcome?.disposition;
  if (disposition === "correction_required" || disposition === "plan_change_required") return undefined;
  const incomplete = proposal.criterionResults.filter((item) => item.status !== "satisfied");
  if (!incomplete.length) return undefined;
  return `正常完成 Ticket 时成功标准必须全部满足；未满足或未验证 criterionIndex: ${incomplete.map((item) => item.criterionIndex).join(", ")}。若事实要求纠正上游或修改计划，请提交对应 disposition`;
}

export async function validateEvidenceFacts(
  workspaceRoot: string,
  agentId: string,
  goal: AgentGoal,
  proposal: Pick<GoalResolutionProposal, "evidence" | "criterionResults" | "domainOutcome">,
): Promise<string | undefined> {
  const direct = [
    ...proposal.evidence,
    ...proposal.criterionResults.flatMap((item) => item.evidence),
  ];
  const domain = collectEvidenceRefs(proposal.domainOutcome);
  const all = uniqueEvidenceRefs([...direct, ...domain]);
  if (!all.length) return undefined;

  const ledger = new EvidenceLedger(workspaceRoot);
  const facts = await ledger.getMany(all.map((item) => item.evidenceId));
  const directIds = new Set(direct.map((item) => item.evidenceId));
  const inheritedIds = new Set(goal.spec.evidencePolicy?.inheritedEvidenceIds ?? []);

  for (const ref of all) {
    const fact = facts.get(ref.evidenceId);
    if (!fact) return `证据不存在或不是平台工具生成的事实：${ref.evidenceId}`;
    if (path.resolve(fact.workspaceRoot) !== path.resolve(workspaceRoot)) {
      return `证据不属于当前工作区：${ref.evidenceId}`;
    }
    if (fact.status !== "succeeded") {
      return `证据尚未成功完成：${ref.evidenceId} (${fact.status})`;
    }
    const mustBelongToCurrentGoal = directIds.has(ref.evidenceId) || !inheritedIds.has(ref.evidenceId);
    if (mustBelongToCurrentGoal && (fact.agentId !== agentId || fact.goalId !== goal.spec.id)) {
      return `证据不属于当前 Agent Goal：${ref.evidenceId}`;
    }
    if (mustBelongToCurrentGoal && goal.spec.attemptId && fact.attemptId !== goal.spec.attemptId) {
      return `证据不属于当前 Ticket Attempt：${ref.evidenceId}`;
    }
    const freshnessError = await validateArtifactFreshness(workspaceRoot, fact);
    if (freshnessError) return freshnessError;
  }
  return undefined;
}

async function validateArtifactFreshness(workspaceRoot: string, fact: EvidenceFact): Promise<string | undefined> {
  if (!fact.artifact) return undefined;
  const root = await realpath(workspaceRoot);
  const target = path.resolve(root, fact.artifact.path);
  if (!isWorkspacePath(root, target)) return `证据产物不属于当前工作区：${fact.evidenceId}`;
  let content: Buffer;
  try {
    content = await readFile(target);
  } catch {
    return `证据产物已经不存在：${fact.artifact.path}`;
  }
  const currentHash = createHash("sha256").update(content).digest("hex");
  return currentHash === fact.artifact.sha256
    ? undefined
    : `证据产物在取证后已发生变化：${fact.artifact.path}`;
}

function collectEvidenceRefs(value: unknown): EvidenceRef[] {
  if (Array.isArray(value)) return value.flatMap(collectEvidenceRefs);
  if (!isRecord(value)) return [];
  const current = typeof value.evidenceId === "string" ? [{ evidenceId: value.evidenceId }] : [];
  return [...current, ...Object.values(value).flatMap(collectEvidenceRefs)];
}

function uniqueEvidenceRefs(refs: EvidenceRef[]): EvidenceRef[] {
  return [...new Map(refs.map((item) => [item.evidenceId, item])).values()];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
