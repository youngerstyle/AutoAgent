import { createHash } from "node:crypto";
import { createId } from "../../shared/ids.js";
import type {
  AuthoritativeEpisodeFacts,
  ExperienceAttribution,
  ExperienceEpisode,
  ExperienceOutcome,
  EvolutionSourceRef,
} from "../../shared/contracts/evolution.js";
import { HttpError } from "../errors.js";
import { redactEvolutionText } from "./secret-redactor.js";

export interface ProjectedExperience {
  episode: ExperienceEpisode;
  attributions: ExperienceAttribution[];
}

export function projectExperience(
  facts: AuthoritativeEpisodeFacts,
  now: () => Date = () => new Date(),
): ProjectedExperience {
  validateFacts(facts);
  const outcome = outcomeFor(facts.ticket.status);
  const sourceRefs = uniqueRefs([
    { kind: "ticket", ref: facts.ticket.ticketId, workspaceId: facts.workspaceId, taskId: facts.taskId, taskRunId: facts.taskRunId },
    ...facts.sourceRefs,
    ...(facts.failures ?? []).flatMap((failure) => failure.sourceRefs),
  ]);
  const identity = {
    workspaceId: facts.workspaceId,
    taskId: facts.taskId,
    taskRunId: facts.taskRunId,
    ticketId: facts.ticket.ticketId,
    attemptId: facts.ticket.attemptId,
    goalId: facts.goal.goalId,
    agentId: facts.goal.agentId,
    outcome,
    sourceRefs,
    startedAt: facts.ticket.startedAt,
    endedAt: facts.ticket.updatedAt,
  };
  const contentHash = hash(canonical(identity));
  const episode: ExperienceEpisode = {
    episodeId: stableId("episode", facts.workspaceId, facts.ticket.ticketId, facts.ticket.attemptId, contentHash),
    ...identity,
    contentHash,
  };
  const timestamp = now().toISOString();
  const attributions = (facts.failures ?? []).map((failure, index): ExperienceAttribution => {
    const symptom = redactEvolutionText(failure.symptom);
    const cause = redactEvolutionText(failure.cause);
    const redactionCount = symptom.count + cause.count;
    return ({
    attributionId: stableId("attribution", episode.episodeId, String(index), failure.component, hash(cause.value)),
    episodeId: episode.episodeId,
    symptom: symptom.value,
    component: failure.component,
    cause: cause.value,
    confidence: 1,
    sourceRefs: uniqueRefs(failure.sourceRefs),
    counterEvidenceRefs: [],
    ...(failure.failedEvolutionAttempts?.length ? { failedEvolutionAttempts: structuredClone(failure.failedEvolutionAttempts) } : {}),
    scope: { workspaceId: facts.workspaceId },
    createdAt: timestamp,
    ...(redactionCount ? { redaction: { count: redactionCount, policyRef: "evolution-secret-redaction/v1" } } : {}),
  }); });
  if (outcome !== "succeeded" && attributions.length === 0) {
    attributions.push({
      attributionId: stableId("attribution", episode.episodeId, "unknown"),
      episodeId: episode.episodeId,
      symptom: `Ticket ended with ${outcome}`,
      component: "unknown",
      cause: "Authoritative facts do not contain a typed failure cause; do not infer a Skill defect.",
      confidence: 0,
      sourceRefs: sourceRefs.filter((ref) => ref.kind === "ticket" || ref.kind === "goal_decision"),
      counterEvidenceRefs: [],
      scope: { workspaceId: facts.workspaceId },
      createdAt: timestamp,
    });
  }
  return { episode, attributions };
}

function validateFacts(facts: AuthoritativeEpisodeFacts): void {
  if (!facts || typeof facts !== "object" || !facts.commandId || !facts.workspaceId || !facts.taskId || !facts.taskRunId) throw invalid("Episode identity is incomplete");
  if (!facts.ticket?.ticketId || !facts.ticket.attemptId || !facts.ticket.startedAt || !facts.ticket.updatedAt) throw invalid("Ticket facts are incomplete");
  if (!facts.goal?.goalId || !facts.goal.agentId) throw invalid("Goal facts are incomplete");
  if (!["completed", "returned", "failed", "dead_letter", "cancelled"].includes(facts.ticket.status)) throw invalid("Experience requires an authoritative terminal Ticket status");
  if (Date.parse(facts.ticket.startedAt) > Date.parse(facts.ticket.updatedAt)) throw invalid("Experience time range is invalid");
  for (const ref of [...facts.sourceRefs, ...(facts.failures ?? []).flatMap((failure) => failure.sourceRefs)]) {
    if (!ref?.ref || ref.workspaceId !== facts.workspaceId) throw invalid("Experience source crossed its workspace boundary");
  }
  for (const failure of facts.failures ?? []) {
    if (!failure.symptom.trim() || !failure.cause.trim() || failure.sourceRefs.length === 0) throw invalid("Typed failure requires symptom, cause, and source evidence");
    for (const attempt of failure.failedEvolutionAttempts ?? []) {
      if (!attempt.telemetryId?.trim() || !attempt.candidateId?.trim() || !attempt.releaseRef?.id?.trim() || !attempt.releaseRef.version?.trim() || !attempt.releaseRef.contentHash?.trim()) throw invalid("Failed evolution attempt reference is invalid");
    }
  }
}

function outcomeFor(status: AuthoritativeEpisodeFacts["ticket"]["status"]): ExperienceOutcome {
  if (status === "completed") return "succeeded";
  if (status === "returned") return "returned";
  if (status === "cancelled") return "cancelled";
  if (status === "failed" || status === "dead_letter") return "failed";
  throw invalid("Experience requires a terminal Ticket status");
}

function uniqueRefs(refs: EvolutionSourceRef[]): EvolutionSourceRef[] {
  const unique = new Map(refs.map((ref) => [`${ref.kind}:${ref.workspaceId}:${ref.ref}`, structuredClone(ref)]));
  return [...unique.values()].sort((left, right) => `${left.kind}:${left.ref}`.localeCompare(`${right.kind}:${right.ref}`));
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value);
}

function hash(value: string): string { return createHash("sha256").update(value, "utf8").digest("hex"); }
function stableId(prefix: string, ...parts: string[]): string { return `${prefix}_${hash(parts.join("\0")).slice(0, 32)}`; }
function invalid(message: string): HttpError { return new HttpError(400, message, "INVALID_EXPERIENCE_FACTS"); }
