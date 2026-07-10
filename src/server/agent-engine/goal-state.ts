import type {
  AgentGoal,
  AgentGoalControlRequest,
  GoalResolutionDecision,
  GoalResolutionProposal,
} from "../../shared/contracts/agent-engine.js";

const TERMINAL = new Set(["completed", "failed", "cancelled"]);

export class AgentGoalTransitionError extends Error {
  constructor(
    public readonly code: "version_conflict" | "goal_terminal" | "invalid_transition",
    message: string,
  ) {
    super(message);
    this.name = "AgentGoalTransitionError";
  }
}

export function controlGoalState(
  goal: AgentGoal,
  input: AgentGoalControlRequest,
  updatedAt: string,
): AgentGoal {
  requireVersion(goal, input.expectedGoalVersion);
  if (TERMINAL.has(goal.status)) throw new AgentGoalTransitionError("goal_terminal", "Goal is terminal");
  if (input.action === "pause") {
    if (goal.status === "paused") return goal;
    return { ...goal, version: goal.version + 1, status: "paused", updatedAt };
  }
  if (input.action === "resume") {
    if (goal.status !== "paused") {
      throw new AgentGoalTransitionError("invalid_transition", "Only paused goals can resume");
    }
    return {
      ...goal,
      version: goal.version + 1,
      status: goal.activeProposalId ? "resolving" : "active",
      updatedAt,
    };
  }
  return {
    ...goal,
    version: goal.version + 1,
    status: "cancelled",
    activeProposalId: undefined,
    updatedAt,
  };
}

export function beginGoalResolution(
  goal: AgentGoal,
  proposal: GoalResolutionProposal,
): AgentGoal {
  requireVersion(goal, proposal.expectedGoalVersion);
  if (TERMINAL.has(goal.status)) throw new AgentGoalTransitionError("goal_terminal", "Goal is terminal");
  if (goal.activeProposalId && goal.activeProposalId !== proposal.proposalId) {
    throw new AgentGoalTransitionError("invalid_transition", "Goal already has an active proposal");
  }
  if (proposal.resolvingGoalVersion !== goal.version + 1) {
    throw new AgentGoalTransitionError("version_conflict", "Proposal resolving version is invalid");
  }
  return {
    ...goal,
    version: proposal.resolvingGoalVersion,
    status: "resolving",
    activeProposalId: proposal.proposalId,
    updatedAt: proposal.createdAt,
  };
}

export function settleGoalState(
  goal: AgentGoal,
  proposal: GoalResolutionProposal,
  decision: GoalResolutionDecision,
  expectedGoalVersion: number,
  updatedAt: string,
): AgentGoal {
  requireVersion(goal, expectedGoalVersion);
  if (goal.activeProposalId !== proposal.proposalId || goal.status !== "resolving") {
    throw new AgentGoalTransitionError("version_conflict", "Proposal is not active");
  }
  if (decision.accepted) {
    if (decision.committedState !== proposal.status) {
      throw new AgentGoalTransitionError("invalid_transition", "Decision does not match proposal status");
    }
    return {
      ...goal,
      version: goal.version + 1,
      status: decision.committedState,
      activeProposalId: undefined,
      updatedAt,
    };
  }
  if (decision.disposition === "host_error") {
    return { ...goal, version: goal.version + 1, status: "paused", updatedAt };
  }
  if (decision.disposition === "stale_claim" || decision.disposition === "workflow_terminal") {
    return {
      ...goal,
      version: goal.version + 1,
      status: "cancelled",
      activeProposalId: undefined,
      updatedAt,
    };
  }
  return {
    ...goal,
    version: goal.version + 1,
    status: "active",
    activeProposalId: undefined,
    updatedAt,
  };
}

function requireVersion(goal: AgentGoal, expected: number): void {
  if (goal.version !== expected) {
    throw new AgentGoalTransitionError(
      "version_conflict",
      `Goal version conflict: expected ${expected}, current ${goal.version}`,
    );
  }
}
