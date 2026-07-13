import { useEffect, useMemo, useRef, useState } from "react";
import type { AgentPolicy, AgentProfile, AutoAgentEvent, LoopDebugEntry, LoopDebugLog, ModelConfig, ProviderName, Workspace, WorkspaceSnapshot, WorkspaceToolName } from "../shared/types";
import { capabilityLabels, displayText, phaseLabel, roleLabel, statusLabel } from "../shared/labels";
import { permissionPatchForTool, TOOL_CATALOG, toolsForPolicy } from "../shared/tool-catalog";
import {
  createModelConfig,
  createWorkspace,
  deleteWorkspace,
  getLoopDebugLog,
  getSnapshot,
  listAgentProfiles,
  listAgents,
  listModelConfigs,
  listWorkspaces,
  pauseTask,
  resumeTask,
  sendAgentMessage,
  sendTaskFollowup,
  setDefaultModelConfig,
  startTask,
  stopTask,
  updateAgent,
  updateAgentProfile,
  updateModelConfig,
  type WorkspaceAgentConfig
} from "./api";
import { agentProfileCardSummary } from "./agent-profile-card";
import { applyModelSelection, modelSelectionOptions, modelSelectionValue } from "./model-selection";
import { buildAgentCatalogProfiles, buildAgentNodes, buildAgentProfiles, buildBlockedPanelCopy, buildHumanFlowPrompt, buildManualTestAction, buildTaskSubmitView, taskControlMode, type AgentProfileView } from "./view-model";
import { buildEventTimelineGroups, buildEventTimelineItem, buildVisibleTimelineEvents, type EventTimelineGroup } from "./event-view-model";
import { buildAgentMessageView } from "./agent-message";
import { appendCurrentAgentPrompt, buildAgentThreadBubbles, type AgentThreadBubble } from "./agent-thread";
import { buildTicketInspectorItems, type TicketInspectorItem } from "./ticket-inspector";

const AGENT_PANEL_MIN_HEIGHT = 180;
const AGENT_PANEL_MAX_HEIGHT = 560;
const AGENT_PANEL_DEFAULT_HEIGHT = 300;
const WORKSPACE_PANEL_MIN_WIDTH = 220;
const WORKSPACE_PANEL_MAX_WIDTH = 440;
const TASK_PANEL_MIN_WIDTH = 220;
const TASK_PANEL_MAX_WIDTH = 420;
const EVENT_PANEL_MIN_WIDTH = 260;
const EVENT_PANEL_MAX_WIDTH = 520;
const LIVE_EVENT_BUFFER_LIMIT = 80;

type RunLayoutWidths = {
  workspace: number;
  task: number;
  events: number;
};

type RealProviderName = Exclude<ProviderName, "mock">;
type ModelConfigDraft = Pick<ModelConfig, "name" | "model"> & {
  provider: RealProviderName;
  apiKey: string;
  baseUrl: string;
};

type DeleteWorkspaceDialogState = {
  workspace: Workspace;
  deleteLocalFolder: boolean;
  busy: boolean;
};

export function App() {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [selectedId, setSelectedId] = useState<string>("");
  const [snapshot, setSnapshot] = useState<WorkspaceSnapshot>();
  const [events, setEvents] = useState<AutoAgentEvent[]>([]);
  const [goal, setGoal] = useState("");
  const [agentMessage, setAgentMessage] = useState("");
  const [workspaceForm, setWorkspaceForm] = useState({ name: "演示项目", rootPath: "", policyProfile: "production" as Workspace["policyProfile"] });
  const [selectedAgentId, setSelectedAgentId] = useState<string>("");
  const [selectedProfileId, setSelectedProfileId] = useState<string>("");
  const [view, setView] = useState<"run" | "studio" | "team" | "providers">("run");
  const [rightPanelView, setRightPanelView] = useState<"events" | "tickets">("events");
  const [rawTicketDialog, setRawTicketDialog] = useState<TicketInspectorItem>();
  const [loopDebugLog, setLoopDebugLog] = useState<LoopDebugLog>({ entries: [] });
  const [agents, setAgents] = useState<WorkspaceAgentConfig[]>([]);
  const [agentProfiles, setAgentProfiles] = useState<AgentProfile[]>([]);
  const [modelConfigs, setModelConfigs] = useState<ModelConfig[]>([]);
  const [modelConfigDraft, setModelConfigDraft] = useState<ModelConfigDraft>({
    name: "",
    provider: "openai",
    model: "",
    apiKey: "",
    baseUrl: ""
  });
  const [error, setError] = useState("");
  const [taskSubmitting, setTaskSubmitting] = useState(false);
  const [agentMessageSubmitting, setAgentMessageSubmitting] = useState(false);
  const [deleteDialog, setDeleteDialog] = useState<DeleteWorkspaceDialogState>();
  const [agentPanelHeight, setAgentPanelHeight] = useState(() => initialAgentPanelHeight());
  const [runLayoutWidths, setRunLayoutWidths] = useState<RunLayoutWidths>(() => initialRunLayoutWidths());
  const rightPanelRef = useRef<HTMLElement | null>(null);
  const nodes = useMemo(() => buildAgentNodes(snapshot), [snapshot]);
  const profiles = useMemo(() => buildAgentProfiles(snapshot, agentProfiles), [snapshot, agentProfiles]);
  const catalogProfiles = useMemo(() => buildAgentCatalogProfiles(agentProfiles), [agentProfiles]);
  const mode = taskControlMode(snapshot);
  const humanFlowPrompt = useMemo(() => buildHumanFlowPrompt(snapshot), [snapshot]);
  const ticketItems = useMemo(() => buildTicketInspectorItems(snapshot?.tickets), [snapshot?.tickets]);
  const visibleEvents = useMemo(() => buildVisibleTimelineEvents(events), [events]);
  const eventGroups = useMemo(() => buildEventTimelineGroups(visibleEvents, snapshot?.agents ?? []), [snapshot?.agents, visibleEvents]);
  const rightPanelScrollKey = useMemo(() => {
    if (rightPanelView === "events") return eventGroups.map((group) => group.id).join("|");
    return ticketItems.map((ticket) => `${ticket.id}:${ticket.status}`).join("|");
  }, [eventGroups, rightPanelView, ticketItems]);

  useEffect(() => {
    void refreshWorkspaces();
    void refreshAgentProfiles();
    void refreshModelConfigs();
  }, []);

  useEffect(() => {
    if (!selectedId) return;
    void refreshSnapshot(selectedId);
    void refreshAgents(selectedId);
    void refreshAgentProfiles();
    void refreshModelConfigs();
    const source = new EventSource(`/api/workspaces/${selectedId}/events`);
    source.addEventListener("autoagent", (message) => {
      const event = JSON.parse((message as MessageEvent).data) as AutoAgentEvent;
      setEvents((current) => [...current, event].slice(-LIVE_EVENT_BUFFER_LIMIT));
      void refreshSnapshot(selectedId);
    });
    source.onerror = () => setError("Live event stream disconnected");
    return () => source.close();
  }, [selectedId]);

  useEffect(() => {
    const status = snapshot?.status;
    if (!selectedId || !snapshot?.activeTask || status === "completed" || status === "failed" || status === "interrupted") return;
    let disposed = false;
    let polling = false;
    const timer = window.setInterval(() => {
      if (polling) return;
      polling = true;
      void getSnapshot(selectedId).then((result) => {
        if (disposed) return;
        setSnapshot(result.snapshot);
        setEvents(result.snapshot.recentEvents);
      }).catch((err: Error) => {
        if (!disposed) setError(err.message);
      }).finally(() => {
        polling = false;
      });
    }, 1_000);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [selectedId, snapshot?.activeTask?.id, snapshot?.status]);

  useEffect(() => {
    if (humanFlowPrompt?.agentId) setSelectedAgentId(humanFlowPrompt.agentId);
  }, [humanFlowPrompt?.agentId]);

  useEffect(() => {
    setAgentMessage("");
  }, [selectedAgentId]);

  useEffect(() => {
    const panel = rightPanelRef.current;
    if (!panel) return;
    const frame = window.requestAnimationFrame(() => {
      panel.scrollTop = panel.scrollHeight;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [rightPanelScrollKey]);

  useEffect(() => {
    window.localStorage.setItem("autoagent.agentPanelHeight", String(agentPanelHeight));
  }, [agentPanelHeight]);

  useEffect(() => {
    window.localStorage.setItem("autoagent.runLayoutWidths", JSON.stringify(runLayoutWidths));
  }, [runLayoutWidths]);

  async function refreshWorkspaces(preferredWorkspaceId = selectedId) {
    try {
      const result = await listWorkspaces();
      const nextSelectedId = result.workspaces.some((workspace) => workspace.id === preferredWorkspaceId)
        ? preferredWorkspaceId
        : result.workspaces[0]?.id ?? "";
      setWorkspaces(result.workspaces);
      setSelectedId(nextSelectedId);
      if (!nextSelectedId) {
        setSnapshot(undefined);
        setEvents([]);
        setLoopDebugLog({ entries: [] });
        setAgents([]);
        setSelectedAgentId("");
      }
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function refreshSnapshot(workspaceId = selectedId) {
    if (!workspaceId) return;
    try {
      const result = await getSnapshot(workspaceId);
      setSnapshot(result.snapshot);
      setEvents(result.snapshot.recentEvents);
      void refreshLoopDebugLog(workspaceId);
      setError("");
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function refreshAgents(workspaceId = selectedId) {
    if (!workspaceId) return;
    try {
      const result = await listAgents(workspaceId);
      setAgents(result.agents);
      setSnapshot((current) => current ? { ...current, agents: mergeSnapshotAgents(current.agents, result.agents) } : current);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function refreshLoopDebugLog(workspaceId = selectedId) {
    if (!workspaceId) return;
    try {
      const result = await getLoopDebugLog(workspaceId);
      setLoopDebugLog(result.log);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function refreshModelConfigs() {
    try {
      const result = await listModelConfigs();
      setModelConfigs(result.configs);
      setError("");
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function refreshAgentProfiles() {
    try {
      const result = await listAgentProfiles();
      setAgentProfiles(result.profiles);
      setSelectedProfileId((current) => current || result.profiles[0]?.id || "");
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function submitWorkspace(event: React.FormEvent) {
    event.preventDefault();
    try {
      const result = await createWorkspace(workspaceForm);
      await refreshWorkspaces(result.workspace.id);
      setSelectedId(result.workspace.id);
      await refreshAgents(result.workspace.id);
      setWorkspaceForm((current) => ({ ...current, rootPath: "" }));
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function submitTask(event: React.FormEvent) {
    event.preventDefault();
    if (!selectedId || !goal.trim() || taskSubmitting) return;
    setTaskSubmitting(true);
    try {
      const taskId = snapshot?.activeTask?.id;
      const result = (mode === "running" || mode === "paused" || mode === "blocked") && taskId
        ? await sendTaskFollowup(selectedId, taskId, goal)
        : await startTask(selectedId, goal);
      setSnapshot(result.snapshot);
      setGoal("");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setTaskSubmitting(false);
    }
  }

  async function control(action: "pause" | "resume" | "stop") {
    const taskId = snapshot?.activeTask?.id;
    if (!selectedId || !taskId) return;
    try {
      if (action === "pause") await pauseTask(selectedId, taskId);
      if (action === "resume") await resumeTask(selectedId, taskId);
      if (action === "stop") await stopTask(selectedId, taskId);
      await refreshSnapshot();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  function startAgentPanelResize(event: React.PointerEvent<HTMLButtonElement>) {
    event.preventDefault();
    const startY = event.clientY;
    const startHeight = agentPanelHeight;
    const onMove = (moveEvent: PointerEvent) => {
      const nextHeight = startHeight - (moveEvent.clientY - startY);
      setAgentPanelHeight(clamp(nextHeight, AGENT_PANEL_MIN_HEIGHT, AGENT_PANEL_MAX_HEIGHT));
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp, { once: true });
  }

  function resizeAgentPanelWithKeyboard(event: React.KeyboardEvent<HTMLButtonElement>) {
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    event.preventDefault();
    const delta = event.key === "ArrowUp" ? 24 : -24;
    setAgentPanelHeight((current) => clamp(current + delta, AGENT_PANEL_MIN_HEIGHT, AGENT_PANEL_MAX_HEIGHT));
  }

  function startColumnResize(column: keyof RunLayoutWidths, event: React.PointerEvent<HTMLButtonElement>) {
    event.preventDefault();
    const startX = event.clientX;
    const startWidths = runLayoutWidths;
    const onMove = (moveEvent: PointerEvent) => {
      const delta = moveEvent.clientX - startX;
      setRunLayoutWidths({
        ...startWidths,
        [column]: clampColumnWidth(column, startWidths[column] + (column === "events" ? -delta : delta))
      });
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp, { once: true });
  }

  function resizeColumnWithKeyboard(column: keyof RunLayoutWidths, event: React.KeyboardEvent<HTMLButtonElement>) {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const direction = event.key === "ArrowRight" ? 24 : -24;
    const delta = column === "events" ? -direction : direction;
    setRunLayoutWidths((current) => ({
      ...current,
      [column]: clampColumnWidth(column, current[column] + delta)
    }));
  }

  async function saveAgent(agent: WorkspaceAgentConfig) {
    if (!selectedId) return;
    try {
      await updateAgent(selectedId, agent.id, {
        provider: agent.provider ?? "mock",
        model: agent.model ?? "",
        policyOverride: normalizePolicy(agent.policyOverride)
      });
      await refreshAgents(selectedId);
      await refreshSnapshot(selectedId);
      setError("");
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function confirmDeleteWorkspace() {
    if (!deleteDialog) return;
    const target = deleteDialog.workspace;
    try {
      setDeleteDialog({ ...deleteDialog, busy: true });
      await deleteWorkspace(target.id, { deleteLocalFolder: deleteDialog.deleteLocalFolder });
      await refreshWorkspaces(selectedId === target.id ? "" : selectedId);
      if (selectedId === target.id) {
        setSnapshot(undefined);
        setEvents([]);
        setAgents([]);
        setSelectedAgentId("");
      }
      setDeleteDialog(undefined);
      setError("");
    } catch (err) {
      setDeleteDialog((current) => current ? { ...current, busy: false } : current);
      setError((err as Error).message);
    }
  }

  async function sendSelectedAgentMessage(message = agentMessage) {
    const taskId = snapshot?.activeTask?.id;
    const agentId = selectedAgentId || snapshot?.agents[0]?.id;
    const text = message.trim();
    if (!selectedId || !taskId || !agentId || !text || agentMessageSubmitting) return;
    if (snapshot?.status === "completed" || snapshot?.status === "failed" || snapshot?.status === "interrupted") return;
    setAgentMessageSubmitting(true);
    try {
      const result = await sendAgentMessage(selectedId, taskId, agentId, text);
      setSnapshot(result.snapshot);
      setAgentMessage("");
      setError("");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setAgentMessageSubmitting(false);
    }
  }

  async function addModelConfig() {
    try {
      const result = await createModelConfig({
        name: modelConfigDraft.name,
        provider: modelConfigDraft.provider,
        model: modelConfigDraft.model,
        apiKey: modelConfigDraft.apiKey,
        baseUrl: modelConfigDraft.baseUrl
      });
      setModelConfigs((current) => [...current, result.config]);
      setModelConfigDraft({ name: "", provider: modelConfigDraft.provider, model: "", apiKey: "", baseUrl: "" });
      setError("");
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function saveModelConfig(config: ModelConfig) {
    try {
      const result = await updateModelConfig(config.id, {
        name: config.name,
        provider: config.provider,
        model: config.model,
        apiKey: config.apiKey === "********" ? undefined : config.apiKey,
        baseUrl: config.baseUrl
      });
      setModelConfigs((current) => current.map((item) => item.id === result.config.id ? result.config : item));
      setError("");
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function makeDefaultModelConfig(configId: string) {
    try {
      await setDefaultModelConfig(configId);
      await refreshModelConfigs();
      setError("");
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function saveAgentProfile(profile: AgentProfile) {
    try {
      const result = await updateAgentProfile(profile.id, {
        name: profile.name,
        identity: profile.identity,
        soul: profile.soul,
        agentMd: profile.agentMd,
        capabilities: profile.capabilities,
        defaultProvider: profile.defaultProvider,
        defaultModel: profile.defaultModel,
        defaultPolicy: profile.defaultPolicy
      });
      setAgentProfiles((current) => current.map((item) => item.id === result.profile.id ? result.profile : item));
      setError("");
    } catch (err) {
      setError((err as Error).message);
    }
  }

  const selectedAgent = snapshot?.agents.find((agent) => agent.id === selectedAgentId) ?? snapshot?.agents[0];
  const selectedProfile = profiles.find((profile) => profile.id === selectedAgentId) ?? profiles[0];
  const selectedDraft = selectedProfile ? agents.find((agent) => agent.id === selectedProfile.id) : undefined;
  const selectedCatalogProfile = catalogProfiles.find((profile) => profile.id === selectedProfileId) ?? catalogProfiles[0];
  const selectedCatalogDefinition = agentProfiles.find((profile) => profile.id === selectedCatalogProfile?.id) ?? agentProfiles[0];
  const hasActiveFlow = mode === "running" || mode === "paused" || mode === "blocked";
  const taskInputLabel = hasActiveFlow ? "全局补充" : "项目目标";
  const taskInputPlaceholder = hasActiveFlow ? "写给当前团队的补充信息，会进入后续 Agent 上下文；和单个 Agent 沟通请点击对应头像" : "描述这个项目要交给团队完成的目标";
  const taskSubmitView = buildTaskSubmitView({
    mode,
    hasWorkspace: Boolean(selectedId),
    hasText: Boolean(goal.trim()),
    submitting: taskSubmitting
  });
  const suggestedFollowup = humanFlowPrompt?.suggestion ?? "";
  const blockedPanelCopy = buildBlockedPanelCopy(snapshot);
  const displayedStatus = mode === "blocked"
    ? "blocked"
    : nodes.some((node) => node.needsAttention)
      ? "waiting"
      : snapshot?.status ?? "idle";
  const primaryPanelTitle = mode === "blocked"
    ? "任务控制"
    : mode === "terminal"
      ? "任务已结束，重新描述目标"
      : hasActiveFlow
      ? "任务控制"
      : "描述这个项目要交给团队完成的目标";
  const selectedAgentNeedsReply = Boolean(humanFlowPrompt && selectedAgent?.id === humanFlowPrompt.agentId);
  const selectedAgentMessages = selectedAgent ? snapshot?.agentMessages?.[selectedAgent.id] ?? [] : [];
  const selectedAgentThreadEvents = selectedAgent ? snapshot?.agentThreads?.[selectedAgent.id] ?? [] : [];
  const selectedAgentThreadBubbles = useMemo(
    () => buildAgentThreadBubbles(selectedAgentThreadEvents, selectedAgentMessages),
    [selectedAgentMessages, selectedAgentThreadEvents]
  );
  const taskIsTerminal = snapshot?.status === "completed" || snapshot?.status === "failed" || snapshot?.status === "interrupted" || mode === "terminal";
  const agentMessageDisabled = agentMessageSubmitting || taskIsTerminal || !selectedId || !snapshot?.activeTask || !selectedAgent || !agentMessage.trim();
  const agentActionDisabled = agentMessageSubmitting || taskIsTerminal || !selectedId || !snapshot?.activeTask || !selectedAgent;

  return (
    <main className="app-shell">
      <header className="topbar">
        <div>
          <h1>AutoAgent</h1>
          <span>本地自动化团队平台</span>
        </div>
        <nav className="topnav">
          <button className={view === "run" ? "selected" : ""} onClick={() => setView("run")}>运行台</button>
          <button className={view === "studio" ? "selected" : ""} onClick={() => setView("studio")}>智能体档案库</button>
          <button className={view === "team" ? "selected" : ""} onClick={() => setView("team")}>项目团队实例</button>
          <button className={view === "providers" ? "selected" : ""} onClick={() => setView("providers")}>模型服务</button>
        </nav>
        <strong className={`status-pill ${displayedStatus}`}>{statusLabel(displayedStatus)}</strong>
      </header>
      <section
        className="workspace-shell"
        style={{ gridTemplateColumns: `${runLayoutWidths.workspace}px 8px minmax(0, 1fr)` }}
      >
        <aside className="workspace-list">
          <form className="workspace-form" onSubmit={submitWorkspace}>
            <label>
              <span>项目名称</span>
              <input value={workspaceForm.name} onChange={(event) => setWorkspaceForm({ ...workspaceForm, name: event.target.value })} />
            </label>
            <label>
              <span>项目路径</span>
              <input value={workspaceForm.rootPath} onChange={(event) => setWorkspaceForm({ ...workspaceForm, rootPath: event.target.value })} placeholder="C:\\项目\\路径" />
            </label>
            <label>
              <span>安全策略</span>
              <select value={workspaceForm.policyProfile} onChange={(event) => setWorkspaceForm({ ...workspaceForm, policyProfile: event.target.value as Workspace["policyProfile"] })}>
                <option value="production">生产：限制在项目内</option>
                <option value="development">开发：允许本机访问</option>
              </select>
            </label>
            <button type="submit">创建项目</button>
          </form>
          <div className="workspace-items">
            {workspaces.map((workspace) => (
              <article key={workspace.id} className={workspace.id === selectedId ? "workspace-item selected" : "workspace-item"}>
                <button type="button" className="workspace-select" onClick={() => setSelectedId(workspace.id)}>
                  <strong>{displayWorkspaceName(workspace.name)}</strong>
                  <span>{workspace.rootPath}</span>
                </button>
                <button
                  type="button"
                  className="workspace-delete"
                  aria-label={`删除项目 ${displayWorkspaceName(workspace.name)}`}
                  title="删除项目"
                  onClick={() => setDeleteDialog({ workspace, deleteLocalFolder: false, busy: false })}
                >
                  删除
                </button>
              </article>
            ))}
          </div>
        </aside>
        <button
          type="button"
          role="separator"
          className="column-resizer"
          aria-label="调整项目列表宽度"
          aria-orientation="vertical"
          aria-valuemin={WORKSPACE_PANEL_MIN_WIDTH}
          aria-valuemax={WORKSPACE_PANEL_MAX_WIDTH}
          aria-valuenow={runLayoutWidths.workspace}
          onPointerDown={(event) => startColumnResize("workspace", event)}
          onKeyDown={(event) => resizeColumnWithKeyboard("workspace", event)}
          title="拖动调整项目列表宽度"
        />
        <section
          className={view === "run" ? "console-region" : "management-region"}
          style={view === "run" ? { gridTemplateColumns: `${runLayoutWidths.task}px 8px minmax(0, 1fr) 8px ${runLayoutWidths.events}px` } : undefined}
        >
          {view === "run" ? <>
            <section className="task-panel">
            <h2 className="task-panel-title">{primaryPanelTitle}</h2>
            {mode === "blocked" ? (
              <p className="task-panel-hint">{blockedPanelCopy.hint}</p>
            ) : null}
            <form onSubmit={submitTask}>
              <label>
                <span>{taskInputLabel}</span>
                <textarea value={goal} onChange={(event) => setGoal(event.target.value)} placeholder={taskInputPlaceholder} disabled={taskSubmitting} />
              </label>
              <button type="submit" disabled={taskSubmitView.disabled}>{taskSubmitView.label}</button>
            </form>
            <div className="control-row">
              <button type="button" onClick={() => void control("pause")} disabled={mode !== "running"}>暂停</button>
              <button type="button" onClick={() => void control("resume")} disabled={mode !== "paused" && mode !== "blocked"}>继续</button>
              <button type="button" onClick={() => void control("stop")} disabled={mode !== "running" && mode !== "paused" && mode !== "blocked"}>停止</button>
            </div>
            {error ? <p className="error-text">{error}</p> : null}
            </section>

            <button
              type="button"
              role="separator"
              className="column-resizer"
              aria-label="调整任务控制区宽度"
              aria-orientation="vertical"
              aria-valuemin={TASK_PANEL_MIN_WIDTH}
              aria-valuemax={TASK_PANEL_MAX_WIDTH}
              aria-valuenow={runLayoutWidths.task}
              onPointerDown={(event) => startColumnResize("task", event)}
              onKeyDown={(event) => resizeColumnWithKeyboard("task", event)}
              title="拖动调整任务控制区宽度"
            />

            <section className="canvas-panel" style={{ gridTemplateRows: `minmax(220px, 1fr) 8px ${agentPanelHeight}px` }}>
            <div className="team-canvas">
              <div className="canvas-phase">{phaseLabel(snapshot?.phase ?? "idle")}</div>
              {nodes.map((node) => (
                <button
                  key={node.id}
                  className={`${node.active ? "agent-node active" : `agent-node ${node.status}`} ${node.needsAttention ? "needs-attention" : ""}`}
                  style={{ left: `${node.x}%`, top: `${node.y}%` }}
                  onClick={() => setSelectedAgentId(node.id)}
                  title={node.currentStepTitle ?? node.currentStep ?? statusLabel(node.status)}
                >
                  <span className="avatar">{initials(node.label)}</span>
                  {node.needsAttention ? <span className="attention-badge">!</span> : null}
                  <strong>{node.label}</strong>
                  <small className={node.currentStep ? "agent-step-bubble" : undefined}>{node.currentStep ?? statusLabel(node.status)}</small>
                </button>
              ))}
            </div>
            <button
              type="button"
              role="separator"
              className="canvas-resizer"
              aria-label="调整 Agent 对话区高度"
              aria-orientation="horizontal"
              aria-valuemin={AGENT_PANEL_MIN_HEIGHT}
              aria-valuemax={AGENT_PANEL_MAX_HEIGHT}
              aria-valuenow={agentPanelHeight}
              onPointerDown={startAgentPanelResize}
              onKeyDown={resizeAgentPanelWithKeyboard}
              title="拖动调整 Agent 对话区高度"
            />
            <div className={selectedAgent ? "agent-detail chat-mode" : "agent-detail"}>
              {selectedAgentNeedsReply && humanFlowPrompt ? (
                <AgentHumanLoopBox
                  agentName={selectedAgent ? roleLabel(selectedAgent.roleInWorkspace) : humanFlowPrompt.waiter}
                  prompt={humanFlowPrompt}
                  bubbles={selectedAgentThreadBubbles}
                  value={agentMessage}
                  disabled={agentMessageDisabled}
                  actionDisabled={agentActionDisabled}
                  onChange={setAgentMessage}
                  onUseSuggestion={() => setAgentMessage(suggestedFollowup)}
                  onFollowup={(message) => void sendSelectedAgentMessage(message)}
                  onSend={(message) => void sendSelectedAgentMessage(message)}
                />
              ) : selectedAgent ? (
                <AgentDirectChatBox
                  agent={selectedAgent}
                  bubbles={selectedAgentThreadBubbles}
                  value={agentMessage}
                  disabled={agentMessageDisabled}
                  sending={agentMessageSubmitting}
                  onChange={setAgentMessage}
                  onSend={(message) => void sendSelectedAgentMessage(message)}
                />
              ) : (
                <>
                  <strong>未选择成员</strong>
                  <span>空闲</span>
                  <p>创建项目后会生成固定团队。</p>
                </>
              )}
            </div>
            </section>

            <button
              type="button"
              role="separator"
              className="column-resizer"
              aria-label="调整运行记录宽度"
              aria-orientation="vertical"
              aria-valuemin={EVENT_PANEL_MIN_WIDTH}
              aria-valuemax={EVENT_PANEL_MAX_WIDTH}
              aria-valuenow={runLayoutWidths.events}
              onPointerDown={(event) => startColumnResize("events", event)}
              onKeyDown={(event) => resizeColumnWithKeyboard("events", event)}
              title="拖动调整运行记录宽度"
            />

            <aside className="event-panel" ref={rightPanelRef}>
              <div className="right-panel-tabs" role="tablist" aria-label="运行台右侧视图">
                <button
                  type="button"
                  role="tab"
                  aria-selected={rightPanelView === "events"}
                  className={rightPanelView === "events" ? "selected" : ""}
                  onClick={() => setRightPanelView("events")}
                >
                  运行记录
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={rightPanelView === "tickets"}
                  className={rightPanelView === "tickets" ? "selected" : ""}
                  onClick={() => setRightPanelView("tickets")}
                >
                  原始工单
                </button>
              </div>
              {rightPanelView === "events" ? (
                <div className="event-panel-content">
                  {eventGroups.map((group) => (
                    <EventTimelineGroupCard key={group.id} group={group} debugLog={loopDebugLog} />
                  ))}
                </div>
              ) : (
                <div className="event-panel-content">
                  <TicketInspector items={ticketItems} onShowRaw={setRawTicketDialog} />
                </div>
              )}
            </aside>
          </> : null}

          {view === "studio" ? (
            <AgentHub
              profileViews={catalogProfiles}
              profiles={agentProfiles}
              modelConfigs={modelConfigs}
              selectedId={selectedCatalogDefinition?.id}
              onSelect={setSelectedProfileId}
              onProfileChange={(next) => setAgentProfiles((current) => current.map((item) => item.id === next.id ? next : item))}
              onSave={(profile) => void saveAgentProfile(profile)}
            />
          ) : null}

          {view === "team" ? (
            <ProjectTeam
              profiles={profiles}
              modelConfigs={modelConfigs}
              selectedId={selectedProfile?.id}
              selectedProfile={selectedProfile}
              selectedDraft={selectedDraft}
              onSelect={setSelectedAgentId}
              onRefresh={() => void refreshAgents()}
              onDraftChange={(next) => setAgents((current) => current.map((item) => item.id === next.id ? next : item))}
              onSave={(agent) => void saveAgent(agent)}
            />
          ) : null}

          {view === "providers" ? (
            <ModelConfigLibrary
              configs={modelConfigs}
              draft={modelConfigDraft}
              onDraftChange={setModelConfigDraft}
              onAdd={() => void addModelConfig()}
              onRefresh={() => void refreshModelConfigs()}
              onChange={(next) => setModelConfigs((current) => current.map((item) => item.id === next.id ? next : item))}
              onSave={(config) => void saveModelConfig(config)}
              onSetDefault={(configId) => void makeDefaultModelConfig(configId)}
            />
          ) : null}
        </section>
      </section>
      {deleteDialog ? (
        <DeleteWorkspaceDialog
          state={deleteDialog}
          onChange={(deleteLocalFolder) => setDeleteDialog((current) => current ? { ...current, deleteLocalFolder } : current)}
          onCancel={() => setDeleteDialog(undefined)}
          onConfirm={() => void confirmDeleteWorkspace()}
        />
      ) : null}
      {rawTicketDialog ? (
        <RawTicketDialog item={rawTicketDialog} onClose={() => setRawTicketDialog(undefined)} />
      ) : null}
    </main>
  );
}

function DeleteWorkspaceDialog(props: {
  state: DeleteWorkspaceDialogState;
  onChange: (deleteLocalFolder: boolean) => void;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const workspaceName = displayWorkspaceName(props.state.workspace.name);
  return (
    <div className="modal-backdrop" role="presentation">
      <section className="delete-dialog" role="dialog" aria-modal="true" aria-labelledby="delete-workspace-title">
        <header>
          <h2 id="delete-workspace-title">删除项目</h2>
          <p>你正在删除 AutoAgent 里的项目：{workspaceName}</p>
        </header>
        <div className="delete-dialog-path">
          <span>本地路径</span>
          <code>{props.state.workspace.rootPath}</code>
        </div>
        <label className="danger-checkbox">
          <input
            type="checkbox"
            checked={props.state.deleteLocalFolder}
            disabled={props.state.busy}
            onChange={(event) => props.onChange(event.target.checked)}
          />
          <span>同时删除本地文件夹</span>
        </label>
        <p className={props.state.deleteLocalFolder ? "delete-warning active" : "delete-warning"}>
          {props.state.deleteLocalFolder
            ? "会递归删除上面的本地目录，项目代码和 .autoagent 状态都会被删除。"
            : "默认只从 AutoAgent 项目列表移除，不删除本地文件夹。"}
        </p>
        <footer>
          <button type="button" onClick={props.onCancel} disabled={props.state.busy}>取消</button>
          <button type="button" className="danger-button" onClick={props.onConfirm} disabled={props.state.busy}>
            {props.state.busy ? "删除中" : "确认删除"}
          </button>
        </footer>
      </section>
    </div>
  );
}

function RawTicketDialog(props: { item: TicketInspectorItem; onClose: () => void }) {
  return (
    <div className="modal-backdrop" role="presentation">
      <section className="raw-ticket-dialog" role="dialog" aria-modal="true" aria-labelledby="raw-ticket-title">
        <header>
          <h2 id="raw-ticket-title">{props.item.title}</h2>
          <button type="button" onClick={props.onClose}>关闭</button>
        </header>
        <pre>{props.item.rawJson}</pre>
      </section>
    </div>
  );
}

function TicketInspector(props: { items: TicketInspectorItem[]; onShowRaw: (item: TicketInspectorItem) => void }) {
  if (props.items.length === 0) {
    return (
      <section className="ticket-inspector-empty">
        <strong>还没有工单</strong>
        <p>开始任务后，这里会显示当前项目当前任务拆出来的原始工单。</p>
      </section>
    );
  }

  return (
    <section className="ticket-inspector">
      {props.items.map((item) => (
        <article key={item.id} className={`raw-ticket-card ${item.status}`}>
          <header>
            <strong>{item.title}</strong>
            <span>{item.statusLabel}</span>
          </header>
          <p>{item.brief}</p>
          <small>交付物：{item.expectedArtifact}</small>
          {item.relationLines.map((line) => <small key={line}>关系：{line}</small>)}
          {item.resultSummary ? <em>{item.resultSummary}</em> : null}
          {item.resultLines.length > 0 ? (
            <ol>
              {item.resultLines.map((line) => <li key={line}>{line}</li>)}
            </ol>
          ) : null}
          <button type="button" className="raw-ticket-json-button" onClick={() => props.onShowRaw(item)}>查看原始 JSON</button>
        </article>
      ))}
    </section>
  );
}

function EventTimelineCard(props: { event: AutoAgentEvent; debugLog: LoopDebugLog }) {
  const [expanded, setExpanded] = useState(false);
  const item = buildEventTimelineItem(props.event);
  const loopEntries = relatedLoopEntries(props.event, item.actor, props.debugLog);
  const contextSummary = contextReportDebugText(props.event);
  const payload = JSON.stringify(props.event.payload ?? {}, null, 2);
  return (
    <article className={`event-item ${item.tone}`} title={item.debugType}>
      <button type="button" className="event-summary-button" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>
        <span className="event-actor">{item.actor}</span>
        <span className="event-summary-copy">
          <strong className="event-title">{item.title}</strong>
          {item.detail ? <small className="event-detail">{item.detail}</small> : null}
        </span>
      </button>
      {expanded ? (
        <div className="event-debug-body">
          {contextSummary ? (
            <DebugBlock title="上下文摘要" subtitle="本轮模型输入预算" content={contextSummary} kind="flow" />
          ) : null}
          {loopEntries.map((entry) => (
            <DebugBlock key={entry.id} title={debugKindLabel(entry.kind)} subtitle={entry.detail} content={entry.content} kind={entry.kind} />
          ))}
          <details className="event-raw-details">
            <summary>查看事件原始数据</summary>
            <DebugBlock title="事件原始数据" subtitle={props.event.type} content={payload} kind="flow" />
          </details>
        </div>
      ) : null}
    </article>
  );
}

function EventTimelineGroupCard(props: { group: EventTimelineGroup; debugLog: LoopDebugLog }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <section className={`event-group ${props.group.tone}`}>
      <button type="button" className="event-group-button" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>
        <span className="event-group-avatar">{props.group.actor.slice(0, 1)}</span>
        <span className="event-group-copy">
          <strong>{props.group.title}</strong>
          <small>{props.group.summary}</small>
        </span>
        <span className="event-group-count">{props.group.events.length}</span>
      </button>
      {expanded ? (
        <div className="event-group-body">
          {props.group.events.map((event) => (
            <EventTimelineCard key={event.id} event={event} debugLog={props.debugLog} />
          ))}
        </div>
      ) : null}
    </section>
  );
}

function DebugBlock(props: { title: string; subtitle?: string; content: string; kind: LoopDebugEntry["kind"] }) {
  return (
    <section className={`event-debug-block ${props.kind}`}>
      <header>
        <strong>{props.title}</strong>
        {props.subtitle ? <span>{props.subtitle}</span> : null}
      </header>
      <pre>{props.content || "{}"}</pre>
    </section>
  );
}

function contextReportDebugText(event: AutoAgentEvent): string | undefined {
  if (event.type !== "context.assembled") return undefined;
  const report = recordValue(event.payload.report);
  if (!report) return undefined;
  const sections = Array.isArray(report.sections) ? report.sections : [];
  const sectionLines = sections
    .map((section) => recordValue(section))
    .filter((section): section is Record<string, unknown> => Boolean(section))
    .map((section) => {
      const name = contextSectionLabel(stringValue(section.name));
      const injectedChars = numberValue(section.injectedChars);
      const estimatedTokens = numberValue(section.estimatedTokens);
      const originalChars = numberValue(section.originalChars);
      const truncated = section.truncated === true ? "，已截断" : "";
      return `- ${name}：${formatCount(injectedChars)} 字，约 ${formatCount(estimatedTokens)} tokens，原始 ${formatCount(originalChars)} 字${truncated}`;
    });
  const compaction = recordValue(report.compaction);
  const compacted = compaction?.compacted === true ? "已压缩" : "未压缩";
  const header = [
    `实际发送：${formatCount(numberValue(report.injectedChars))} 字，约 ${formatCount(numberValue(report.estimatedTokens))} tokens`,
    `原始 session：${formatCount(numberValue(report.originalSessionChars))} 字`,
    `会话压缩：${compacted}`
  ];
  return [...header, "", "分段：", ...sectionLines].join("\n");
}

function contextSectionLabel(name: string | undefined): string {
  const labels: Record<string, string> = {
    stable_prompt: "稳定提示词",
    current_assignment: "当前工单",
    workspace_memory: "工作区记忆",
    session_summary: "会话摘要",
    recent_turns: "近期会话",
    tool_observations: "工具结果",
    dynamic_context: "动态上下文"
  };
  return name ? labels[name] ?? name : "未知分段";
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function formatCount(value: number | undefined): string {
  return value === undefined ? "-" : Math.round(value).toLocaleString("zh-CN");
}

function relatedLoopEntries(event: AutoAgentEvent, actor: string, log: LoopDebugLog): LoopDebugEntry[] {
  const direct = directLoopEntries(event, actor, log);
  if (direct.length > 0) return direct;
  if (event.type.startsWith("provider.") || event.type === "assignment.completed" || event.type === "assignment.blocked") {
    return nearestTurnEntries(event, actor, log);
  }
  return [];
}

function directLoopEntries(event: AutoAgentEvent, actor: string, log: LoopDebugLog): LoopDebugEntry[] {
  const providerText = providerTextFromEvent(event);
  const rawText = stringFromPayload(event, "rawText");
  const targetText = providerText ?? rawText;
  if (targetText) {
    const llm = log.entries.find((entry) => entry.kind === "llm" && entry.actor === actor && entry.content.trim() === targetText.trim());
    if (llm) return turnEntriesFor(log, llm);
  }
  const toolResults = payloadArray(event, "toolResults");
  if (toolResults.length > 0) {
    const matches = log.entries.filter((entry) => entry.kind === "tool" && toolResults.some((toolResult) => entry.content === JSON.stringify(toolResult)));
    if (matches.length > 0) return uniqueLoopEntries(matches.flatMap((entry) => turnEntriesFor(log, entry)));
  }
  return [];
}

function nearestTurnEntries(event: AutoAgentEvent, actor: string, log: LoopDebugLog): LoopDebugEntry[] {
  const eventTime = Date.parse(event.timestamp);
  if (!Number.isFinite(eventTime)) return [];
  const candidates = log.entries
    .filter((entry) => entry.actor === actor && (entry.kind === "prompt" || entry.kind === "llm" || entry.kind === "tool"))
    .map((entry) => ({ entry, distance: Math.abs(Date.parse(entry.timestamp) - eventTime) }))
    .filter((item) => Number.isFinite(item.distance) && item.distance <= 30_000)
    .sort((a, b) => a.distance - b.distance);
  return candidates[0] ? turnEntriesFor(log, candidates[0].entry) : [];
}

function turnEntriesFor(log: LoopDebugLog, anchor: LoopDebugEntry): LoopDebugEntry[] {
  return log.entries.filter((entry) => entry.actor === anchor.actor && entry.timestamp === anchor.timestamp && entry.kind !== "flow");
}

function uniqueLoopEntries(entries: LoopDebugEntry[]): LoopDebugEntry[] {
  const seen = new Set<string>();
  return entries.filter((entry) => {
    if (seen.has(entry.id)) return false;
    seen.add(entry.id);
    return true;
  });
}

function providerTextFromEvent(event: AutoAgentEvent): string | undefined {
  const providerEvents = event.payload.providerEvents;
  if (!Array.isArray(providerEvents)) return undefined;
  const text = providerEvents.find((item) => {
    return Boolean(item) && typeof item === "object" && (item as Record<string, unknown>).type === "text";
  });
  const value = text && typeof text === "object" ? (text as Record<string, unknown>).text : undefined;
  return typeof value === "string" ? value : undefined;
}

function stringFromPayload(event: AutoAgentEvent, key: string): string | undefined {
  const value = event.payload[key];
  return typeof value === "string" ? value : undefined;
}

function payloadArray(event: AutoAgentEvent, key: string): unknown[] {
  const value = event.payload[key];
  return Array.isArray(value) ? value : [];
}

function debugKindLabel(kind: LoopDebugEntry["kind"]): string {
  const labels: Record<LoopDebugEntry["kind"], string> = {
    flow: "Flow 事件",
    prompt: "Prompt",
    llm: "LLM 返回",
    tool: "工具结果"
  };
  return labels[kind];
}

function ManualTestActionCard(props: {
  action: NonNullable<ReturnType<typeof buildManualTestAction>>;
  disabled: boolean;
  onFollowup: (message: string) => void;
}) {
  return (
    <section className="manual-test-action">
      <strong>现在需要你人工测试</strong>
      <p>{props.action.summary}</p>
      {props.action.testFile ? <small>打开：{props.action.testFile}</small> : null}
      {props.action.steps.length ? (
        <ol>
          {props.action.steps.map((step) => <li key={step}>{step}</li>)}
        </ol>
      ) : null}
      {props.action.expectedResult ? <em>通过标准：{props.action.expectedResult}</em> : null}
      <div className="ticket-actions">
        <button type="button" disabled={props.disabled} onClick={() => props.onFollowup(props.action.passMessage)}>测试通过</button>
        <button type="button" disabled={props.disabled} onClick={() => props.onFollowup(props.action.failMessage)}>测试不通过，打回开发</button>
      </div>
    </section>
  );
}

function initialAgentPanelHeight(): number {
  if (typeof window === "undefined") return AGENT_PANEL_DEFAULT_HEIGHT;
  const saved = Number(window.localStorage.getItem("autoagent.agentPanelHeight"));
  return clamp(Number.isFinite(saved) ? saved : AGENT_PANEL_DEFAULT_HEIGHT, AGENT_PANEL_MIN_HEIGHT, AGENT_PANEL_MAX_HEIGHT);
}

function initialRunLayoutWidths(): RunLayoutWidths {
  const fallback: RunLayoutWidths = { workspace: 310, task: 280, events: 340 };
  if (typeof window === "undefined") return fallback;
  try {
    const saved = JSON.parse(window.localStorage.getItem("autoagent.runLayoutWidths") ?? "") as Partial<RunLayoutWidths>;
    return {
      workspace: clampColumnWidth("workspace", Number(saved.workspace) || fallback.workspace),
      task: clampColumnWidth("task", Number(saved.task) || fallback.task),
      events: clampColumnWidth("events", Number(saved.events) || fallback.events)
    };
  } catch {
    return fallback;
  }
}

function clampColumnWidth(column: keyof RunLayoutWidths, value: number): number {
  const limits: Record<keyof RunLayoutWidths, { min: number; max: number }> = {
    workspace: { min: WORKSPACE_PANEL_MIN_WIDTH, max: WORKSPACE_PANEL_MAX_WIDTH },
    task: { min: TASK_PANEL_MIN_WIDTH, max: TASK_PANEL_MAX_WIDTH },
    events: { min: EVENT_PANEL_MIN_WIDTH, max: EVENT_PANEL_MAX_WIDTH }
  };
  return clamp(value, limits[column].min, limits[column].max);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function AgentHumanLoopBox(props: {
  agentName: string;
  prompt: NonNullable<ReturnType<typeof buildHumanFlowPrompt>>;
  bubbles: AgentThreadBubble[];
  value: string;
  disabled: boolean;
  actionDisabled: boolean;
  onChange: (value: string) => void;
  onUseSuggestion: () => void;
  onFollowup: (message: string) => void;
  onSend: (message: string) => void;
}) {
  const messageBody = props.prompt.transcript.replace(/^[^\n]+:\n/, "");
  const bubbles = props.prompt.manualTest
    ? props.bubbles
    : appendCurrentAgentPrompt(props.bubbles, messageBody);
  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    props.onSend(props.value);
  };
  return (
    <form className="agent-chat" onSubmit={submit}>
      <header className="agent-chat-header">
        <span className="chat-avatar">{initials(props.agentName)}</span>
        <div>
          <strong>{props.agentName} 对话</strong>
          <small>{props.prompt.title} · {props.prompt.phase}</small>
        </div>
      </header>
      <div className="chat-thread">
        {bubbles.map((bubble) => (
          <article key={bubble.id} className={`chat-message ${bubble.role}`}>
            {bubble.title ? <strong className="thread-bubble-title">{bubble.title}</strong> : null}
            <AgentMessageBody rawText={bubble.body} />
          </article>
        ))}
        {props.prompt.manualTest ? (
          <article className="chat-message agent">
            <ManualTestActionCard
              action={props.prompt.manualTest}
              disabled={props.actionDisabled}
              onFollowup={props.onFollowup}
            />
          </article>
        ) : null}
      </div>
      {!props.prompt.manualTest ? (
        <button type="button" className="quick-reply" title={props.prompt.suggestion} onClick={props.onUseSuggestion}>使用建议方案</button>
      ) : null}
      <div className="chat-composer">
        <textarea
          aria-label={props.prompt.inputLabel}
          value={props.value}
          onChange={(event) => props.onChange(event.target.value)}
          placeholder={props.prompt.placeholder}
        />
        <button type="submit" disabled={props.disabled}>{props.prompt.submitLabel}</button>
      </div>
    </form>
  );
}

function AgentDirectChatBox(props: {
  agent: WorkspaceSnapshot["agents"][number];
  bubbles: AgentThreadBubble[];
  value: string;
  disabled: boolean;
  sending: boolean;
  onChange: (value: string) => void;
  onSend: (message: string) => void;
}) {
  const agentName = roleLabel(props.agent.roleInWorkspace);
  const statusText = props.agent.currentStep ?? capabilityLabels(props.agent.roleInWorkspace, props.agent.capabilities).join("、") ?? statusLabel(props.agent.status);
  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    props.onSend(props.value);
  };
  return (
    <form className="agent-chat" onSubmit={submit}>
      <header className="agent-chat-header">
        <span className="chat-avatar">{initials(agentName)}</span>
        <div>
          <strong>{agentName} 对话</strong>
          <small>私聊 · {statusLabel(props.agent.status)}</small>
        </div>
      </header>
      <div className="chat-thread">
        {props.bubbles.length > 0 ? props.bubbles.map((bubble) => (
          <article key={bubble.id} className={`chat-message ${bubble.role}`}>
            {bubble.title ? <strong className="thread-bubble-title">{bubble.title}</strong> : null}
            <AgentMessageBody rawText={bubble.body} />
          </article>
        )) : (
          <article className="chat-message agent">
            <p className="agent-plain-message">{statusText || "当前没有正在执行的步骤。你可以直接给这个 Agent 留补充信息。"}</p>
          </article>
        )}
      </div>
      <div className="chat-composer">
        <textarea
          aria-label={`回复${agentName}`}
          value={props.value}
          onChange={(event) => props.onChange(event.target.value)}
          placeholder={`回复${agentName}`}
        />
        <button type="submit" disabled={props.disabled}>{props.sending ? "发送中" : "发送"}</button>
      </div>
    </form>
  );
}

function AgentMessageBody(props: { rawText: string }) {
  const view = buildAgentMessageView(props.rawText);
  if (view.kind === "text") return <p className="agent-plain-message">{view.rawText}</p>;

  return (
    <div className="agent-structured-message">
      {view.paragraphs.length > 0 ? (
        <div className="agent-message-prose">
          {view.paragraphs.map((paragraph) => <p key={paragraph}>{paragraph}</p>)}
        </div>
      ) : null}
      <details>
        <summary>查看原始文本</summary>
        <pre className="agent-raw-message">{view.rawText}</pre>
      </details>
    </div>
  );
}

function AgentHub(props: {
  profileViews: AgentProfileView[];
  profiles: AgentProfile[];
  modelConfigs: ModelConfig[];
  selectedId?: string;
  onSelect: (id: string) => void;
  onProfileChange: (profile: AgentProfile) => void;
  onSave: (profile: AgentProfile) => void;
}) {
  const selected = props.profiles.find((profile) => profile.id === props.selectedId) ?? props.profiles[0];
  const selectedView = props.profileViews.find((profile) => profile.id === selected?.id);
  return (
    <section className="management-panel agent-studio">
      <header className="management-header">
        <div>
          <h2>智能体档案库</h2>
          <p>这里编辑全局灵魂特质、岗位契约、能力手册和默认模型；项目团队只引用这些档案，不在这里产生项目状态。</p>
        </div>
      </header>
      <div className="studio-layout">
        <div className="agent-studio-grid">
          {props.profileViews.map((profile) => (
            <AgentProfileCard
              key={profile.id}
              profile={profile}
              selected={profile.id === props.selectedId}
              modelConfigs={props.modelConfigs}
              onSelect={props.onSelect}
            />
          ))}
        </div>
        {selected && selectedView ? (
          <AgentDefinitionEditor
            profile={selected}
            view={selectedView}
            modelConfigs={props.modelConfigs}
            onChange={props.onProfileChange}
            onSave={props.onSave}
          />
        ) : (
          <aside className="agent-detail-panel empty-state">还没有可编辑的智能体档案。</aside>
        )}
      </div>
    </section>
  );
}

function AgentProfileCard(props: {
  profile: AgentProfileView;
  selected: boolean;
  modelConfigs: ModelConfig[];
  onSelect: (id: string) => void;
}) {
  const modelTarget = { provider: props.profile.model.provider, model: props.profile.model.modelName };
  const selectedModel = modelSelectionOptions(modelTarget, props.modelConfigs)
    .find((option) => option.value === modelSelectionValue(modelTarget, props.modelConfigs));
  return (
    <button
      type="button"
      className={props.selected ? "agent-profile-card selected" : "agent-profile-card"}
      onClick={() => props.onSelect(props.profile.id)}
    >
      <span className="profile-avatar">{props.profile.identity.avatar}</span>
      <strong>{props.profile.identity.title}</strong>
      <small>{agentProfileCardSummary(props.profile)}</small>
      <div className="profile-meta">
        <span title={selectedModel?.label ?? props.profile.model.providerLabel}>{compactModelLabel(selectedModel?.label ?? props.profile.model.providerLabel)}</span>
      </div>
    </button>
  );
}

function compactModelLabel(label: string): string {
  return label.replace(/（.*$/, "");
}

function AgentDefinitionEditor(props: {
  profile: AgentProfile;
  view: AgentProfileView;
  modelConfigs: ModelConfig[];
  onChange: (profile: AgentProfile) => void;
  onSave: (profile: AgentProfile) => void;
}) {
  const capabilitiesText = props.profile.capabilities.join("、");
  const policy = normalizePolicy(props.profile.defaultPolicy);
  const modelTarget = { provider: props.profile.defaultProvider, model: props.profile.defaultModel };
  const modelOptions = modelSelectionOptions(modelTarget, props.modelConfigs);
  const selectedModelValue = modelSelectionValue(modelTarget, props.modelConfigs);
  const configuredTools = new Set(policy.enabledTools ?? []);
  const effectiveTools = new Set(toolsForPolicy(policy).map((tool) => tool.name));
  const updateDefaultPolicy = (patch: Partial<AgentPolicy>) => {
    props.onChange({ ...props.profile, defaultPolicy: { ...policy, ...patch } });
  };
  const setDefaultToolEnabled = (toolName: WorkspaceToolName, enabled: boolean) => {
    const current = new Set(policy.enabledTools ?? []);
    if (enabled) current.add(toolName);
    else current.delete(toolName);
    updateDefaultPolicy({
      ...(enabled ? permissionPatchForTool(toolName) : {}),
      enabledTools: Array.from(current)
    });
  };
  return (
    <aside className="agent-detail-panel agent-definition-editor">
      <header className="agent-hero">
        <span className="profile-avatar large">{props.view.identity.avatar}</span>
        <div>
          <h3>{props.profile.name}</h3>
          <p>{props.profile.identity}</p>
          <small>全局智能体档案，保存后会被项目团队实例引用。</small>
        </div>
      </header>

      <section className="agent-section">
        <h4>灵魂特质</h4>
        <label>
          <span>动机、注意力模式、判断风格和压力下的行为倾向</span>
          <textarea aria-label="灵魂特质" value={props.profile.soul ?? ""} onChange={(event) => props.onChange({ ...props.profile, soul: event.target.value })} />
        </label>
      </section>

      <section className="agent-section">
        <h4>岗位契约</h4>
        <label>
          <span>名称</span>
          <input value={props.profile.name} onChange={(event) => props.onChange({ ...props.profile, name: event.target.value })} />
        </label>
        <label>
          <span>岗位说明</span>
          <textarea aria-label="岗位说明" value={props.profile.identity ?? ""} onChange={(event) => props.onChange({ ...props.profile, identity: event.target.value })} />
        </label>
      </section>

      <section className="agent-section">
        <h4>能力手册</h4>
        <label>
          <span>工作方法、交付标准和能力边界</span>
          <textarea
            className="agent-md-editor"
            aria-label="能力手册"
            value={props.profile.agentMd ?? ""}
            onChange={(event) => props.onChange({ ...props.profile, agentMd: event.target.value })}
          />
        </label>
      </section>

      <section className="agent-section">
        <h4>能力索引</h4>
        <label>
          <span>用于调度和列表摘要，完整能力写在能力手册</span>
          <input value={capabilitiesText} onChange={(event) => props.onChange({ ...props.profile, capabilities: event.target.value.split(/[、,，]/).map((item) => item.trim()).filter(Boolean) })} />
        </label>
      </section>

      <section className="agent-section runtime-config">
        <h4>默认模型</h4>
        <div className="runtime-fields">
          <label>
            <span>模型配置</span>
            <select
              value={selectedModelValue}
              onChange={(event) => {
                const next = applyModelSelection(event.target.value, props.modelConfigs, modelTarget);
                props.onChange({ ...props.profile, defaultProvider: next.provider, defaultModel: next.model });
              }}
            >
              {modelOptions.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </label>
          <label>
            <span>默认模型</span>
            <input value={props.profile.defaultModel} onChange={(event) => props.onChange({ ...props.profile, defaultModel: event.target.value })} />
          </label>
        </div>
      </section>

      <section className="agent-section runtime-config">
        <h4>默认权限与工具</h4>
        <div className="policy-grid">
          <Toggle label="读项目" checked={policy.canReadWorkspace} onChange={(checked) => updateDefaultPolicy({ canReadWorkspace: checked })} />
          <Toggle label="写项目" checked={policy.canWriteWorkspace} onChange={(checked) => updateDefaultPolicy({ canWriteWorkspace: checked })} />
          <Toggle label="执行命令" checked={policy.canExecuteCommands} onChange={(checked) => updateDefaultPolicy({ canExecuteCommands: checked })} />
          <Toggle label="访问本机" checked={Boolean(policy.allowHostAccess)} onChange={(checked) => updateDefaultPolicy({ allowHostAccess: checked })} />
        </div>
        <div className="tool-config-grid">
          {TOOL_CATALOG.map((tool) => (
            <Toggle
              key={tool.name}
              label={tool.label}
              checked={configuredTools.has(tool.name) && effectiveTools.has(tool.name)}
              onChange={(checked) => setDefaultToolEnabled(tool.name, checked)}
            />
          ))}
        </div>
        <button type="button" onClick={() => props.onSave(props.profile)}>保存智能体档案</button>
      </section>
    </aside>
  );
}

function ProjectTeam(props: {
  profiles: AgentProfileView[];
  modelConfigs: ModelConfig[];
  selectedId?: string;
  selectedProfile?: AgentProfileView;
  selectedDraft?: WorkspaceAgentConfig;
  onSelect: (id: string) => void;
  onRefresh: () => void;
  onDraftChange: (agent: WorkspaceAgentConfig) => void;
  onSave: (agent: WorkspaceAgentConfig) => void;
}) {
  return (
    <section className="management-panel team-workbench">
      <header className="management-header">
        <div>
          <h2>项目团队实例</h2>
          <p>这里是当前项目里的运行成员。全局档案不在这里被改写，项目只覆盖模型、权限和当前状态。</p>
        </div>
        <button type="button" onClick={props.onRefresh}>刷新团队</button>
      </header>
      <div className="team-layout">
        <section className="team-roster">
          {props.profiles.map((profile) => (
            <button
              key={profile.id}
              type="button"
              className={profile.id === props.selectedId ? "team-member selected" : "team-member"}
              onClick={() => props.onSelect(profile.id)}
            >
              <span className="profile-avatar">{profile.identity.avatar}</span>
              <strong>{profile.identity.title}</strong>
              <small>{profile.identity.subtitle}</small>
              <em>{profile.statusLabel}</em>
            </button>
          ))}
        </section>
        <AgentDetailPanel
          profile={props.selectedProfile}
          draft={props.selectedDraft}
          modelConfigs={props.modelConfigs}
          onDraftChange={props.onDraftChange}
          onSave={props.onSave}
        />
      </div>
    </section>
  );
}

function AgentDetailPanel(props: {
  profile?: AgentProfileView;
  draft?: WorkspaceAgentConfig;
  modelConfigs: ModelConfig[];
  onDraftChange: (agent: WorkspaceAgentConfig) => void;
  onSave: (agent: WorkspaceAgentConfig) => void;
}) {
  if (!props.profile) {
    return <aside className="agent-detail-panel empty-state">创建或选择项目后会生成项目团队。</aside>;
  }

  const draft = props.draft;
  const policy = normalizePolicy(draft?.policyOverride ?? props.profile.policy);
  const modelTarget = { provider: draft?.provider ?? props.profile.model.provider, model: draft?.model ?? props.profile.model.modelName };
  const modelOptions = modelSelectionOptions(modelTarget, props.modelConfigs);
  const selectedModelValue = modelSelectionValue(modelTarget, props.modelConfigs);
  const role = draft?.roleInWorkspace;
  const configuredTools = new Set(policy.enabledTools ?? []);
  const effectiveTools = new Set(toolsForPolicy(policy).map((tool) => tool.name));
  const setToolEnabled = (toolName: WorkspaceToolName, enabled: boolean) => {
    if (!draft || !role) return;
    const current = new Set(policy.enabledTools ?? []);
    if (enabled) current.add(toolName);
    else current.delete(toolName);
    props.onDraftChange({
      ...draft,
      policyOverride: {
        ...policy,
        ...(enabled ? permissionPatchForTool(toolName) : {}),
        enabledTools: Array.from(current)
      }
    });
  };
  return (
    <aside className="agent-detail-panel">
      <header className="agent-hero">
        <span className="profile-avatar large">{props.profile.identity.avatar}</span>
        <div>
          <h3>{props.profile.identity.title}</h3>
          <p>{props.profile.identity.subtitle}</p>
          <small>{props.profile.identity.scope}</small>
        </div>
      </header>

      <section className="agent-section">
        <h4>灵魂特质</h4>
        <p>{props.profile.soul}</p>
      </section>

      <section className="agent-section">
        <h4>岗位契约</h4>
        <p>{props.profile.identity.title}是当前项目团队里的{props.profile.identity.subtitle}智能体。</p>
      </section>

      <section className="agent-section">
        <h4>能力手册</h4>
        <pre className="agent-md-preview">{props.profile.agentMd}</pre>
      </section>

      <section className="agent-section">
        <h4>工具权限</h4>
        <div className="tool-list">
          {props.profile.toolGroups.map((tool) => (
            <span key={tool.label} className={tool.enabled ? "tool-pill enabled" : "tool-pill"}>
              {tool.label}：{tool.description}
            </span>
          ))}
        </div>
      </section>

      <section className="agent-section">
        <h4>记忆与状态</h4>
        <p>{props.profile.memory.sessionLabel}，{props.profile.memory.workspaceLabel}</p>
        <code>{props.profile.memory.statePath}</code>
      </section>

      <section className="agent-section runtime-config">
        <h4>模型与项目权限</h4>
        {draft ? (
          <>
            <div className="runtime-fields">
              <label>
                <span>模型配置</span>
                <select
                  value={selectedModelValue}
                  onChange={(event) => {
                    const next = applyModelSelection(event.target.value, props.modelConfigs, modelTarget);
                    props.onDraftChange({ ...draft, provider: next.provider, model: next.model });
                  }}
                >
                  {modelOptions.map((option) => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                  ))}
                </select>
              </label>
              <label>
                <span>模型</span>
                <input value={draft.model ?? ""} onChange={(event) => props.onDraftChange({ ...draft, model: event.target.value })} />
              </label>
            </div>
            <div className="policy-grid">
              <Toggle label="读项目" checked={policy.canReadWorkspace} onChange={(checked) => props.onDraftChange({ ...draft, policyOverride: { ...policy, canReadWorkspace: checked } })} />
              <Toggle label="写项目" checked={policy.canWriteWorkspace} onChange={(checked) => props.onDraftChange({ ...draft, policyOverride: { ...policy, canWriteWorkspace: checked } })} />
              <Toggle label="执行命令" checked={policy.canExecuteCommands} onChange={(checked) => props.onDraftChange({ ...draft, policyOverride: { ...policy, canExecuteCommands: checked } })} />
              <Toggle label="访问本机" checked={Boolean(policy.allowHostAccess)} onChange={(checked) => props.onDraftChange({ ...draft, policyOverride: { ...policy, allowHostAccess: checked } })} />
            </div>
            <div className="tool-config-grid">
              {TOOL_CATALOG.map((tool) => (
                <Toggle
                  key={tool.name}
                  label={tool.label}
                  checked={configuredTools.has(tool.name) && effectiveTools.has(tool.name)}
                  onChange={(checked) => setToolEnabled(tool.name, checked)}
                />
              ))}
            </div>
            <button type="button" onClick={() => props.onSave(draft)}>保存项目覆盖</button>
          </>
        ) : (
          <p>团队配置加载后可编辑项目级覆盖。</p>
        )}
      </section>
    </aside>
  );
}

function ModelConfigLibrary(props: {
  configs: ModelConfig[];
  draft: ModelConfigDraft;
  onDraftChange: (draft: ModelConfigDraft) => void;
  onAdd: () => void;
  onRefresh: () => void;
  onChange: (config: ModelConfig) => void;
  onSave: (config: ModelConfig) => void;
  onSetDefault: (configId: string) => void;
}) {
  return (
    <section className="management-panel model-config-library">
      <header className="management-header">
        <div>
          <h2>模型配置库</h2>
          <p>添加多个模型服务配置，给每个配置命名，并指定团队默认模型。默认配置会作为未特别指定时的优先选择。</p>
        </div>
        <button type="button" onClick={props.onRefresh}>刷新配置</button>
      </header>

      <section className="config-card model-create-card">
        <header>
          <strong>添加模型配置</strong>
          <span>新增 OpenAI 或 Anthropic 配置</span>
        </header>
        <div className="runtime-fields">
          <label>
            <span>配置名称</span>
            <input value={props.draft.name} onChange={(event) => props.onDraftChange({ ...props.draft, name: event.target.value })} placeholder="例如：OpenAI 主账号" />
          </label>
          <label>
            <span>服务商</span>
            <select value={props.draft.provider} onChange={(event) => props.onDraftChange({ ...props.draft, provider: event.target.value as RealProviderName })}>
              <option value="openai">OpenAI</option>
              <option value="anthropic">Anthropic</option>
            </select>
          </label>
          <label>
            <span>模型</span>
            <input value={props.draft.model} onChange={(event) => props.onDraftChange({ ...props.draft, model: event.target.value })} placeholder="例如：gpt-4.1" />
          </label>
        </div>
        <div className="runtime-fields">
          <label>
            <span>接口密钥</span>
            <input type="password" value={props.draft.apiKey} onChange={(event) => props.onDraftChange({ ...props.draft, apiKey: event.target.value })} placeholder="保存后只显示已配置" />
          </label>
          <label>
            <span>服务地址</span>
            <input value={props.draft.baseUrl} onChange={(event) => props.onDraftChange({ ...props.draft, baseUrl: event.target.value })} placeholder="可选，自定义网关地址" />
          </label>
        </div>
        <button type="button" onClick={props.onAdd}>添加配置</button>
      </section>

      <div className="provider-grid">
        {props.configs.map((config) => (
          <ModelConfigCard
            key={config.id}
            config={config}
            onChange={props.onChange}
            onSave={props.onSave}
            onSetDefault={props.onSetDefault}
          />
        ))}
      </div>
    </section>
  );
}

function ModelConfigCard(props: {
  config: ModelConfig;
  onChange: (config: ModelConfig) => void;
  onSave: (config: ModelConfig) => void;
  onSetDefault: (configId: string) => void;
}) {
  return (
    <article className="config-card">
      <header>
        <strong>{props.config.name}</strong>
        <span>{props.config.isDefault ? "默认配置" : "可选配置"}</span>
      </header>
      <label>
        <span>配置名称</span>
        <input value={props.config.name} onChange={(event) => props.onChange({ ...props.config, name: event.target.value })} />
      </label>
      <label>
        <span>服务商</span>
        <select value={props.config.provider} onChange={(event) => props.onChange({ ...props.config, provider: event.target.value as RealProviderName })}>
          <option value="openai">OpenAI</option>
          <option value="anthropic">Anthropic</option>
        </select>
      </label>
      <label>
        <span>模型</span>
        <input value={props.config.model} onChange={(event) => props.onChange({ ...props.config, model: event.target.value })} />
      </label>
      <label>
        <span>接口密钥</span>
        <input type="password" placeholder={props.config.apiKey ? "保留现有密钥" : "输入接口密钥"} onChange={(event) => props.onChange({ ...props.config, apiKey: event.target.value })} />
      </label>
      <label>
        <span>服务地址</span>
        <input value={props.config.baseUrl ?? ""} onChange={(event) => props.onChange({ ...props.config, baseUrl: event.target.value })} />
      </label>
      <div className="button-row">
        <button type="button" onClick={() => props.onSave(props.config)}>保存配置</button>
        <button type="button" disabled={props.config.isDefault} onClick={() => props.onSetDefault(props.config.id)}>设为默认</button>
      </div>
    </article>
  );
}

function Toggle(props: { label: string; checked: boolean; disabled?: boolean; onChange: (checked: boolean) => void }) {
  return (
    <label className="toggle-row">
      <input type="checkbox" checked={props.checked} disabled={props.disabled} onChange={(event) => props.onChange(event.target.checked)} />
      <span>{props.label}</span>
    </label>
  );
}

function normalizePolicy(policy: Partial<AgentPolicy> | undefined): Required<Pick<AgentPolicy, "canReadWorkspace" | "canWriteWorkspace" | "canExecuteCommands" | "allowHostAccess">> & { enabledTools?: WorkspaceToolName[] } {
  return {
    canReadWorkspace: Boolean(policy?.canReadWorkspace),
    canWriteWorkspace: Boolean(policy?.canWriteWorkspace),
    canExecuteCommands: Boolean(policy?.canExecuteCommands),
    enabledTools: policy?.enabledTools,
    allowHostAccess: Boolean(policy?.allowHostAccess)
  };
}

function mergeSnapshotAgents(snapshotAgents: WorkspaceSnapshot["agents"], configAgents: WorkspaceAgentConfig[]): WorkspaceSnapshot["agents"] {
  return snapshotAgents.map((agent) => {
    const configured = configAgents.find((item) => item.id === agent.id);
    return configured ? { ...agent, ...configured } : agent;
  });
}

function displayWorkspaceName(name: string): string {
  return name === "Demo workspace" ? "演示项目" : name;
}

function initials(label: string): string {
  return label.split(/\s+/).map((part) => part[0]).join("").slice(0, 2).toUpperCase();
}
