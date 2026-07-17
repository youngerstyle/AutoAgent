import type { PlanDefinition, PlanPolicyRef } from "../../shared/contracts/ticket-engine.js";

export const DEFAULT_PLAN_TEMPLATE_ID = "minimal-team";
export const DEFAULT_PLAN_TEMPLATE_VERSION = 4;

export function createMinimalTeamPlanDefinition(policyRef: PlanPolicyRef, originalRequest: string): PlanDefinition {
  if (!originalRequest.trim()) throw new Error("Mission original request is required");
  return {
    definitionId: DEFAULT_PLAN_TEMPLATE_ID,
    definitionVersion: DEFAULT_PLAN_TEMPLATE_VERSION,
    policyRef,
    plannerAssignment: { requiredCapabilities: ["plan:plan"] },
    amendmentTemplate: {
      title: "计划修订",
      successCriteria: ["核对结构变更原因和证据", "追加完成 Mission 所需的新工单和依赖", "保持 Plan 无环且具有可验证终点"],
      outputContract: { schemaRef: "plan-change-set-v3" },
    },
    initialChange: {
      additions: [
        {
          clientRef: "intake",
          title: "需求接收",
          objective: "理解 human 在当前 Agent thread 中提交的原始诉求；在不要求 human 撰写完整规格的前提下，使用合理默认值形成可供团队共同执行的正式目标说明。原始诉求只用于需求接收和审计，正式 handoff 才是后续工作的权威需求基线。",
          successCriteria: [
            "目标、约束、已知事实和团队采用的默认假设被记录",
            "可逆的不确定项不阻塞交接，必要问题作为可选校准项",
            "只有缺少凭证、授权、不可逆操作确认或真实安全边界等不可替代输入时才阻塞",
          ],
          assignment: { requiredCapabilities: ["mission:intake"] },
          outputContract: { schemaRef: "boss-intake-v1" },
          contextPolicy: { includeOriginalRequest: true },
        },
        {
          clientRef: "planning",
          title: "计划拆解",
          objective: "根据需求接收工单的正式交付，把已对齐目标拆成可执行、可验证的 Ticket DAG，并追加到当前 Plan。不得重新使用 human 原始诉求覆盖正式 handoff。",
          successCriteria: [
            "新增实际执行工单，形成完成 Mission 所需的真实交付链",
            "不能把启动骨架（intake → planning）当作完整计划",
            "每个新增节点都有成功标准、负责人能力要求和输出契约",
            "新增交付链包含实现、必要验证和最终可验收终点",
            "DAG 无环，requiredTerminalRefs 指向新增交付链的真实终点",
          ],
          assignment: { requiredCapabilities: ["plan:plan"] },
          outputContract: { schemaRef: "plan-change-set-v3" },
          permissions: { amendPlan: true },
        },
      ],
      dependencyAdditions: [{ from: { clientRef: "intake" }, to: { clientRef: "planning" } }],
      cancelTicketIds: [],
      requiredTerminalRefs: [{ clientRef: "planning" }],
    },
  };
}
