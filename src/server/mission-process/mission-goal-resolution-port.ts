import path from "node:path";
import { realpath } from "node:fs/promises";
import type {
  AgentGoal,
  GoalResolutionAttemptResult,
  GoalResolutionPort,
  GoalResolutionProposal,
  GoalResolutionStatus,
} from "../../shared/contracts/agent-engine.js";
import type { MissionTicketOutcome } from "./ticket-agent-adapter.js";
import { validateMissionTicketOutcome } from "./ticket-agent-adapter.js";
import { validateGoalCriterionResults } from "../agent-engine/agent-engine.js";
import { isWorkspacePath } from "../policy/path-policy.js";

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
    const completionError = validateGoalCriterionResults(goal, proposal);
    if (completionError) {
      return { settle: true, decision: { accepted: false, disposition: "correctable", reason: completionError } };
    }
    const outcomeError = validateSuccessfulOutcomeCriteria(proposal);
    if (outcomeError) {
      return { settle: true, decision: { accepted: false, disposition: "correctable", reason: outcomeError } };
    }
    const evidenceError = this.workspaceRoot
      ? validateWorkspaceEvidence(this.workspaceRoot, proposal)
      : undefined;
    if (evidenceError) {
      return { settle: true, decision: { accepted: false, disposition: "correctable", reason: evidenceError } };
    }
    const evidenceFactError = this.workspaceRoot
      ? await validateWorkspaceEvidenceFacts(this.workspaceRoot, proposal)
      : undefined;
    if (evidenceFactError) {
      return { settle: true, decision: { accepted: false, disposition: "correctable", reason: evidenceFactError } };
    }
    const validation = validateMissionTicketOutcome(goal.spec.outputContract?.schemaRef, proposal.status, proposal.domainOutcome, proposal.humanInputRequest);
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

export function validateWorkspaceEvidence(
  workspaceRoot: string,
  proposal: Pick<GoalResolutionProposal, "evidence" | "criterionResults">,
): string | undefined {
  const evidence = [
    ...proposal.evidence,
    ...proposal.criterionResults.flatMap((item) => item.evidence),
  ];
  for (const item of evidence) {
    if (!isFilesystemEvidence(item.kind, item.ref)) continue;
    const absolute = path.isAbsolute(item.ref)
      ? path.resolve(item.ref)
      : path.resolve(workspaceRoot, item.ref);
    if (!isWorkspacePath(workspaceRoot, absolute)) {
      return `交付证据不属于当前项目：${item.ref}。外部文件可以作为参考，但不能证明当前 Ticket 已经交付。`;
    }
  }
  return undefined;
}

export async function validateWorkspaceEvidenceFacts(
  workspaceRoot: string,
  proposal: Pick<GoalResolutionProposal, "evidence" | "criterionResults">,
): Promise<string | undefined> {
  const root = await realpath(workspaceRoot);
  const evidence = [
    ...proposal.evidence,
    ...proposal.criterionResults.flatMap((item) => item.evidence),
  ];
  for (const item of evidence) {
    if (!isFilesystemEvidence(item.kind, item.ref)) continue;
    const absolute = path.isAbsolute(item.ref)
      ? path.resolve(item.ref)
      : path.resolve(workspaceRoot, item.ref);
    let resolved: string;
    try {
      resolved = await realpath(absolute);
    } catch {
      return `交付证据不存在：${item.ref}`;
    }
    if (!isWorkspacePath(root, resolved)) {
      return `交付证据解析后不属于当前项目：${item.ref}`;
    }
  }
  return undefined;
}

function isFilesystemEvidence(kind: string, ref: string): boolean {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(ref)) return false;
  return ["file", "document", "artifact"].includes(kind.trim().toLowerCase());
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
