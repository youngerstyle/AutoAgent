import path from "node:path";
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
    const evidenceError = this.workspaceRoot
      ? validateWorkspaceEvidence(this.workspaceRoot, proposal)
      : undefined;
    if (evidenceError) {
      return { settle: true, decision: { accepted: false, disposition: "correctable", reason: evidenceError } };
    }
    const validation = validateMissionTicketOutcome(goal.spec.outputContract?.schemaRef, proposal.status, proposal.domainOutcome);
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

function isFilesystemEvidence(kind: string, ref: string): boolean {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(ref)) return false;
  return ["tool", "file", "document", "artifact"].includes(kind.trim().toLowerCase());
}
