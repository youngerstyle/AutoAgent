import { Type, type TSchema } from "typebox";
import type { OutputContract } from "../../shared/contracts/agent-engine.js";
import type { MissionBaseline } from "../../shared/contracts/mission-control.js";
import type { TicketDefinition } from "../../shared/contracts/ticket-engine.js";
import type { CorrectionTargetContext } from "./ticket-agent-adapter.js";

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
    ? missionCorrectionOutcomeSchema(definition, baseline, eligibleCorrectionTargets)
    : undefined;
  const planChange = definition.permissions?.amendPlan
    || definition.outputContract.schemaRef === "plan-intent-v1"
    ? undefined
    : missionPlanChangeOutcomeSchema();
  return {
    schemaRef: definition.outputContract.schemaRef,
    evidenceMode: definition.permissions?.settleMission ? "none" : "optional",
    allowFailedResolution: definition.outputContract.schemaRef !== "mission-assurance-v1"
      && definition.permissions?.settleMission !== true,
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

  if (definition.permissions?.settleMission) {
    return Type.Object({
      summary: Type.String({ minLength: 1 }),
      residualRisks: Type.Array(Type.String({ minLength: 1 })),
    }, { additionalProperties: false });
  }

  if (definition.outputContract.schemaRef === "mission-assurance-v1") {
    const checkCount = assignedCriterionIds.reduce((total, criterionId) => (
      total + Math.max(1, baseline?.criteria.find((criterion) => criterion.criterionId === criterionId)?.verification.anchors.length ?? 0)
    ), 0);
    return Type.Object({
      summary: Type.String({ minLength: 1 }),
      checks: Type.Array(Type.Object({
        verificationBasis: Type.String({ minLength: 1 }),
        observations: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
      }, { additionalProperties: false }), {
        minItems: checkCount,
        maxItems: checkCount,
      }),
    }, {
      additionalProperties: false,
      description: "按当前 Ticket 提供的 orderedCheckList 顺序逐项报告观察；平台负责 criterion、anchor、status 和 evidence 绑定。",
    });
  }

  if (definition.outputContract.schemaRef === "plan-intent-v1") {
    const todo = Type.Object({
      kind: stringEnum(["architecture", "implementation"]),
      title: Type.String({ minLength: 1 }),
      objective: Type.String({ minLength: 1 }),
      successCriteria: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
    }, { additionalProperties: false });
    return Type.Object({
      disposition,
      summary: Type.Optional(Type.String()),
      intent: Type.Object({
        rationale: Type.String({ minLength: 1 }),
        todos: Type.Array(todo, {
          minItems: 1,
          description: "按执行顺序排列的语义工作；连续同 kind 项可由 Plan Compiler 最多四项合并为一个持久执行 Ticket，kind 切换保持独立边界。",
        }),
      }, { additionalProperties: false }),
    }, { additionalProperties: false });
  }

  return Type.Unknown();
}

export function missionCorrectionOutcomeSchema(
  definition: TicketDefinition,
  baseline: MissionBaseline | undefined,
  correctionTargets: readonly CorrectionTargetContext[],
): TSchema {
  if (definition.outputContract.schemaRef === "mission-assurance-v1") {
    return Type.Union(correctionTargets.map((target) => Type.Object({
      targetTicketId: Type.Literal(String(target.ticketId)),
      reason: Type.String({ minLength: 1 }),
      findings: Type.Array(Type.Object({
        summary: Type.String({ minLength: 1 }),
        details: Type.String({ minLength: 1 }),
      }, { additionalProperties: false }), { minItems: 1 }),
    }, { additionalProperties: false })));
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
