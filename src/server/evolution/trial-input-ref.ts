import type { EvolutionSourceRef } from "../../shared/contracts/evolution.js";

/** A paired trial may freeze any locally resolvable authoritative platform fact, not only tool Evidence Ledger rows. */
export function validLocalTrialInputRef(ref: EvolutionSourceRef | undefined, workspaceId: string): boolean {
  if (!ref?.ref?.trim() || ref.workspaceId !== workspaceId) return false;
  if (ref.kind === "ticket") return Boolean(ref.taskId && ref.taskRunId);
  if (["trace", "goal_proposal", "goal_decision", "human_feedback"].includes(ref.kind)) return Boolean(ref.agentId);
  return ref.kind === "evidence" || ref.kind === "mission";
}
