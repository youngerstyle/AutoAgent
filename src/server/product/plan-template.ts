import type { PlanDefinition, PlanPolicyRef } from "../../shared/contracts/ticket-engine.js";

export const DEFAULT_PLAN_TEMPLATE_ID = "minimal-team";
export const DEFAULT_PLAN_TEMPLATE_VERSION = 8;

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
      outputContract: { schemaRef: "plan-intent-v1" },
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
            "只提交正式 Mission 基线，不实施或验收后续 Ticket 的代码、文件和服务交付",
          ],
          assignment: { requiredCapabilities: ["mission:intake"] },
          outputContract: { schemaRef: "mission-baseline-v2" },
          contextPolicy: { includeOriginalRequest: true, establishesMissionBaseline: true },
        },
        {
          clientRef: "planning",
          title: "计划拆解",
          objective: "根据需求接收工单的正式交付，描述可执行、可验证的业务交付意图；由 Plan Compiler 生成当前 Plan 的 Ticket DAG。正式 handoff 是执行权威，human 原始诉求仅作为不可变的来源审计材料。",
          successCriteria: [
            "逐项核对正式 handoff 与 human 原始诉求中的明确目标；若发现无已记录澄清、假设或排除依据的遗漏、缩小或语义降级，先把需求接收工单作为 correction_required 目标，不得继续生成失真的执行计划",
            "新增实际执行工单，形成完成 Mission 所需的真实交付链",
            "不能把启动骨架（intake → planning）当作完整计划",
            "每个新增节点都有成功标准、负责人能力要求和输出契约",
            "新增交付链包含实现、必要验证和最终可验收终点",
            "提交前按目标规模、不确定性、依赖和验收风险审查交付策略；单次增量必须说明为何可可靠交付，否则拆成按依赖自动衔接、各自可验证的多个增量",
            "只提交业务意图，不生成 Ticket ID、依赖边、增量序号或终点引用",
          ],
          assignment: { requiredCapabilities: ["plan:plan"] },
          outputContract: { schemaRef: "plan-intent-v1" },
          contextPolicy: { includeOriginalRequest: true, requiresMissionBaseline: true },
          permissions: { amendPlan: true },
        },
      ],
      dependencyAdditions: [{ from: { clientRef: "intake" }, to: { clientRef: "planning" } }],
      cancelTicketIds: [],
      requiredTerminalRefs: [{ clientRef: "planning" }],
    },
  };
}
