import type { TicketType } from "../../shared/types.js";

export const TICKET_GRAPH_CONTRACT_NAME = "TicketGraphContract v1";

export interface TicketGraphContractViolation {
  reason: string;
}

interface PlannedTicketNode {
  key: string;
  type: TicketType;
  dependsOn: string[];
  status: string;
}

export function plannedTicketItems(result: unknown): Array<Record<string, unknown>> {
  if (!isRecord(result)) return [];
  const direct = firstRecordArray(result.ticketGraph, result.tickets, result.workItems, result.work_items);
  if (direct.length > 0) return direct;
  if (isRecord(result.ticketGraph) && Array.isArray(result.ticketGraph.tickets)) {
    return result.ticketGraph.tickets.filter(isRecord);
  }
  if (isRecord(result.flow) && Array.isArray(result.flow.tickets)) {
    return result.flow.tickets.filter(isRecord);
  }
  return [];
}

export function validatePlannedTicketGraph(items: Array<Record<string, unknown>>): TicketGraphContractViolation | undefined {
  const nodes: PlannedTicketNode[] = [];
  const keyToNode = new Map<string, PlannedTicketNode>();
  for (const [index, item] of items.entries()) {
    const type = planItemTicketType(item);
    if (!type) {
      return { reason: `PM ticketGraph 包含未知工单类型：${String(item.type ?? item.ticket_type ?? "")}` };
    }
    const key = planItemPrimaryKey(item, type, index);
    const node: PlannedTicketNode = {
      key,
      type,
      dependsOn: [],
      status: lower(item.status)
    };
    nodes.push(node);
    for (const alias of planItemAliases(item, type, index)) keyToNode.set(alias, node);
  }

  const completedNode = nodes.find((node) => ["done", "completed", "complete"].includes(node.status));
  if (completedNode) {
    return { reason: "PM ticketGraph 只能描述待执行工单，不能把已完成记录写成新工单" };
  }

  const humanActionNode = nodes.find((node) => node.type === "human_action");
  if (humanActionNode) {
    return { reason: "PM 根规划 ticketGraph 不能包含 human_action；人工动作是运行时边界，只能由 Agent 在执行、验收或授权受阻时返回结构化状态触发" };
  }

  for (const [index, item] of items.entries()) {
    const explicitDependencies = planItemDependencyKeys(item);
    if (!explicitDependencies) {
      nodes[index].dependsOn = index === 0 ? [] : [nodes[index - 1].key];
      continue;
    }
    const unknown = explicitDependencies.find((key) => !keyToNode.has(key));
    if (unknown) return { reason: `PM ticketGraph 依赖了不存在的工单：${unknown}` };
    nodes[index].dependsOn = explicitDependencies;
  }

  if (!nodes.some((node) => node.type === "boss_acceptance")) {
    return { reason: "PM ticketGraph 缺少老板验收工单，不能形成完整交付闭环" };
  }

  const outgoing = new Map<string, PlannedTicketNode[]>();
  for (const node of nodes) {
    for (const dependency of node.dependsOn) {
      const upstream = keyToNode.get(dependency);
      if (!upstream) continue;
      const successors = outgoing.get(upstream.key) ?? [];
      successors.push(node);
      outgoing.set(upstream.key, successors);
    }
  }

  const leaf = nodes.find((node) => (outgoing.get(node.key) ?? []).length === 0 && node.type !== "boss_acceptance");
  if (leaf) {
    return { reason: "PM ticketGraph 的叶子工单必须是老板验收，不能在开发、测试或中间工单后直接结束" };
  }

  for (const implementation of nodes.filter((node) => node.type === "implementation" || node.type === "rework" || node.type === "specialist")) {
    const reachable = reachablePlannedNodes(implementation, outgoing);
    const qaNodes = reachable.filter((node) => node.type === "qa");
    if (qaNodes.length === 0) {
      return { reason: "PM ticketGraph 中开发/返工/专家工单后必须进入 QA 质量检查" };
    }
    const qaReachesAcceptance = qaNodes.some((qa) => reachablePlannedNodes(qa, outgoing).some((node) => node.type === "boss_acceptance"));
    if (!qaReachesAcceptance) {
      return { reason: "PM ticketGraph 中 QA 质量检查后必须进入老板验收" };
    }
  }

  return undefined;
}

export function planItemPrimaryKey(item: Record<string, unknown>, type: TicketType, index: number): string {
  return stringValue(item.key) ?? stringValue(item.id) ?? stringValue(item.ticketId) ?? stringValue(item.ticket_id) ?? `${type}_${index}`;
}

export function planItemAliases(item: Record<string, unknown>, type: TicketType, index: number): string[] {
  return [
    planItemPrimaryKey(item, type, index),
    stringValue(item.key),
    stringValue(item.id),
    stringValue(item.ticketId),
    stringValue(item.ticket_id),
    `${type}_${index}`
  ].filter((value, valueIndex, values): value is string => Boolean(value) && values.indexOf(value) === valueIndex);
}

export function planItemDependencyKeys(item: Record<string, unknown>): string[] | undefined {
  const raw = Array.isArray(item.dependsOn)
    ? item.dependsOn
    : Array.isArray(item.depends_on)
      ? item.depends_on
      : Array.isArray(item.dependsOnTicketIds)
        ? item.dependsOnTicketIds
        : undefined;
  if (!raw) return undefined;
  return raw.filter((value): value is string => typeof value === "string" && value.trim().length > 0);
}

export function planItemTicketType(item: Record<string, unknown>): TicketType | undefined {
  return ticketTypeFromValue(item.type ?? item.ticket_type);
}

export function ticketTypeFromValue(value: unknown): TicketType | undefined {
  const text = typeof value === "string" ? value : "";
  const allowed = new Set<TicketType>(["boss_intake", "pm_plan", "architect_plan", "implementation", "qa", "boss_acceptance", "specialist", "rework", "human_action"]);
  if (allowed.has(text as TicketType)) return text as TicketType;
  if (text === "dev" || text === "development") return "implementation";
  if (text === "architect" || text === "architecture") return "architect_plan";
  if (text === "acceptance") return "boss_acceptance";
  return undefined;
}

function reachablePlannedNodes(start: PlannedTicketNode, outgoing: Map<string, PlannedTicketNode[]>): PlannedTicketNode[] {
  const result: PlannedTicketNode[] = [];
  const seen = new Set<string>([start.key]);
  const queue = [...(outgoing.get(start.key) ?? [])];
  while (queue.length > 0) {
    const node = queue.shift();
    if (!node || seen.has(node.key)) continue;
    seen.add(node.key);
    result.push(node);
    queue.push(...(outgoing.get(node.key) ?? []));
  }
  return result;
}

function firstRecordArray(...values: unknown[]): Array<Record<string, unknown>> {
  for (const value of values) {
    if (Array.isArray(value)) return value.filter(isRecord);
  }
  return [];
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function lower(value: unknown): string {
  return typeof value === "string" ? value.toLowerCase() : "";
}
