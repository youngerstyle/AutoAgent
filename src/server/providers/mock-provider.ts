import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AgentModelProvider, AgentModelTurnInput, AgentModelTurnResult } from "./types.js";
import { ProviderError } from "./types.js";

export class MockProvider implements AgentModelProvider {
  name = "mock" as const;

  async runModelTurn(input: AgentModelTurnInput): Promise<AgentModelTurnResult> {
    await failTransientProviderTurnsForTest();
    if (input.tools.some((tool) => tool.name === "staff_project")) {
      const profileIds = staffingProfileIds(input);
      return {
        items: [{
          type: "tool_call",
          callId: `mock-staffing-${input.history.length}`,
          name: "staff_project",
          arguments: {
            status: "staffed",
            members: profileIds.map((profileId) => ({
              profileId,
              responsibility: "按档案能力参与项目交付",
              rationale: "mock 负责人采用保守组队策略，纳入当前人才池成员",
              capabilityCoverage: profileId === "prof_boss"
                ? ["team:staff", "mission:intake", "delivery:accept"]
                : profileId === "prof_pm"
                  ? ["plan:plan"]
                  : profileId === "prof_architect"
                    ? ["architecture:design"]
                    : profileId === "prof_dev"
                      ? ["delivery:implement"]
                      : ["delivery:verify"],
            })),
            recruitmentRequests: [],
          },
        }],
        usage: { inputTokens: 20, outputTokens: 15, totalTokens: 35 },
      };
    }
    await holdConfiguredGoalTurnOnce(input);
    if (!input.tools.some((tool) => tool.name === "goal_resolution")) {
      return {
        items: [{ type: "assistant_message", content: "已收到并处理当前消息。" }],
        usage: { inputTokens: 12, outputTokens: 8, totalTokens: 20 },
      };
    }
    const prompt = modelInputText(input);
    const ticket = currentTicketMetadata(prompt);
    const evidenceIds = toolEvidenceIds(input.history);
    if (ticket.settleMission
      && process.env.AUTOAGENT_MOCK_FORCE_PLAN_CHANGE_ONCE === "1"
      && input.tools.some((tool) => tool.name === "request_goal_plan_change")) {
      const planChange = await requestPlanChangeOnce();
      if (planChange) {
        return {
          items: [{
            type: "tool_call",
            callId: `mock-plan-change-${input.history.length}`,
            name: "request_goal_plan_change",
            arguments: {
              reason: "验收发现当前计划仍缺少一个可独立验证的交付增量，需要由 PM 修订 Plan 后继续执行",
            },
          }],
          usage: { inputTokens: 18, outputTokens: 12, totalTokens: 30 },
        };
      }
    }
    if (isRealDeliveryTicket(ticket) && !mockDeliveryAllowed()) {
      if (input.tools.some((tool) => tool.name === "request_human_input")) {
        return {
          items: [{
            type: "tool_call",
            callId: `mock-delivery-blocked-${input.history.length}`,
            name: "request_human_input",
            arguments: {
              kind: "credential",
              description: "当前项目使用模拟模型服务，无法真实写文件、启动服务或完成浏览器验收。请在模型服务页配置 OpenAI 或 Anthropic 后继续。",
              details: { provider: "mock", requiredFor: ticket.outputSchema ?? "real-delivery" },
            },
          }],
          usage: { inputTokens: 20, outputTokens: 18, totalTokens: 38 },
        };
      }
      return {
        items: [{
          type: "tool_call",
          callId: `mock-delivery-blocked-${input.history.length}`,
          name: "goal_resolution",
          arguments: {
            status: "failed",
            summary: "模拟服务不能执行真实交付",
            evidence: [],
            criterionResults: failedCriteria(prompt),
            residualRisks: ["请为项目成员配置 OpenAI 或 Anthropic Provider 后重新运行；模拟服务只用于协议测试，不会真实写文件、启动服务或完成浏览器验收"],
            domainOutcome: { reason: "真实交付工单不能由模拟服务完成" },
          },
        }],
        usage: { inputTokens: 20, outputTokens: 18, totalTokens: 38 },
      };
    }
    if (ticket.outputSchema === "mission-assurance-v1"
      && evidenceIds.length === 0
      && input.tools.some((tool) => tool.name === "request_human_input")
      && process.env.AUTOAGENT_MOCK_FORCE_MANUAL_TEST_ONCE === "1") {
      const manualTest = await requestManualTestOnce();
      if (manualTest) {
        return {
          items: [{
            type: "tool_call",
            callId: `mock-manual-test-${input.history.length}`,
            name: "request_human_input",
            arguments: manualTest,
          }],
          usage: { inputTokens: 18, outputTokens: 12, totalTokens: 30 },
        };
      }
    }
    if (ticket.outputSchema === "mission-assurance-v1"
      && evidenceIds.length === 0
      && input.tools.some((tool) => tool.name === "listFiles")) {
      return {
        items: [{
          type: "tool_call",
          callId: `mock-observe-${input.history.length}`,
          name: "listFiles",
          arguments: { path: "." },
        }],
        usage: { inputTokens: 16, outputTokens: 8, totalTokens: 24 },
      };
    }
    return {
      items: [{
        type: "tool_call",
        callId: `mock-goal-${input.history.length}`,
        name: "goal_resolution",
        arguments: mockGoalResolution(prompt, evidenceIds),
      }],
      usage: { inputTokens: 20, outputTokens: 15, totalTokens: 35 },
    };
  }
}

function isRealDeliveryTicket(ticket: { outputSchema?: string; settleMission: boolean }): boolean {
  return ticket.outputSchema === "delivery-v1"
    || ticket.outputSchema === "mission-assurance-v1"
    || (ticket.outputSchema === "acceptance-v1" && ticket.settleMission);
}

function mockDeliveryAllowed(): boolean {
  return process.env.NODE_ENV === "test" || process.env.AUTOAGENT_ALLOW_MOCK_DELIVERY === "1";
}

function failedCriteria(instructions: string) {
  const criteria = completedCriteria(instructions);
  const source = criteria.length ? criteria : [{ criterionIndex: 0, status: "satisfied", evidence: [] }];
  return source.map((criterion) => ({ ...criterion, status: "not_verified" as const }));
}

/**
 * Test-only infrastructure fault injection. It models a transient upstream
 * gateway failure at the provider boundary; production providers never read
 * this switch and no business routing depends on it.
 */
async function failTransientProviderTurnsForTest(): Promise<void> {
  const configured = Number(process.env.AUTOAGENT_MOCK_TRANSIENT_FAILURES ?? "0");
  const home = process.env.AUTOAGENT_HOME;
  if (!home || !Number.isInteger(configured) || configured <= 0) return;

  const marker = path.join(home, ".mock-transient-provider-failures.json");
  await mkdir(home, { recursive: true });
  let state: { remaining: number; failedAttempts: number } = {
    remaining: configured,
    failedAttempts: 0,
  };
  try {
    state = JSON.parse(await readFile(marker, "utf8")) as typeof state;
  } catch {
    // The first provider attempt creates the durable fault-injection state.
  }
  if (!Number.isInteger(state.remaining) || state.remaining < 0) {
    state = { remaining: configured, failedAttempts: 0 };
  }
  if (state.remaining <= 0) return;

  const status = state.failedAttempts % 2 === 0 ? 502 : 530;
  state = {
    remaining: state.remaining - 1,
    failedAttempts: state.failedAttempts + 1,
  };
  await writeFile(marker, JSON.stringify(state), "utf8");
  throw new ProviderError(`模拟上游网关暂时失败：${status} status code`, true, `MOCK_GATEWAY_${status}`);
}

/** A durable, once-only manual intervention for deterministic acceptance tests. */
async function requestManualTestOnce(): Promise<Record<string, unknown> | undefined> {
  const home = process.env.AUTOAGENT_HOME;
  if (!home) return undefined;
  const marker = path.join(home, ".mock-manual-test-consumed");
  try {
    await access(marker);
    return undefined;
  } catch {
    // The marker is the durable boundary for this test-only injection.
  }
  await mkdir(home, { recursive: true });
  try {
    await writeFile(marker, new Date().toISOString(), { flag: "wx" });
  } catch {
    return undefined;
  }
  return {
    kind: "manual_test",
    description: "需要人工在浏览器中完成交互验收",
    details: {
      testFile: "index.html",
      steps: ["打开交付物", "完成一次页面交互", "回传实际观察结果"],
    },
  };
}

/**
 * Test-only process boundary: pause one Goal turn after its state has already
 * been persisted, so the recovery script can terminate and restart the real
 * server process. This is deliberately implemented by the mock provider and
 * cannot affect a configured OpenAI or Anthropic run.
 */
async function holdConfiguredGoalTurnOnce(input: AgentModelTurnInput): Promise<void> {
  const delayMs = Number(process.env.AUTOAGENT_MOCK_HOLD_GOAL_ONCE_MS ?? "0");
  const home = process.env.AUTOAGENT_HOME;
  if (!home || !Number.isFinite(delayMs) || delayMs <= 0 || !input.tools.some((tool) => tool.name === "goal_resolution")) return;

  const marker = path.join(home, ".mock-goal-hold-consumed");
  try {
    await access(marker);
    return;
  } catch {
    // The marker is the durable once-only boundary for this process test.
  }
  await mkdir(home, { recursive: true });
  try {
    await writeFile(marker, new Date().toISOString(), { flag: "wx" });
  } catch {
    return;
  }
  await new Promise((resolve) => setTimeout(resolve, delayMs));
}

function staffingProfileIds(input: AgentModelTurnInput): string[] {
  const text = modelInputText(input);
  return [...new Set([...text.matchAll(/"profileId"\s*:\s*"([^"]+)"/g)].map((match) => match[1]!))];
}

function modelInputText(input: AgentModelTurnInput): string {
  return [
    input.instructions,
    ...input.history.flatMap((item) =>
      item.type === "user_message" || item.type === "assistant_message" || item.type === "tool_result"
        ? [item.content]
        : []),
  ].join("\n");
}

function mockGoalResolution(instructions: string, toolEvidence: string[] = []): Record<string, unknown> {
  const ticket = currentTicketMetadata(instructions);
  if (ticket.outputSchema === "mission-baseline-v2" && !ticket.settleMission) {
    return {
      status: "completed",
      summary: "已建立 Mission 权威目标基线",
      evidence: [],
      criterionResults: completedCriteria(instructions),
      residualRisks: [],
      domainOutcome: {
        objective: "完成人类已明确要求的产品目标",
        criteria: [{
          text: "真实交付物可运行并通过独立验收",
          anchors: [{
            observableOutcome: "真实交付物可运行且关键结果可观察",
            evidenceRequirements: ["工具产生的可追溯验收证据"],
          }],
        }],
        constraints: [],
        assumptions: [],
        exclusions: [],
      },
    };
  }
  if (ticket.outputSchema === "mission-baseline-v1" && !ticket.settleMission) {
    return {
      status: "completed",
      summary: "已建立 Mission 权威目标基线",
      evidence: [],
      criterionResults: completedCriteria(instructions),
      residualRisks: [],
      domainOutcome: {
        baseline: {
          objective: "完成 human 已明确要求的产品目标",
          successCriteria: ["真实交付物可运行并通过独立验收"],
          verificationPlan: [{
            criterionIndex: 0,
            anchors: [{ observableOutcome: "真实交付物可运行且关键结果可观察", evidenceRequirements: ["工具产生的可追溯验收证据"] }],
          }],
          constraints: [], assumptions: [], exclusions: [],
        },
      },
    };
  }
  if (ticket.outputSchema === "plan-intent-v1" && !ticket.settleMission) {
    return {
      status: "completed",
      summary: "已形成可编译的交付意图",
      evidence: [],
      criterionResults: completedCriteria(instructions),
      residualRisks: [],
      domainOutcome: {
        intent: {
          rationale: "形成实现、独立验证和最终验收的可验证交付",
          todos: [{
            kind: "implementation",
            title: "开发执行",
            objective: "实现目标并产生真实交付物",
            successCriteria: ["真实交付物可运行并满足正式目标"],
          }],
        },
      },
    };
  }
  if (ticket.outputSchema === "mission-assurance-v1" && !ticket.settleMission) {
    const checkCount = missionAssuranceCheckCount(instructions);
    return {
      status: "completed",
      summary: "已逐项验证 Mission 成功标准",
      residualRisks: [],
      domainOutcome: {
        summary: "已逐项验证 Mission 成功标准",
        checks: Array.from({ length: checkCount }, () => ({
          verificationBasis: "按 Mission baseline 验收锚点判断",
          observations: ["mock 工具证据与验收锚点一致"],
        })),
      },
    };
  }
  if (ticket.settleMission) {
    return {
      status: "completed",
      summary: "已依据 Mission 基线完成最终验收",
      residualRisks: [],
      domainOutcome: {
        summary: "mock acceptance",
        residualRisks: [],
      },
    };
  }
  return {
    status: "completed",
    summary: "模拟 Agent 已完成当前目标",
    evidence: [],
    criterionResults: completedCriteria(instructions),
    residualRisks: [],
    domainOutcome: { summary: "模拟 Agent 已完成当前目标", ok: true },
  };
}

/** A durable, once-only plan revision for the real multi-version acceptance test. */
async function requestPlanChangeOnce(): Promise<boolean> {
  const home = process.env.AUTOAGENT_HOME;
  if (!home) return false;
  const marker = path.join(home, ".mock-plan-change-consumed");
  try {
    await access(marker);
    return false;
  } catch {
    // The marker is the durable once-only boundary for this test-only scenario.
  }
  await mkdir(home, { recursive: true });
  try {
    await writeFile(marker, new Date().toISOString(), { flag: "wx" });
    return true;
  } catch {
    return false;
  }
}

function toolEvidenceIds(history: AgentModelTurnInput["history"]): string[] {
  const ids = new Set<string>();
  for (const item of history) {
    if (item.type !== "tool_result" || item.isError) continue;
    try {
      collectEvidenceIds(JSON.parse(item.content), ids);
    } catch {
      // Mock observations without structured tool output do not constitute evidence.
    }
  }
  return [...ids];
}

function collectEvidenceIds(value: unknown, ids: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) collectEvidenceIds(item, ids);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, item] of Object.entries(value)) {
    if (key === "evidenceId" && typeof item === "string" && item) ids.add(item);
    else collectEvidenceIds(item, ids);
  }
}

function currentTicketMetadata(instructions: string): { outputSchema?: string; settleMission: boolean } {
  const block = [...instructions.matchAll(/\[current-ticket\]([\s\S]*?)\[\/current-ticket\]/g)].at(-1)?.[1] ?? "";
  return {
    outputSchema: block.match(/^output-schema=(.+)$/m)?.[1]?.trim(),
    settleMission: block.match(/^settle-mission=(.+)$/m)?.[1]?.trim() === "true",
  };
}

function completedCriteria(instructions: string) {
  const block = instructions.match(/成功标准：\r?\n((?:- [^\r\n]*(?:\r?\n|$))+)/)?.[1] ?? "";
  const count = block.split(/\r?\n/).filter((line) => line.startsWith("- ")).length;
  return Array.from({ length: count }, (_, criterionIndex) => ({ criterionIndex, status: "satisfied", evidence: [] }));
}

function missionCriterionIds(instructions: string): string[] {
  const context = workContext(instructions);
  return context.assuranceScope?.criterionIds
    ?? context.currentPlan?.missionBaseline?.criteria
    ?.map((criterion) => criterion.criterionId)
    .filter((criterionId): criterionId is string => typeof criterionId === "string" && criterionId.length > 0) ?? [];
}

function missionAssuranceCheckCount(instructions: string): number {
  const context = workContext(instructions);
  return context.assuranceScope?.criteria?.reduce((total, criterion) => (
    total + Math.max(1, criterion.verification?.anchors?.length ?? 0)
  ), 0) ?? missionCriterionIds(instructions).length;
}

interface MockWorkContext {
  assuranceScope?: {
    baselineVersion?: number;
    criterionIds?: string[];
    criteria?: Array<{
      criterionId?: string;
      verification?: { anchors?: unknown[] };
    }>;
    missingCriterionIds?: string[];
  };
  currentPlan?: {
    tickets?: Array<{
      ticketId: string;
      status: string;
      outputContract: { schemaRef: string };
      deliveryIncrement?: {
        incrementId: string;
        sequence: number;
        title: string;
        objective: string;
      };
    }>;
    dependencyEdges?: Array<{ fromTicketId: string; toTicketId: string }>;
    missionBaseline?: {
      version?: number;
      criteria?: Array<{ criterionId?: string }>;
    };
  };
  handoffLineage?: Array<{
    ticketId?: string;
    outputContract?: { schemaRef?: string };
    handoff?: unknown;
  }>;
}

function workContext(instructions: string): MockWorkContext {
  // Mission Control may expose either the full execution view or the exact
  // assurance scope. Parse the structured object itself instead of depending
  // on the surrounding prose, which is intentionally different per contract.
  const starts = ["{\"currentTicket\"", "{\"currentPlan\""].map((marker) => instructions.lastIndexOf(marker));
  const jsonStart = Math.max(...starts);
  if (jsonStart < 0) return {};

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = jsonStart; index < instructions.length; index += 1) {
    const character = instructions[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      continue;
    }
    if (character === "{") depth += 1;
    else if (character === "}") {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(instructions.slice(jsonStart, index + 1)) as MockWorkContext;
        } catch {
          return {};
        }
      }
    }
  }
  return {};
}
