import { Type, type TSchema } from "typebox";
import type { OutputContract } from "../../shared/contracts/agent-engine.js";
import type { MissionBaseline } from "../../shared/contracts/mission-control.js";
import type { TicketDefinition } from "../../shared/contracts/ticket-engine.js";
import type { CorrectionTargetContext } from "./ticket-agent-adapter.js";

const workspaceToolName = Type.Union([
  Type.Literal("listFiles"),
  Type.Literal("readFile"),
  Type.Literal("readImage"),
  Type.Literal("writeFile"),
  Type.Literal("editFile"),
  Type.Literal("shell"),
  Type.Literal("startService"),
  Type.Literal("pollProcess"),
  Type.Literal("browser"),
]);

export function compileMissionGoalOutputContract(
  definition: TicketDefinition,
  baseline?: MissionBaseline,
  correctionTargets: readonly CorrectionTargetContext[] = [],
): OutputContract {
  const completion = missionCompletionOutcomeSchema(definition, baseline);
  const eligibleCorrectionTargets = definition.outputContract.schemaRef === "mission-assurance-v1"
    ? correctionTargets.filter((target) => (target.missionCriterionIds?.length ?? 0) > 0)
    : correctionTargets;
  const correction = eligibleCorrectionTargets.length
    ? missionCorrectionOutcomeSchema(definition, eligibleCorrectionTargets)
    : undefined;
  const planChange = definition.permissions?.amendPlan
    || definition.outputContract.schemaRef === "plan-change-set-v3"
    ? undefined
    : missionPlanChangeOutcomeSchema();
  return {
    schemaRef: definition.outputContract.schemaRef,
    completionOutcomeSchema: toJsonSchema(completion),
    ...(correction ? { correctionOutcomeSchema: toJsonSchema(correction) } : {}),
    ...(planChange ? { planChangeOutcomeSchema: toJsonSchema(planChange) } : {}),
  };
}

export function missionCompletionOutcomeSchema(
  definition: TicketDefinition,
  baseline?: MissionBaseline,
): TSchema {
  const disposition = Type.Optional(Type.Literal("complete"));
  const evidenceRef = Type.Object({ evidenceId: Type.String({ minLength: 1 }) });
  const assignedCriterionIds = definition.assurance?.missionCriterionIds ?? [];

  if (definition.contextPolicy?.establishesMissionBaseline
    || definition.outputContract.schemaRef === "mission-baseline-v1"
    || definition.outputContract.schemaRef === "mission-baseline-v2") {
    if (definition.outputContract.schemaRef === "mission-baseline-v2") {
      return Type.Object({
        disposition,
        schemaRef: Type.Optional(Type.Literal("mission-baseline-v2")),
        objective: Type.String({ minLength: 1 }),
        criteria: Type.Array(Type.Object({
          text: Type.String({ minLength: 1 }),
          anchors: Type.Array(Type.Object({
            observableOutcome: Type.String({ minLength: 1 }),
            evidenceRequirements: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
          })),
        }), { minItems: 1 }),
        constraints: Type.Array(Type.String()),
        assumptions: Type.Array(Type.String()),
        exclusions: Type.Array(Type.String()),
      });
    }
    return Type.Object({
      disposition,
      schemaRef: Type.Optional(Type.Literal("mission-baseline-v1")),
      baseline: Type.Object({
        objective: Type.String({ minLength: 1 }),
        successCriteria: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
        verificationPlan: Type.Array(Type.Object({
          criterionIndex: Type.Integer({ minimum: 0 }),
          anchors: Type.Array(Type.Object({
            observableOutcome: Type.String({ minLength: 1 }),
            evidenceRequirements: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
          }), { minItems: 1 }),
        }), { minItems: 1 }),
        constraints: Type.Array(Type.String()),
        assumptions: Type.Array(Type.String()),
        exclusions: Type.Array(Type.String()),
      }),
    });
  }

  if (definition.outputContract.schemaRef === "mission-assurance-v1") {
    // A completed assurance ticket is the positive terminal path. Negative or
    // inconclusive judgments use the dedicated correction, plan-change, or
    // human-input tools so the agent's routing decision remains explicit.
    const verificationStatus = Type.Literal("satisfied");
    return Type.Object({
      disposition,
      assuranceReport: Type.Object({
        baselineVersion: baseline
          ? Type.Literal(baseline.version)
          : Type.Integer({ minimum: 1 }),
        criterionResults: Type.Array(Type.Object({
          criterionId: stringEnum(assignedCriterionIds),
          status: verificationStatus,
          evidence: Type.Array(evidenceRef, { minItems: 1 }),
          anchorResults: Type.Array(Type.Object({
            anchorIndex: Type.Integer({ minimum: 0 }),
            status: verificationStatus,
            evidence: Type.Array(evidenceRef),
            verificationBasis: Type.Object({
              summary: Type.String({ minLength: 1 }),
              evidence: Type.Array(evidenceRef),
            }),
            observations: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
            deviations: Type.Array(Type.String({ minLength: 1 })),
            note: Type.Optional(Type.String()),
          }), { minItems: 1 }),
          note: Type.Optional(Type.String()),
        }), { minItems: 1 }),
      }),
    });
  }

  if (definition.permissions?.settleMission) {
    const criterionIds = baseline?.criteria.map((criterion) => criterion.criterionId) ?? [];
    return Type.Object({
      disposition,
      missionResolution: Type.Object({
        baselineVersion: baseline
          ? Type.Literal(baseline.version)
          : Type.Integer({ minimum: 1 }),
        summary: Type.String({ minLength: 1 }),
        criterionResults: Type.Array(Type.Object({
          criterionId: stringEnum(criterionIds),
          status: Type.Literal("satisfied"),
          assuranceTicketIds: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
          evidence: Type.Array(evidenceRef, { minItems: 1 }),
          anchorResults: Type.Array(Type.Object({
            anchorIndex: Type.Integer({ minimum: 0 }),
            status: Type.Literal("satisfied"),
            evidence: Type.Array(evidenceRef, { minItems: 1 }),
            verificationBasis: Type.Object({
              summary: Type.String({ minLength: 1 }),
              evidence: Type.Array(evidenceRef),
            }),
            observations: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
            deviations: Type.Array(Type.String({ minLength: 1 }), { maxItems: 0 }),
            note: Type.Optional(Type.String()),
          }), { minItems: 1 }),
          note: Type.Optional(Type.String()),
        }), { minItems: 1 }),
        residualRisks: Type.Array(Type.String({ minLength: 1 })),
      }),
    });
  }

  if (definition.permissions?.amendPlan
    || definition.outputContract.schemaRef === "plan-change-set-v3") {
    const missionCriterionIndex = Type.Integer({
      minimum: 0,
      ...(baseline?.criteria.length ? { maximum: baseline.criteria.length - 1 } : {}),
    });
    const ticketRef = Type.Union([
      Type.Object({ ticketId: Type.String({ minLength: 1 }) }),
      Type.Object({ clientRef: Type.String({ minLength: 1 }) }),
    ]);
    const addition = Type.Object({
      clientRef: Type.String({ minLength: 1 }),
      title: Type.String({ minLength: 1 }),
      objective: Type.String({ minLength: 1 }),
      successCriteria: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
      assignment: Type.Object({
        principalId: Type.Optional(Type.String({ minLength: 1 })),
        requiredCapabilities: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { minItems: 1 })),
        requiredTools: Type.Array(workspaceToolName, { uniqueItems: true }),
      }),
      outputContract: Type.Object({ schemaRef: Type.String({ minLength: 1 }) }),
      deliveryIncrement: Type.Optional(Type.Object(
        { incrementId: Type.String({ minLength: 1 }) },
        { additionalProperties: false },
      )),
      missionContribution: Type.Optional(Type.Object({
        missionCriterionIndexes: Type.Array(missionCriterionIndex, { minItems: 1, uniqueItems: true }),
      }, { additionalProperties: false })),
      assurance: Type.Optional(Type.Object({
        missionCriterionIndexes: Type.Array(missionCriterionIndex, { minItems: 1, uniqueItems: true }),
      }, { additionalProperties: false })),
      permissions: Type.Optional(Type.Object({
        amendPlan: Type.Optional(Type.Boolean()),
        settleMission: Type.Optional(Type.Boolean()),
      })),
    });
    return Type.Object({
      disposition,
      result: Type.Object({
        summary: Type.Optional(Type.String()),
        deliveryStrategy: Type.Object({
          mode: stringEnum(["single_increment", "multi_increment"]),
          rationale: Type.String({ minLength: 1 }),
          increments: Type.Array(Type.Object({
            incrementId: Type.String({ minLength: 1 }),
            sequence: Type.Integer({ minimum: 1 }),
            title: Type.String({ minLength: 1 }),
            objective: Type.String({ minLength: 1 }),
          })),
        }),
      }),
      change: Type.Object({
        additions: Type.Array(addition, { minItems: 1 }),
        dependencyAdditions: Type.Array(Type.Object({ from: ticketRef, to: ticketRef })),
        failureResolutions: Type.Array(Type.Object({
          failedTicketId: Type.String({ minLength: 1 }),
          resolvedBy: ticketRef,
        })),
        cancelTicketIds: Type.Array(Type.String()),
        requiredTerminalRefs: Type.Array(ticketRef, { minItems: 1 }),
      }),
    });
  }

  return Type.Unknown();
}

export function missionCorrectionOutcomeSchema(
  definition: TicketDefinition,
  correctionTargets: readonly CorrectionTargetContext[],
): TSchema {
  if (definition.outputContract.schemaRef === "mission-assurance-v1") {
    return Type.Union(correctionTargets.map((target) => Type.Object({
      targetTicketId: Type.Literal(String(target.ticketId)),
      reason: Type.String({ minLength: 1 }),
      correctionMissionCriterionIds: Type.Array(
        stringEnum(target.missionCriterionIds ?? []),
        { minItems: 1 },
      ),
    })));
  }
  return Type.Object({
    targetTicketId: stringEnum(correctionTargets.map((target) => String(target.ticketId))),
    reason: Type.String({ minLength: 1 }),
    correctionMissionCriterionIds: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
  });
}

export function missionPlanChangeOutcomeSchema(): TSchema {
  return Type.Object({
    reason: Type.String({ minLength: 1 }),
  });
}

function stringEnum(values: readonly string[]): TSchema {
  const unique = [...new Set(values.filter((value) => value.length > 0))];
  if (unique.length === 0) return Type.String({ minLength: 1 });
  if (unique.length === 1) return Type.Literal(unique[0]!);
  return Type.Unsafe({ type: "string", enum: unique });
}

function toJsonSchema(schema: TSchema): Record<string, unknown> {
  return JSON.parse(JSON.stringify(schema)) as Record<string, unknown>;
}
