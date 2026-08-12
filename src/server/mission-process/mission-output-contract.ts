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
    ? missionCorrectionOutcomeSchema(definition, baseline, eligibleCorrectionTargets)
    : undefined;
  const planChange = definition.permissions?.amendPlan
    || definition.outputContract.schemaRef === "plan-intent-v1"
    || definition.outputContract.schemaRef === "plan-change-set-v3"
    ? undefined
    : missionPlanChangeOutcomeSchema();
  return {
    schemaRef: definition.outputContract.schemaRef,
    evidenceMode: definition.permissions?.settleMission ? "none" : "optional",
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

  if (definition.permissions?.settleMission) {
    const criterionIds = baseline?.criteria.map((criterion) => criterion.criterionId) ?? [];
    return Type.Object({
      disposition,
      missionResolution: Type.Object({
        baselineVersion: baseline
          ? Type.Literal(baseline.version)
          : Type.Integer({ minimum: 1 }),
        summary: Type.String({ minLength: 1 }),
        // The final approver selects the authoritative assurance tickets only.
        // Mission Control materializes evidence and anchor observations from
        // those immutable assurance deliveries after the model proposal passes.
        criterionResults: Type.Array(Type.Object({
          criterionId: stringEnum(criterionIds),
          status: Type.Literal("satisfied"),
          assuranceTicketIds: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
        }, { additionalProperties: false }), {
          minItems: criterionIds.length,
          maxItems: criterionIds.length,
        }),
        residualRisks: Type.Array(Type.String({ minLength: 1 })),
      }, { additionalProperties: false }),
    });
  }

  if (definition.outputContract.schemaRef === "mission-assurance-v1") {
    // A completed assurance ticket is the positive terminal path. Negative or
    // inconclusive judgments use the dedicated correction, plan-change, or
    // human-input tools so the agent's routing decision remains explicit.
    return Type.Object({
      assuranceReport: missionAssuranceReportSchema(
        assignedCriterionIds,
        baseline,
        Type.Literal("satisfied"),
        1,
        true,
      ),
    }, { additionalProperties: false });
  }

  if (definition.outputContract.schemaRef === "plan-intent-v1") {
    const missionCriterionIndex = Type.Integer({
      minimum: 0,
      ...(baseline?.criteria.length ? { maximum: baseline.criteria.length - 1 } : {}),
    });
    const workItem = Type.Object({
      intentRef: Type.String({ minLength: 1, pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]*$" }),
      title: Type.String({ minLength: 1 }),
      objective: Type.String({ minLength: 1 }),
      successCriteria: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
      assignment: Type.Object({
        requiredCapabilities: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
        requiredTools: Type.Optional(Type.Array(workspaceToolName, { uniqueItems: true })),
      }, { additionalProperties: false }),
      outputContract: Type.Object({ schemaRef: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
      dependsOn: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { uniqueItems: true })),
      missionContribution: Type.Optional(Type.Object({
        missionCriterionIndexes: Type.Array(missionCriterionIndex, { minItems: 1, uniqueItems: true }),
      }, { additionalProperties: false })),
      assurance: Type.Optional(Type.Object({
        missionCriterionIndexes: Type.Array(missionCriterionIndex, { minItems: 1, uniqueItems: true }),
      }, { additionalProperties: false })),
      permissions: Type.Optional(Type.Object({
        amendPlan: Type.Optional(Type.Boolean()),
        settleMission: Type.Optional(Type.Boolean()),
      }, { additionalProperties: false })),
    }, { additionalProperties: false });
    return Type.Object({
      disposition,
      summary: Type.Optional(Type.String()),
      intent: Type.Object({
        rationale: Type.String({ minLength: 1 }),
        increments: Type.Array(Type.Object({
          intentRef: Type.String({ minLength: 1, pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]*$" }),
          title: Type.String({ minLength: 1 }),
          objective: Type.String({ minLength: 1 }),
          workItems: Type.Array(workItem, { minItems: 1 }),
        }, { additionalProperties: false }), { minItems: 1 }),
      }, { additionalProperties: false }),
    }, { additionalProperties: false });
  }

  if (definition.outputContract.schemaRef === "plan-change-set-v3") {
    const missionCriterionIndex = Type.Integer({
      minimum: 0,
      ...(baseline?.criteria.length ? { maximum: baseline.criteria.length - 1 } : {}),
    });
    const ticketRef = Type.Union([
      Type.Object({ ticketId: Type.String({ minLength: 1 }) }),
      Type.Object({ clientRef: Type.String({ minLength: 1 }) }),
    ]);
    const additionFields = {
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
      missionContribution: Type.Optional(Type.Object({
        missionCriterionIndexes: Type.Array(missionCriterionIndex, { minItems: 1, uniqueItems: true }),
      }, { additionalProperties: false })),
      assurance: Type.Optional(Type.Object({
        missionCriterionIndexes: Type.Array(missionCriterionIndex, { minItems: 1, uniqueItems: true }),
      }, { additionalProperties: false })),
    };
    const deliveryIncrementRef = Type.Object(
      { incrementId: Type.String({ minLength: 1 }) },
      { additionalProperties: false },
    );
    const addition = Type.Union([
      Type.Object({
        ...additionFields,
        deliveryIncrement: deliveryIncrementRef,
        permissions: Type.Optional(Type.Object({
          amendPlan: Type.Optional(Type.Boolean()),
          settleMission: Type.Optional(Type.Literal(false)),
        })),
      }),
      Type.Object({
        ...additionFields,
        deliveryIncrement: deliveryIncrementRef,
        permissions: Type.Object({
          settleMission: Type.Literal(true),
          amendPlan: Type.Optional(Type.Boolean()),
        }),
      }),
    ]);
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
  baseline: MissionBaseline | undefined,
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
      findings: Type.Array(Type.Object({
        summary: Type.String({ minLength: 1 }),
        details: Type.String({ minLength: 1 }),
        evidence: Type.Array(Type.Object({ evidenceId: Type.String({ minLength: 1 }) }), { minItems: 1 }),
        affectedMissionCriterionIds: Type.Array(
          stringEnum(target.missionCriterionIds ?? []),
          { minItems: 1, uniqueItems: true },
        ),
      }), { minItems: 1 }),
      assuranceReport: missionAssuranceReportSchema(
        target.missionCriterionIds ?? [],
        baseline,
        Type.Union([
          Type.Literal("satisfied"),
          Type.Literal("not_satisfied"),
          Type.Literal("not_verified"),
        ]),
        0,
        false,
      ),
    })));
  }
  return Type.Object({
    targetTicketId: stringEnum(correctionTargets.map((target) => String(target.ticketId))),
    reason: Type.String({ minLength: 1 }),
    correctionMissionCriterionIds: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
  });
}

function missionAssuranceReportSchema(
  assignedCriterionIds: readonly string[],
  baseline: MissionBaseline | undefined,
  verificationStatus: TSchema,
  minimumEvidence: number,
  requireAllCriteria: boolean,
): TSchema {
  const evidenceRef = Type.Object({ evidenceId: Type.String({ minLength: 1 }) });
  const anchorResultSchema = Type.Object({
    anchorIndex: Type.Integer({ minimum: 0 }),
    status: verificationStatus,
    evidence: Type.Array(evidenceRef, { minItems: minimumEvidence }),
    verificationBasis: Type.Object({
      summary: Type.String({ minLength: 1 }),
      evidence: Type.Array(evidenceRef),
    }),
    observations: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
    deviations: Type.Array(Type.String({ minLength: 1 })),
    note: Type.Optional(Type.String()),
  }, {
    description: "逐项对应一个 Mission 验收锚点；实际 anchorIndex 和数量由当前 baseline 的运行时校验确认。",
  });
  const anchorCounts = assignedCriterionIds.map((criterionId) =>
    baseline?.criteria.find((criterion) => criterion.criterionId === criterionId)?.verification.anchors.length ?? 0,
  );
  const normalizedAnchorCounts = anchorCounts.map((count) => Math.max(1, count));
  const minimumAnchorCount = normalizedAnchorCounts.length ? Math.min(...normalizedAnchorCounts) : 1;
  const maximumAnchorCount = normalizedAnchorCounts.length ? Math.max(...normalizedAnchorCounts) : 1;
  const criterionResultSchema = Type.Object({
    criterionId: stringEnum(assignedCriterionIds),
    status: verificationStatus,
    evidence: Type.Array(evidenceRef, { minItems: minimumEvidence }),
    anchorResults: Type.Array(anchorResultSchema, {
      minItems: minimumAnchorCount,
      maxItems: maximumAnchorCount,
    }),
    note: Type.Optional(Type.String()),
  }, {
    description: "只报告当前 Ticket 声明的一个 Mission criterion，不包含总体结论或其他工单标准。",
  });
  const criterionCount = assignedCriterionIds.length;
  return Type.Object({
    baselineVersion: baseline
      ? Type.Literal(baseline.version)
      : Type.Integer({ minimum: 1 }),
    missionCriterionResults: Type.Array(
      criterionResultSchema,
      requireAllCriteria && criterionCount > 0
        ? { minItems: criterionCount, maxItems: criterionCount }
        : { minItems: 1, ...(criterionCount > 0 ? { maxItems: criterionCount } : {}) },
    ),
  }, {
    description: "Mission 验收报告；missionCriterionResults 必须逐项覆盖当前 Ticket 声明的 Mission criteria。顶层 goal_resolution.criterionResults 是另一组工单标准。",
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

function schemaUnion(schemas: readonly TSchema[], fallback: TSchema): TSchema {
  if (schemas.length === 0) return fallback;
  if (schemas.length === 1) return schemas[0]!;
  return Type.Union([...schemas]);
}

function toJsonSchema(schema: TSchema): Record<string, unknown> {
  return JSON.parse(JSON.stringify(schema)) as Record<string, unknown>;
}
