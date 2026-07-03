import { useEffect, useMemo, useRef, useState } from "react";
import type { AgentPolicy, AgentProfile, AutoAgentEvent, LoopDebugEntry, LoopDebugLog, ModelConfig, ProviderName, Workspace, WorkspaceSnapshot } from "../shared/types";
import { capabilityLabels, displayText, phaseLabel, roleLabel, statusLabel } from "../shared/labels";
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
import { buildAgentCatalogProfiles, buildAgentNodes, buildAgentProfiles, buildBlockedPanelCopy, buildHumanFlowPrompt, buildManualTestAction, taskControlMode, type AgentProfileView } from "./view-model";
import { buildEventTimelineItem, buildVisibleTimelineEvents } from "./event-view-model";
import { buildAgentMessageView } from "./agent-message";
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
  const rightPanelScrollKey = useMemo(() => {
    if (rightPanelView === "events") return visibleEvents.map((event) => event.id).join("|");
    return ticketItems.map((ticket) => `${ticket.id}:${ticket.status}`).join("|");
  }, [rightPanelView, ticketItems, visibleEvents]);

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
      setEvents((current) => [...current, event].slice(-80));
      void refreshSnapshot(selectedId);
    });
    source.onerror = () => setError("Live event stream disconnected");
    return () => source.close();
  }, [selectedId]);

  useEffect(() => {
    if (humanFlowPrompt?.agentId) setSelectedAgentId(humanFlowPrompt.agentId);
  }, [humanFlowPrompt?.agentId]);

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
    if (!selectedId || !goal.trim()) return;
    try {
      const taskId = snapshot?.activeTask?.id;
      const result = (mode === "running" || mode === "paused" || mode === "blocked") && taskId
        ? await sendTaskFollowup(selectedId, taskId, goal)
        : await startTask(selectedId, goal);
      setSnapshot(result.snapshot);
      setGoal("");
    } catch (err) {
      setError((err as Error).message);
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

  async function sendFollowupMessage(message: string) {
    const taskId = snapshot?.activeTask?.id;
    if (!selectedId || !taskId || !message.trim()) return;
    try {
      const result = await sendTaskFollowup(selectedId, taskId, message);
      setSnapshot(result.snapshot);
      setGoal("");
    } catch (err) {
      setError((err as Error).message);
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
  const taskInputLabel = hasActiveFlow ? "补充说明" : "项目目标";
  const taskInputPlaceholder = hasActiveFlow ? "写给当前团队的补充信息，会进入后续 Agent 上下文" : "描述这个项目要交给团队完成的目标";
  const taskSubmitLabel = hasActiveFlow ? "发送给团队" : mode === "terminal" ? "重新开始" : "开始";
  const taskSubmitDisabled = !selectedId || !goal.trim();
  const suggestedFollowup = humanFlowPrompt?.suggestion ?? "";
  const blockedPanelCopy = buildBlockedPanelCopy(snapshot);
  const primaryPanelTitle = mode === "blocked"
    ? "任务控制"
    : mode === "terminal"
      ? "任务已结束，重新描述目标"
      : hasActiveFlow
      ? "给团队补充上下文"
      : "描述这个项目要交给团队完成的目标";
  const selectedAgentNeedsReply = Boolean(humanFlowPrompt && selectedAgent?.id === humanFlowPrompt.agentId);

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
        <strong className={`status-pill ${snapshot?.status ?? "idle"}`}>{statusLabel(snapshot?.status ?? "idle")}</strong>
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
          style={view === "run" ? { gridTemplateColumns: `${runLayoutWidths.task}px 8px minmax(360px, 1fr) 8px ${runLayoutWidths.events}px` } : undefined}
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
                <textarea value={goal} onChange={(event) => setGoal(event.target.value)} placeholder={taskInputPlaceholder} />
              </label>
              <button type="submit" disabled={taskSubmitDisabled}>{taskSubmitLabel}</button>
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
                  title={node.currentStep ?? statusLabel(node.status)}
                >
                  <span className="avatar">{initials(node.label)}</span>
                  {node.needsAttention ? <span className="attention-badge">!</span> : null}
                  <strong>{node.label}</strong>
                  <small>{node.currentStep ?? statusLabel(node.status)}</small>
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
            <div className={selectedAgentNeedsReply ? "agent-detail chat-mode" : "agent-detail"}>
              {selectedAgentNeedsReply && humanFlowPrompt ? (
                <AgentHumanLoopBox
                  agentName={selectedAgent ? roleLabel(selectedAgent.roleInWorkspace) : humanFlowPrompt.waiter}
                  prompt={humanFlowPrompt}
                  value={goal}
                  disabled={taskSubmitDisabled}
                  actionDisabled={!selectedId || !snapshot?.activeTask}
                  onChange={setGoal}
                  onUseSuggestion={() => setGoal(suggestedFollowup)}
                  onFollowup={(message) => void sendFollowupMessage(message)}
                  onSubmit={submitTask}
                />
              ) : (
                <>
                  <strong>{selectedAgent ? roleLabel(selectedAgent.roleInWorkspace) : "未选择成员"}</strong>
                  <span>{selectedAgent ? roleLabel(selectedAgent.roleInWorkspace) : "空闲"}</span>
                  <p>{(displayText(selectedAgent?.currentStep) ?? (selectedAgent ? capabilityLabels(selectedAgent.roleInWorkspace, selectedAgent.capabilities).join("、") : "")) || "创建项目后会生成固定团队。"}</p>
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
                visibleEvents.map((event) => (
                  <EventTimelineCard key={event.id} event={event} debugLog={loopDebugLog} />
                ))
              ) : (
                <TicketInspector items={ticketItems} onShowRaw={setRawTicketDialog} />
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
  const item = buildEventTimelineItem(props.event);
  const loopEntries = relatedLoopEntries(props.event, item.actor, props.debugLog);
  const payload = JSON.stringify(props.event.payload ?? {}, null, 2);
  return (
    <details className={`event-item ${item.tone}`} title={item.debugType}>
      <summary>
        <span className="event-actor">{item.actor}</span>
        <strong className="event-title">{item.title}</strong>
        {item.detail ? <small className="event-detail">{item.detail}</small> : null}
      </summary>
      <div className="event-debug-body">
        {loopEntries.map((entry) => (
          <DebugBlock key={entry.id} title={debugKindLabel(entry.kind)} subtitle={entry.detail} content={entry.content} kind={entry.kind} />
        ))}
        <DebugBlock title="事件原始数据" subtitle={props.event.type} content={payload} kind="flow" />
      </div>
    </details>
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
  value: string;
  disabled: boolean;
  actionDisabled: boolean;
  onChange: (value: string) => void;
  onUseSuggestion: () => void;
  onFollowup: (message: string) => void;
  onSubmit: (event: React.FormEvent) => void;
}) {
  const messageBody = props.prompt.transcript.replace(/^[^\n]+:\n/, "");
  return (
    <form className="agent-chat" onSubmit={props.onSubmit}>
      <header className="agent-chat-header">
        <span className="chat-avatar">{initials(props.agentName)}</span>
        <div>
          <strong>{props.agentName} 对话</strong>
          <small>{props.prompt.title} · {props.prompt.phase}</small>
        </div>
      </header>
      <div className="chat-thread">
        <article className="chat-message agent">
          {props.prompt.manualTest ? (
            <ManualTestActionCard
              action={props.prompt.manualTest}
              disabled={props.actionDisabled}
              onFollowup={props.onFollowup}
            />
          ) : (
            <AgentMessageBody rawText={messageBody} />
          )}
        </article>
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
  const modelTarget = { provider: props.profile.defaultProvider, model: props.profile.defaultModel };
  const modelOptions = modelSelectionOptions(modelTarget, props.modelConfigs);
  const selectedModelValue = modelSelectionValue(modelTarget, props.modelConfigs);
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

function Toggle(props: { label: string; checked: boolean; onChange: (checked: boolean) => void }) {
  return (
    <label className="toggle-row">
      <input type="checkbox" checked={props.checked} onChange={(event) => props.onChange(event.target.checked)} />
      <span>{props.label}</span>
    </label>
  );
}

function normalizePolicy(policy: Partial<AgentPolicy> | undefined): Required<Pick<AgentPolicy, "canReadWorkspace" | "canWriteWorkspace" | "canExecuteCommands" | "allowHostAccess">> {
  return {
    canReadWorkspace: Boolean(policy?.canReadWorkspace),
    canWriteWorkspace: Boolean(policy?.canWriteWorkspace),
    canExecuteCommands: Boolean(policy?.canExecuteCommands),
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
