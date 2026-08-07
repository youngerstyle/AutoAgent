import { describe, expect, it } from "vitest";
import { buildAgentCatalogProfiles, buildAgentNodes, buildAgentProfiles, buildBlockedPanelCopy, buildHumanFlowPrompt, buildManualTestAction, buildTaskSubmitView, buildTicketAgentMessage, taskControlMode } from "../../src/client/view-model";
import type { AgentProfile, AutoAgentEvent, WorkspaceSnapshot } from "../../src/shared/types";

describe("client view model", () => {
  it("marks the currently running agent as active and gives every member a distinct seat", () => {
    const nodes = buildAgentNodes(snapshot("running"));

    expect(nodes.find((node) => node.role === "dev")?.active).toBe(true);
    expect(new Set(nodes.map((node) => `${node.x}:${node.y}`)).size).toBe(nodes.length);
  });

  it("keeps long agent steps as short canvas bubbles while preserving the full title", () => {
    const longStep = "判断需求是否可执行：不对，刚刚的哪里有问题，我发现这个第二关的关卡家左上角的砖块没有生成，缺了一个角";
    const nodes = buildAgentNodes({
      ...snapshot("running"),
      agents: snapshot("running").agents.map((agent) => agent.id === "wa_dev" ? { ...agent, currentStep: longStep } : agent)
    });
    const dev = nodes.find((node) => node.id === "wa_dev");

    expect(dev).toBeDefined();
    expect(dev?.currentStep).toBe("判断需求是否可执行：不对...");
    expect(dev?.currentStepTitle).toBe(longStep);
    expect(dev!.currentStep!.length).toBeLessThanOrEqual(18);
  });

  it("marks an active waiting Agent as needing a human reply", () => {
    const nodes = buildAgentNodes({
      ...snapshot("running"),
      agents: snapshot("running").agents.map((agent) => agent.id === "wa_dev" ? { ...agent, status: "waiting" as const, currentStep: "已保存进度，等待继续" } : agent)
    });
    const dev = nodes.find((node) => node.id === "wa_dev");

    expect(dev?.active).toBe(false);
    expect(dev?.needsAttention).toBe(true);
    expect(dev?.currentStep).toBe("需要你回复");
    expect(dev?.currentStepTitle).toBe("已保存进度，等待继续");
  });

  it("derives task controls from snapshot status", () => {
    expect(taskControlMode(undefined)).toBe("empty");
    expect(taskControlMode(snapshot("paused"))).toBe("paused");
    expect(taskControlMode(snapshot("blocked"))).toBe("blocked");
    expect(taskControlMode(snapshot("completed"))).toBe("terminal");
  });

  it("shows an immediate pending state while submitting task text", () => {
    expect(buildTaskSubmitView({ mode: "blocked", hasWorkspace: true, hasText: true, submitting: false })).toEqual({
      label: "发送",
      disabled: false
    });
    expect(buildTaskSubmitView({ mode: "blocked", hasWorkspace: true, hasText: true, submitting: true })).toEqual({
      label: "发送中",
      disabled: true
    });
    expect(buildTaskSubmitView({ mode: "empty", hasWorkspace: true, hasText: true, submitting: true })).toEqual({
      label: "启动中",
      disabled: true
    });
    expect(buildTaskSubmitView({ mode: "terminal", hasWorkspace: true, hasText: true, submitting: true })).toEqual({
      label: "重启中",
      disabled: true
    });
  });

  it("treats blocked tickets as the active task state even if the run status is stale", () => {
    const waitingPm = {
      ...snapshot("completed"),
      agents: [
        ...snapshot("completed").agents,
        { id: "wa_pm", workspaceId: "ws_1", profileId: "prof_pm", roleInWorkspace: "pm" as const, agentDir: "pm", status: "waiting" as const, name: "PM" }
      ],
      tickets: [{
        id: "tk_pm",
        workspaceId: "ws_1",
        taskId: "task_1",
        taskRunId: "tr_1",
        type: "pm_plan" as const,
        status: "blocked" as const,
        brief: "计划拆解需要 human 补充",
        expectedArtifact: "执行计划",
        targetAgentId: "wa_pm",
        targetRole: "pm" as const,
        priority: 0,
        attempt: 1,
        blocker: { type: "human_authorization_required" as const, reason: "请确认是否允许执行不可逆发布操作。" },
        createdAt: "now",
        updatedAt: "now"
      }]
    };

    expect(taskControlMode(waitingPm)).toBe("blocked");
    const pmNode = buildAgentNodes(waitingPm).find((node) => node.role === "pm");
    expect(pmNode?.needsAttention).toBe(true);
    expect(pmNode?.active).toBe(false);
    expect(pmNode?.currentStep).toBe("需要你回复");
    expect(buildHumanFlowPrompt(waitingPm)).toMatchObject({
      agentId: "wa_pm",
      waiter: "产品/项目",
      phase: "计划拆解",
      inputLabel: "回复说明"
    });

    const waitingPmWithReply: WorkspaceSnapshot = {
      ...waitingPm,
      humanLoop: {
        latestReply: {
          phase: "pm_plan",
          action: "hold",
          text: "请确认是否放弃原 MVP，改成 FC 坦克98 1:1 复刻。"
        }
      }
    };
    expect(buildHumanFlowPrompt(waitingPmWithReply)).toMatchObject({
      title: "需要补充信息"
    });
    expect(buildHumanFlowPrompt(waitingPmWithReply)?.transcript).toContain("请确认是否放弃原 MVP");
    expect(buildHumanFlowPrompt(waitingPmWithReply)?.transcript).not.toContain("等待 human 补充");
  });

  it("does not present an ordinary blocked Ticket objective as a question for human", () => {
    const blockedPm: WorkspaceSnapshot = {
      ...snapshot("blocked"),
      agents: [
        ...snapshot("blocked").agents,
        { id: "wa_pm", workspaceId: "ws_1", profileId: "prof_pm", roleInWorkspace: "pm" as const, agentDir: "pm", status: "blocked" as const, name: "PM", currentStep: "把目标拆成可执行 Ticket DAG" }
      ],
      tickets: [{
        id: "tk_pm",
        workspaceId: "ws_1",
        taskId: "task_1",
        taskRunId: "tr_1",
        type: "pm_plan" as const,
        status: "blocked" as const,
        brief: "把目标拆成可执行、可验证的 Ticket DAG，并追加到当前 Plan",
        expectedArtifact: "plan-change-set-v3",
        targetAgentId: "wa_pm",
        targetRole: "pm" as const,
        priority: 0,
        attempt: 1,
        createdAt: "now",
        updatedAt: "now"
      }]
    };

    expect(buildHumanFlowPrompt(blockedPm)).toBeUndefined();
    expect(buildAgentNodes(blockedPm).find((node) => node.id === "wa_pm")).toMatchObject({
      needsAttention: false,
      status: "blocked"
    });
  });

  it("marks the blocking Agent and shows the persisted blocker reason", () => {
    const blockedDev: WorkspaceSnapshot = {
      ...snapshot("blocked"),
      tickets: [{
        id: "tk_dev",
        workspaceId: "ws_1",
        taskId: "task_1",
        taskRunId: "tr_1",
        type: "implementation",
        status: "blocked",
        brief: "实现可运行游戏",
        expectedArtifact: "delivery-v1",
        targetAgentId: "wa_dev",
        priority: 0,
        attempt: 1,
        blocker: { type: "external_dependency", reason: "缺少生产环境发布授权" },
        createdAt: "now",
        updatedAt: "now",
      }],
    };

    expect(buildHumanFlowPrompt(blockedDev)).toMatchObject({
      agentId: "wa_dev",
      transcript: expect.stringContaining("缺少生产环境发布授权"),
    });
    expect(buildAgentNodes(blockedDev).find((node) => node.id === "wa_dev")).toMatchObject({
      needsAttention: true,
      currentStep: "需要你回复",
    });
  });

  it("does not turn stale implementation evidence failures into human prompts", () => {
    const blocked = {
      ...snapshot("blocked"),
      activeTaskRun: { ...snapshot("blocked").activeTaskRun!, phase: "boss_acceptance" as const },
      phase: "boss_acceptance" as const,
      recentEvents: [
        event("assignment.completed", "开发已完成开发执行", {
          assignment: { type: "implementation" },
          toolResults: []
        }),
        event("run.blocked", "任务受阻：没有交付物可供验收。", { reason: "没有交付物可供验收。" })
      ]
    };

    expect(buildHumanFlowPrompt(blocked)).toBeUndefined();
    expect(buildAgentNodes(blocked).some((node) => node.needsAttention)).toBe(false);
  });

  it("does not turn clarification requests into human prompts", () => {
    const blocked = {
      ...snapshot("blocked"),
      activeTaskRun: { ...snapshot("blocked").activeTaskRun!, phase: "boss_intake" as const },
      phase: "boss_intake" as const,
      recentEvents: [
        event("provider.completed", "老板的模型调用已完成", {
          providerEvents: [{ type: "text", text: "{\n  \"decision\": \"暂不执行，需澄清\",\n  \"reason\": \"目标缺少交付边界\"\n}" }]
        }, "wa_boss"),
        event("assignment.completed", "老板已完成需求接收", {
          assignment: { type: "boss_intake" },
          result: { decision: "暂不执行，需澄清", action: "check_project_files", reason: "目标缺少交付边界" }
        }, "wa_boss"),
        event("assignment.completed", "开发已完成开发执行", {
          assignment: { type: "implementation" },
          toolResults: []
        }),
        event("run.blocked", "任务受阻：需求不清", { reason: "需求不清" })
      ]
    };

    expect(buildHumanFlowPrompt(blocked)).toBeUndefined();
    expect(buildAgentNodes(blocked).find((node) => node.id === "wa_boss")?.needsAttention).toBe(false);
    expect(buildAgentNodes(blocked).find((node) => node.id === "wa_dev")?.needsAttention).toBe(false);
  });

  it("does not turn stale tool failures into human prompts after a follow-up", () => {
    const blocked = {
      ...snapshot("blocked"),
      activeTaskRun: { ...snapshot("blocked").activeTaskRun!, phase: "pm_plan" as const },
      phase: "pm_plan" as const,
      assignments: [{
        id: "as_pm",
        taskId: "task_1",
        taskRunId: "tr_1",
        ownerWorkspaceAgentId: "wa_pm",
        type: "pm_plan" as const,
        brief: "计划",
        expectedArtifact: "计划",
        status: "blocked" as const
      }],
      agents: [
        ...snapshot("blocked").agents,
        { id: "wa_pm", workspaceId: "ws_1", profileId: "prof_pm", roleInWorkspace: "pm" as const, agentDir: "pm", status: "waiting" as const, name: "PM" }
      ],
      recentEvents: [
        event("assignment.completed", "老板已完成需求接收", {
          assignment: { type: "boss_intake" },
          result: { decision: "暂不执行，需澄清", reason: "旧问题" }
        }, "wa_boss"),
        event("human.followup", "human 已补充说明", { message: "继续" }),
        event("assignment.blocked", "计划拆解受阻：读取文件失败", {
          assignmentId: "as_pm",
          assignmentRun: { workspaceAgentId: "wa_pm" },
          reason: "readFile (package.json) 执行失败：文件不存在"
        }),
        event("run.blocked", "任务受阻：读取文件失败", { reason: "读取文件失败" })
      ]
    };

    expect(buildHumanFlowPrompt(blocked)).toBeUndefined();
    expect(buildAgentNodes(blocked).find((node) => node.id === "wa_pm")?.needsAttention).toBe(false);
  });

  it("does not infer authorization boundaries from legacy event prose", () => {
    const blocked = {
      ...snapshot("blocked"),
      activeTaskRun: { ...snapshot("blocked").activeTaskRun!, phase: "boss_intake" as const },
      phase: "boss_intake" as const,
      recentEvents: [
        event("assignment.blocked", "需求接收受阻：生产部署需要人工授权", {
          assignmentRun: { workspaceAgentId: "wa_boss" },
          reason: "生产部署需要人工授权"
        }, "wa_boss"),
        event("run.blocked", "任务受阻：生产部署需要人工授权", { reason: "生产部署需要人工授权" })
      ]
    };

    expect(buildHumanFlowPrompt(blocked)).toBeUndefined();
    expect(buildAgentNodes(blocked).find((node) => node.id === "wa_boss")?.needsAttention).toBe(false);
  });

  it("does not infer manual testing from legacy event prose", () => {
    const blocked = {
      ...snapshot("blocked"),
      activeTaskRun: { ...snapshot("blocked").activeTaskRun!, phase: "qa" as const },
      phase: "qa" as const,
      recentEvents: [
        event("assignment.blocked", "质量检查需要人工测试：缺少浏览器运行环境", {
          assignmentRun: { workspaceAgentId: "wa_qa" },
          reason: "缺少浏览器运行环境，无法实际执行手动测试（移动、射击、碰撞等交互验证）。请人工打开 index.html 测试。"
        }, "wa_qa"),
        event("run.blocked", "任务暂停：需要人工测试", { reason: "缺少浏览器运行环境" })
      ]
    };

    expect(buildHumanFlowPrompt(blocked)).toBeUndefined();
    expect(buildAgentNodes(blocked).find((node) => node.id === "wa_qa")?.needsAttention).toBe(false);
  });

  it("does not describe QA defect blocks as authorization boundaries", () => {
    const blocked = {
      ...snapshot("blocked"),
      activeTaskRun: { ...snapshot("blocked").activeTaskRun!, phase: "qa" as const },
      phase: "qa" as const,
      tickets: [{
        id: "tk_qa",
        workspaceId: "ws_1",
        taskId: "task_1",
        taskRunId: "tr_1",
        type: "qa" as const,
        status: "blocked" as const,
        brief: "质量检查",
        expectedArtifact: "测试报告",
        targetAgentId: "wa_qa",
        targetRole: "qa" as const,
        priority: 0,
        attempt: 1,
        blocker: { type: "external_dependency" as const, reason: "QA 检查未通过：DEFECT-001" },
        createdAt: "now",
        updatedAt: "now"
      }]
    };

    expect(buildBlockedPanelCopy(blocked)).toMatchObject({
      title: "质量检查已阻塞",
      hint: "当前工单没有被识别为人工授权或人工测试边界。"
    });
  });

  it("turns manual QA blockers into explicit human test actions", () => {
    const ticket = {
      id: "tk_qa",
      workspaceId: "ws_1",
      taskId: "task_1",
      taskRunId: "tr_1",
      type: "qa" as const,
      status: "blocked" as const,
      brief: "质量检查",
      expectedArtifact: "测试报告",
      targetRole: "qa" as const,
      priority: 0,
      attempt: 1,
      blocker: {
        type: "manual_test_required" as const,
        reason: "静态分析通过，但需要人工浏览器测试。",
        details: {
          testFile: "C:\\ws\\index.html",
          steps: ["打开 index.html", "按 R 重启"],
          expectedResult: "全部步骤通过",
        },
      },
      createdAt: "now",
      updatedAt: "now"
    };

    expect(buildManualTestAction(ticket)).toMatchObject({
      summary: "静态分析通过，但需要人工浏览器测试。",
      testFile: "C:\\ws\\index.html",
      steps: ["打开 index.html", "按 R 重启"],
      passMessage: "我已按 QA 给出的人工测试步骤验证通过，可以进入老板验收。",
      failMessage: "人工测试未通过，请开发根据 QA 测试步骤和失败现象继续返工。"
    });
  });

  it("uses boss acceptance wording for plain-text manual test blockers from boss", () => {
    const ticket = {
      id: "tk_boss",
      workspaceId: "ws_1",
      taskId: "task_1",
      taskRunId: "tr_1",
      type: "boss_acceptance" as const,
      status: "blocked" as const,
      brief: "老板验收",
      expectedArtifact: "验收结论",
      targetRole: "boss" as const,
      priority: 0,
      attempt: 1,
      blocker: {
        type: "manual_test_required" as const,
        reason: "代码修复已完成并编译通过，但当前无浏览器交互能力，需要人工执行验收测试。"
      },
      createdAt: "now",
      updatedAt: "now"
    };

    expect(buildManualTestAction(ticket)).toMatchObject({
      summary: "代码修复已完成并编译通过，但当前无浏览器交互能力，需要人工执行验收测试。",
      passMessage: "我已按老板验收要求人工测试通过，可以完成验收。",
      failMessage: "老板验收未通过，请根据人工测试发现的问题打回开发。"
    });

    expect(buildTicketAgentMessage(ticket)).toMatchObject({
      speaker: "老板",
      title: "老板：需要你人工测试",
      meta: "老板验收需要你人工确认结果。"
    });
  });

  it("presents blocked QA manual tests as messages from the QA agent", () => {
    const ticket = {
      id: "tk_qa",
      workspaceId: "ws_1",
      taskId: "task_1",
      taskRunId: "tr_1",
      type: "qa" as const,
      status: "blocked" as const,
      brief: "质量检查",
      expectedArtifact: "测试报告",
      targetRole: "qa" as const,
      priority: 0,
      attempt: 1,
      blocker: { type: "manual_test_required" as const, reason: "{\"status\":\"manual_test_required\"}" },
      createdAt: "now",
      updatedAt: "now"
    };
    const message = {
      id: "msg_qa",
      workspaceId: "ws_1",
      ticketId: "tk_qa",
      toRole: "qa" as const,
      status: "claimed" as const,
      dedupeKey: "d",
      correlationId: "c",
      priority: 0,
      claimedByAgentId: "wa_qa",
      createdAt: "now",
      updatedAt: "now"
    };

    expect(buildTicketAgentMessage(ticket, message)).toMatchObject({
      speaker: "测试",
      title: "测试：需要你人工测试",
      statusLabel: "等你处理",
      meta: "QA 已完成静态检查，等待你测试后回复。",
      workOrderDetail: "工单：质量检查；消息：已领取"
    });
  });

  it("marks the QA node and opens human loop for blocked manual test tickets", () => {
    const blocked = {
      ...snapshot("blocked"),
      phase: "qa" as const,
      activeTaskRun: { ...snapshot("blocked").activeTaskRun!, phase: "qa" as const },
      tickets: [{
        id: "tk_qa",
        workspaceId: "ws_1",
        taskId: "task_1",
        taskRunId: "tr_1",
        type: "qa" as const,
        status: "blocked" as const,
        brief: "质量检查",
        expectedArtifact: "测试报告",
        targetAgentId: "wa_qa",
        targetRole: "qa" as const,
        priority: 0,
        attempt: 1,
        blocker: {
          type: "manual_test_required" as const,
          reason: JSON.stringify({
            status: "manual_test_required",
            report: {
              summary: "静态分析通过，需要人工浏览器测试。",
              test_file: "C:\\ws\\index.html",
              test_steps: ["打开 index.html", "确认可以移动"],
              expected_result: "全部步骤通过"
            }
          })
        },
        createdAt: "now",
        updatedAt: "now"
      }]
    };

    expect(buildAgentNodes(blocked).find((node) => node.id === "wa_qa")?.needsAttention).toBe(true);
    expect(buildHumanFlowPrompt(blocked)).toMatchObject({
      title: "需要人工测试",
      agentId: "wa_qa",
      waiter: "测试",
      phase: "质量检查",
      inputLabel: "回复当前 Agent",
      placeholder: "输入测试结果、发现的问题，或继续向当前 Agent 提问",
      manualTest: {
        summary: "静态分析通过，需要人工浏览器测试。",
        testFile: "C:\\ws\\index.html",
        steps: ["打开 index.html", "确认可以移动"]
      }
    });
    expect(buildHumanFlowPrompt(blocked)?.transcript).toContain("测试:");
  });

  it("does not guess a concrete Agent from a Ticket role or phase", () => {
    const blocked = {
      ...snapshot("blocked"),
      phase: "qa" as const,
      activeTaskRun: { ...snapshot("blocked").activeTaskRun!, phase: "qa" as const },
      tickets: [{
        id: "tk_qa_without_owner",
        workspaceId: "ws_1",
        taskId: "task_1",
        taskRunId: "tr_1",
        type: "qa" as const,
        status: "blocked" as const,
        brief: "质量检查",
        expectedArtifact: "测试报告",
        priority: 0,
        attempt: 1,
        blocker: { type: "manual_test_required" as const, reason: "需要人工测试" },
        createdAt: "now",
        updatedAt: "now"
      }]
    };

    expect(buildHumanFlowPrompt(blocked)?.agentId).toBeUndefined();
    expect(buildHumanFlowPrompt(blocked)?.waiter).toBe("当前工单负责人");
    expect(buildAgentNodes(blocked).find((node) => node.role === "qa")?.needsAttention).toBe(false);
  });

  it("shows the Agent as running after it receives the human test result", () => {
    const blocked = {
      ...snapshot("blocked"),
      phase: "implementation" as const,
      activeTaskRun: { ...snapshot("blocked").activeTaskRun!, phase: "implementation" as const },
      agents: snapshot("blocked").agents.map((agent) => agent.id === "wa_dev"
        ? { ...agent, status: "running" as const, currentStep: "根据人工测试反馈修复地图渲染" }
        : agent),
      tickets: [{
        id: "tk_dev",
        workspaceId: "ws_1",
        taskId: "task_1",
        taskRunId: "tr_1",
        type: "implementation" as const,
        status: "blocked" as const,
        brief: "开发执行",
        expectedArtifact: "可玩版本",
        targetAgentId: "wa_dev",
        targetRole: "dev" as const,
        priority: 0,
        attempt: 1,
        blocker: {
          type: "manual_test_required" as const,
          reason: "请人工试玩并反馈结果"
        },
        createdAt: "now",
        updatedAt: "now"
      }],
      agentThreads: {
        wa_dev: [{
          id: "human-feedback",
          turnId: "turn-feedback",
          taskId: "task_1",
          taskRunId: "tr_1",
          workspaceAgentId: "wa_dev",
          sequence: 1,
          timestamp: "2026-07-21T03:16:40.824Z",
          source: "human" as const,
          kind: "human_message" as const,
          visibility: "chat" as const,
          payload: { content: "人工测试不通过" }
        }, {
          id: "turn-feedback:started",
          turnId: "turn-feedback",
          taskId: "task_1",
          taskRunId: "tr_1",
          workspaceAgentId: "wa_dev",
          sequence: 2,
          timestamp: "2026-07-21T03:16:41.131Z",
          source: "system" as const,
          kind: "system_note" as const,
          visibility: "timeline" as const,
          payload: { status: "running" }
        }]
      }
    };

    const dev = buildAgentNodes(blocked).find((node) => node.id === "wa_dev");
    expect(dev).toMatchObject({ active: true, needsAttention: false, currentStep: "根据人工测试反馈修复地图渲..." });
    expect(buildHumanFlowPrompt(blocked)).toBeUndefined();
  });

  it("does not keep manual test attention after the task is completed", () => {
    const completed = {
      ...snapshot("completed"),
      phase: "completed" as const,
      activeTaskRun: { ...snapshot("completed").activeTaskRun!, status: "completed" as const, phase: "completed" as const },
      tickets: [{
        id: "tk_qa",
        workspaceId: "ws_1",
        taskId: "task_1",
        taskRunId: "tr_1",
        type: "qa" as const,
        status: "completed" as const,
        brief: "质量检查",
        expectedArtifact: "测试报告",
        targetAgentId: "wa_qa",
        targetRole: "qa" as const,
        priority: 0,
        attempt: 1,
        blocker: {
          type: "manual_test_required" as const,
          reason: JSON.stringify({
            status: "manual_test_required",
            report: { summary: "曾经需要人工测试。" }
          })
        },
        result: {
          humanAction: {
            action: "manual_test_passed",
            message: "测试通过。"
          }
        },
        createdAt: "now",
        updatedAt: "now"
      }]
    };

    expect(buildHumanFlowPrompt(completed)).toBeUndefined();
    expect(buildAgentNodes(completed).find((node) => node.id === "wa_qa")?.needsAttention).toBe(false);
  });

  it("does not show stale running agents as active when a different ticket is blocked", () => {
    const blocked = {
      ...snapshot("blocked"),
      phase: "qa" as const,
      activeTaskRun: { ...snapshot("blocked").activeTaskRun!, phase: "qa" as const },
      agents: snapshot("blocked").agents.map((agent) => {
        if (agent.id === "wa_dev") return { ...agent, status: "waiting" as const, currentStep: undefined };
        if (agent.id === "wa_pm") return { ...agent, status: "running" as const, currentStep: "把目标拆成小规模执行计划" };
        return agent;
      }).concat({
        id: "wa_pm",
        workspaceId: "ws_1",
        profileId: "prof_pm",
        roleInWorkspace: "pm" as const,
        agentDir: "pm",
        status: "running" as const,
        name: "PM",
        currentStep: "把目标拆成小规模执行计划"
      }),
      tickets: [{
        id: "tk_qa",
        workspaceId: "ws_1",
        taskId: "task_1",
        taskRunId: "tr_1",
        type: "qa" as const,
        status: "blocked" as const,
        brief: "质量检查",
        expectedArtifact: "测试报告",
        targetAgentId: "wa_qa",
        targetRole: "qa" as const,
        priority: 0,
        attempt: 1,
        blocker: { type: "manual_test_required" as const, reason: "需要人工测试" },
        createdAt: "now",
        updatedAt: "now"
      }]
    };

    const nodes = buildAgentNodes(blocked);

    expect(nodes.find((node) => node.id === "wa_pm")?.active).toBe(false);
    expect(nodes.find((node) => node.id === "wa_qa")?.needsAttention).toBe(true);
  });

  it("projects agents as platform profiles with identity, soul, agent.md, tools, model, and memory", () => {
    const profiles = buildAgentProfiles(snapshot("running"));
    const dev = profiles.find((profile) => profile.role === "dev");

    expect(dev?.identity.title).toBe("开发");
    expect(dev?.soul).toContain("可运行变化");
    expect(dev?.agentMd).toContain("# 使命");
    expect(dev && "loopSteps" in dev).toBe(false);
    expect(dev?.toolGroups.map((group) => group.label)).toEqual(expect.arrayContaining(["列文件", "读文件", "写文件", "执行命令", "启动服务", "查询服务"]));
    expect(dev?.model.providerLabel).toBe("模拟服务");
    expect(dev?.memory.sessionLabel).toBe("项目会话隔离");
  });

  it("projects per-tool configuration instead of only broad permission groups", () => {
    const profiles = buildAgentProfiles({
      ...snapshot("running"),
      agents: snapshot("running").agents.map((agent) => agent.id === "wa_dev" ? {
        ...agent,
        policyOverride: {
          canReadWorkspace: true,
          canWriteWorkspace: true,
          canExecuteCommands: true,
          enabledTools: ["readFile"]
        }
      } : agent)
    });
    const dev = profiles.find((profile) => profile.role === "dev");

    expect(dev?.toolGroups.find((tool) => tool.label === "读文件")).toMatchObject({ enabled: true });
    expect(dev?.toolGroups.find((tool) => tool.label === "执行命令")).toMatchObject({ enabled: false });
  });

  it("uses editable global agent definitions for catalog and project team projections", () => {
    const definitions: AgentProfile[] = [{
      id: "prof_dev",
      name: "全栈工程师",
      role: "dev",
      identity: "负责把任务变成可运行变更",
      soul: "先读上下文，再用证据交付。",
      agentMd: "# 开发能力手册\n- 读代码\n- 验证交付",
      capabilities: ["TypeScript", "验证"],
      defaultProvider: "mock",
      defaultModel: "mock-dev",
      defaultPolicy: { canReadWorkspace: true, canWriteWorkspace: true, canExecuteCommands: true }
    }];

    const catalog = buildAgentCatalogProfiles(definitions);
    const team = buildAgentProfiles(snapshot("running"), definitions);

    expect(catalog[0].identity.title).toBe("全栈工程师");
    expect(team.find((profile) => profile.role === "dev")?.soul).toBe("先读上下文，再用证据交付。");
    expect(team.find((profile) => profile.role === "dev")?.agentMd).toContain("开发能力手册");
    expect(team.find((profile) => profile.role === "dev") && "loopSteps" in team.find((profile) => profile.role === "dev")!).toBe(false);
  });
});

function snapshot(status: WorkspaceSnapshot["status"]): WorkspaceSnapshot {
  return {
    workspace: { id: "ws_1", name: "Workspace", rootPath: "C:/ws", policyProfile: "production", createdAt: "now" },
    activeTask: { id: "task_1", workspaceId: "ws_1", title: "Task", goal: "Goal", status, createdBy: "user", activeTaskRunId: "tr_1" },
    activeTaskRun: { id: "tr_1", taskId: "task_1", workspaceId: "ws_1", status, phase: status === "paused" ? "paused" : "implementation", startedAt: "now" },
    agents: [
      { id: "wa_boss", workspaceId: "ws_1", profileId: "prof_boss", roleInWorkspace: "boss", agentDir: "boss", status: "waiting", name: "Boss" },
      { id: "wa_dev", workspaceId: "ws_1", profileId: "prof_dev", roleInWorkspace: "dev", agentDir: "dev", status: "running", name: "Dev", currentStep: "Editing" },
      { id: "wa_qa", workspaceId: "ws_1", profileId: "prof_qa", roleInWorkspace: "qa", agentDir: "qa", status: "waiting", name: "QA" }
    ],
    assignments: [],
    recentEvents: [],
    phase: status === "paused" ? "paused" : "implementation",
    status
  };
}

function event(type: AutoAgentEvent["type"], summary: string, payload: Record<string, unknown>, actorId?: string): AutoAgentEvent {
  return {
    id: `evt_${type}`,
    workspaceId: "ws_1",
    taskId: "task_1",
    taskRunId: "tr_1",
    actorId,
    type,
    summary,
    payload,
    timestamp: "now"
  };
}
