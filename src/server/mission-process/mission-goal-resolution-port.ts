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

export class MissionGoalResolutionPort implements GoalResolutionPort<MissionTicketOutcome> {
  constructor(
    private readonly wake: (agentId: string, goalId: string, proposalId: string) => void,
    private readonly agentId: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async resolve<TStatus extends GoalResolutionStatus>(
    goal: AgentGoal,
    proposal: GoalResolutionProposal<TStatus, MissionTicketOutcome>,
  ): Promise<GoalResolutionAttemptResult<TStatus>> {
    const completionError = validateGoalCriterionResults(goal, proposal);
    if (completionError) {
      return { settle: true, decision: { accepted: false, disposition: "correctable", reason: completionError } };
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
