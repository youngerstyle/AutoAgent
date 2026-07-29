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
    const outcomeError = validateSuccessfulOutcomeCriteria(goal, proposal);
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
    this.wake(this.agentId, goal.spec.id, proposal.proposalId);
    return {
      settle: false,
      pending: "retry_later",
      reason: "Mission Process will settle the durable proposal",
      retryAfter: this.now().toISOString(),
    };
  }
}

function validateSuccessfulOutcomeCriteria(
  goal: AgentGoal,
  proposal: GoalResolutionProposal,
): string | undefined {
  if (proposal.status !== "completed") return undefined;
  const outcome = isRecord(proposal.domainOutcome) ? proposal.domainOutcome : undefined;
  const disposition = outcome?.disposition;
  if (disposition === "correction_required" || disposition === "plan_change_required") return undefined;
  const nestedResolution = isRecord(outcome?.missionResolution) ? outcome.missionResolution : undefined;
  if (nestedResolution?.disposition === "correction_required" || nestedResolution?.disposition === "plan_change_required") {
    return "disposition、targetTicketId 和 reason 必须直接放在 domainOutcome 顶层；missionResolution 只用于全部验收通过后的最终结算";
  }
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
  const inheritedIds = new Set(goal.spec.evidencePolicy?.inheritedEvidenceIds ?? []);

  const verifiedFacts: Array<{ ref: EvidenceRef; fact: EvidenceFact }> = [];
  for (const ref of all) {
    const fact = facts.get(ref.evidenceId);
    if (!fact) return `证据不存在或不是平台工具生成的事实：${ref.evidenceId}`;
    if (path.resolve(fact.workspaceRoot) !== path.resolve(workspaceRoot)) {
      return `证据不属于当前工作区：${ref.evidenceId}`;
    }
    if (fact.status !== "succeeded") {
      return `证据尚未成功完成：${ref.evidenceId} (${fact.status})`;
    }
    const mustBelongToCurrentGoal = !inheritedIds.has(ref.evidenceId);
    if (mustBelongToCurrentGoal && (fact.agentId !== agentId || fact.goalId !== goal.spec.id)) {
      return `证据不属于当前 Agent Goal：${ref.evidenceId}`;
    }
    verifiedFacts.push({ ref, fact });
  }

  for (const { fact } of latestArtifactEvidence(verifiedFacts)) {
    const freshnessError = await validateArtifactFreshness(workspaceRoot, fact);
    if (freshnessError) return freshnessError;
  }
  return undefined;
}

function latestArtifactEvidence(
  facts: ReadonlyArray<{ ref: EvidenceRef; fact: EvidenceFact }>,
): Array<{ ref: EvidenceRef; fact: EvidenceFact }> {
  const nonArtifacts = facts.filter(({ fact }) => !fact.artifact);
  const latestByPath = new Map<string, { ref: EvidenceRef; fact: EvidenceFact }>();
  for (const item of facts) {
    if (!item.fact.artifact) continue;
    const key = path.normalize(item.fact.artifact.path).toLowerCase();
    const current = latestByPath.get(key);
    if (!current || compareEvidenceOrder(item.fact, current.fact) > 0) {
      latestByPath.set(key, item);
    }
  }
  return [...nonArtifacts, ...latestByPath.values()];
}

function compareEvidenceOrder(left: EvidenceFact, right: EvidenceFact): number {
  const timestamp = left.createdAt.localeCompare(right.createdAt);
  return timestamp || left.evidenceId.localeCompare(right.evidenceId);
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
    : [
      `证据产物在取证后已发生变化：${fact.artifact.path}。`,
      "请在完成最后一次修改后，用 readFile 或 readImage 重新读取该文件，",
      "并在下一次提交中引用新工具结果的 evidenceId；Shell 哈希或旧截图不能替代当前文件证据。",
    ].join("");
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
