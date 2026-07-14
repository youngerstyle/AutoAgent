import type { PlanDefinition, PlanPolicyRef } from "../../shared/contracts/ticket-engine.js";

export const DEFAULT_PLAN_TEMPLATE_ID = "minimal-team";
export const DEFAULT_PLAN_TEMPLATE_VERSION = 2;

export function createMinimalTeamPlanDefinition(policyRef: PlanPolicyRef, missionObjective: string): PlanDefinition {
  if (!missionObjective.trim()) throw new Error("Mission objective is required");
  return {
    definitionId: DEFAULT_PLAN_TEMPLATE_ID,
    definitionVersion: DEFAULT_PLAN_TEMPLATE_VERSION,
    policyRef,
    plannerAssignment: { requiredCapabilities: ["plan:plan"] },
    initialChange: {
      additions: [
        {
          clientRef: "intake",
          title: "需求接收",
          objective: `理解并处理以下 human 目标，在不要求 human 撰写完整规格的前提下，使用合理默认值形成可供团队计划的目标说明：\n${missionObjective.trim()}`,
          successCriteria: [
            "目标、约束、已知事实和团队采用的默认假设被记录",
            "可逆的不确定项不阻塞交接，必要问题作为可选校准项",
            "只有缺少凭证、授权、不可逆操作确认或真实安全边界等不可替代输入时才阻塞",
          ],
          assignment: { requiredCapabilities: ["mission:intake"] },
          outputContract: { schemaRef: "boss-intake-v1" },
        },
        {
          clientRef: "planning",
          title: "计划拆解",
          objective: "把已接收目标拆成可执行、可验证的 Ticket DAG，并追加到当前 Plan",
          successCriteria: ["DAG 无环", "每个节点有成功标准和输出契约", "交付链包含必要验证"],
          assignment: { requiredCapabilities: ["plan:plan"] },
          outputContract: { schemaRef: "plan-change-set-v3" },
        },
      ],
      dependencyAdditions: [{ from: { clientRef: "intake" }, to: { clientRef: "planning" } }],
      cancelTicketIds: [],
      requiredTerminalRefs: [{ clientRef: "planning" }],
    },
  };
}
