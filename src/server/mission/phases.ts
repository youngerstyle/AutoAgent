import type { AssignmentType, MissionPhase } from "../../shared/types.js";

export const RUNNING_PHASES: MissionPhase[] = [
  "boss_intake",
  "pm_plan",
  "architect_plan",
  "implementation",
  "qa",
  "boss_acceptance"
];

export function assignmentTypeForPhase(phase: MissionPhase): AssignmentType {
  if (phase === "boss_intake") return "boss_intake";
  if (phase === "pm_plan") return "pm_plan";
  if (phase === "architect_plan") return "architect_plan";
  if (phase === "implementation") return "implementation";
  if (phase === "qa") return "qa";
  if (phase === "boss_acceptance") return "boss_acceptance";
  return "specialist";
}

export function nextPhase(phase: MissionPhase): MissionPhase {
  if (phase === "boss_intake") return "pm_plan";
  if (phase === "pm_plan") return "architect_plan";
  if (phase === "architect_plan") return "implementation";
  if (phase === "implementation") return "qa";
  if (phase === "qa") return "boss_acceptance";
  if (phase === "boss_acceptance") return "completed";
  return phase;
}
