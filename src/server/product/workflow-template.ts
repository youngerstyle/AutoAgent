import type {
  TicketNodeKey,
  WorkflowDefinition,
  WorkflowPolicyRef,
} from "../../shared/contracts/ticket-engine.js";

export const DEFAULT_WORKFLOW_TEMPLATE_ID = "minimal-team";
export const DEFAULT_WORKFLOW_TEMPLATE_VERSION = 1;

export function createMinimalTeamWorkflowDefinition(policyRef: WorkflowPolicyRef): WorkflowDefinition {
  const intake = "intake" as TicketNodeKey;
  const planning = "planning" as TicketNodeKey;
  return {
    definitionId: DEFAULT_WORKFLOW_TEMPLATE_ID,
    definitionVersion: DEFAULT_WORKFLOW_TEMPLATE_VERSION,
    policyRef,
    initialGraph: {
      schemaVersion: 2,
      nodes: [
        {
          key: intake,
          title: "需求接收",
          objective: "理解 human 提供的目标，形成可供团队计划的目标说明",
          successCriteria: ["目标、约束和已知事实被记录", "未知项被标注但不虚构"],
          assignment: { requiredCapabilities: ["mission:intake"] },
          outputContract: { schemaRef: "boss-intake-v1" },
        },
        {
          key: planning,
          parentKey: intake,
          title: "计划拆解",
          objective: "把已接收目标拆成可执行、可验证的 Ticket DAG",
          successCriteria: ["DAG 无环", "每个节点有成功标准和输出契约", "交付链包含必要验证"],
          assignment: { requiredCapabilities: ["workflow:plan"] },
          outputContract: { schemaRef: "ticket-graph-v2" },
        },
      ],
      dependencyEdges: [{ fromKey: intake, toKey: planning }],
    },
    completionPolicy: {
      requiredTerminalKeys: [planning],
      failurePolicy: "require_resolution",
      blockedPolicy: "wait",
    },
  };
}
