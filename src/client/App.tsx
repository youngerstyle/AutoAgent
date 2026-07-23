import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  Building2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleStop,
  ClipboardList,
  Code2,
  Crown,
  Cpu,
  DraftingCompass,
  FolderKanban,
  ImagePlus,
  Pause,
  Play,
  Search,
  Send,
  ShieldCheck,
  UserRound,
  Users,
  X,
  type LucideIcon,
} from "lucide-react";
import type { AgentPolicy, AgentProfile, AutoAgentEvent, LoopDebugEntry, LoopDebugLog, ModelConfig, ProviderName, Workspace, WorkspaceSnapshot, WorkspaceToolName } from "../shared/types";
import { DEFAULT_MODEL_CONTEXT_WINDOW_TOKENS } from "../shared/model-context";
import { capabilityLabels, displayText, phaseLabel, roleLabel, statusLabel } from "../shared/labels";
import { permissionPatchForTool, TOOL_CATALOG, toolsForPolicy } from "../shared/tool-catalog";
import { paginateTeamDirectory } from "./team-directory";
import {
  createModelConfig,
  createWorkspace,
  deleteWorkspace,
  getLoopDebugLog,
  getSnapshot,
  listAgentProfiles,
  listAvailableSkills,
  listAgents,
  listModelConfigs,
  listWorkspaces,
  pauseTask,
  resumeTask,
  agentProfileUpdateInput,
  sendAgentMessage,
  sendTaskFollowup,
  setDefaultModelConfig,
  startTask,
  stopTask,
  updateAgent,
  updateAgentProfile,
  updateModelConfig,
  uploadAttachment,
  type AvailableSkill,
  type WorkspaceAgentConfig,
} from "./api";
import { agentProfileCardSummary } from "./agent-profile-card";
import { applyModelSelection, modelSelectionOptions, modelSelectionValue } from "./model-selection";
import { buildAgentCatalogProfiles, buildAgentNodes, buildAgentProfiles, buildBlockedPanelCopy, buildHumanFlowPrompt, buildManualTestAction, buildTaskSubmitView, taskControlMode, type AgentNodeView, type AgentProfileView } from "./view-model";
import { buildEventTimelineGroups, buildEventTimelineItem, buildVisibleTimelineEvents, type EventTimelineGroup } from "./event-view-model";
import { buildAgentMessageView } from "./agent-message";
import {
  appendCurrentAgentPrompt,
  beginChatSubmission,
  buildAgentThreadBubbles,
  chatComposerKeyAction,
  scrollChatThreadToLatest,
  type AgentThreadBubble,
} from "./agent-thread";
import { buildTicketInspectorItems, type TicketInspectorItem } from "./ticket-inspector";

const LIVE_EVENT_BUFFER_LIMIT = 80;
const TEAM_DIRECTORY_PAGE_SIZE = 10;

type AppView = "office" | "projects" | "people" | "providers" | "operations";

type RealProviderName = Exclude<ProviderName, "mock">;

function beginConversationDrag(event: React.PointerEvent<HTMLDivElement>) {
  if (event.button !== 0 || window.matchMedia("(max-width: 720px)").matches) return;
  const handle = event.currentTarget;
  const panel = handle.closest<HTMLElement>(".conversation-dock");
  const host = panel?.offsetParent as HTMLElement | null;
  if (!panel || !host) return;

  const panelRect = panel.getBoundingClientRect();
  const hostRect = host.getBoundingClientRect();
  const startX = event.clientX;
  const startY = event.clientY;
  const initialLeft = panelRect.left - hostRect.left;
  const initialTop = panelRect.top - hostRect.top;
  const margin = 10;

  handle.setPointerCapture(event.pointerId);
  panel.classList.add("dragging");

  const move = (pointerEvent: PointerEvent) => {
    const maxLeft = Math.max(margin, host.clientWidth - panel.offsetWidth - margin);
    const maxTop = Math.max(margin, host.clientHeight - panel.offsetHeight - margin);
    const left = Math.min(maxLeft, Math.max(margin, initialLeft + pointerEvent.clientX - startX));
    const top = Math.min(maxTop, Math.max(margin, initialTop + pointerEvent.clientY - startY));
    panel.style.left = `${left}px`;
    panel.style.top = `${top}px`;
    panel.style.right = "auto";
    panel.style.bottom = "auto";
  };

  const finish = () => {
    panel.classList.remove("dragging");
    handle.removeEventListener("pointermove", move);
    handle.removeEventListener("pointerup", finish);
    handle.removeEventListener("pointercancel", finish);
  };

  handle.addEventListener("pointermove", move);
  handle.addEventListener("pointerup", finish);
  handle.addEventListener("pointercancel", finish);
}

type ModelConfigDraft = Pick<ModelConfig, "name" | "model"> & {
  provider: RealProviderName;
  apiKey: string;
  baseUrl: string;
  contextWindowTokens: number;
  supportsReasoning: boolean;
  supportsImages: boolean;
  thinkingLevel: ModelConfig["thinkingLevel"];
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
  const [agentMessageFiles, setAgentMessageFiles] = useState<File[]>([]);
  const [workspaceForm, setWorkspaceForm] = useState({ name: "演示项目", rootPath: "", policyProfile: "production" as Workspace["policyProfile"] });
  const [selectedAgentId, setSelectedAgentId] = useState<string>("");
  const [selectedProfileId, setSelectedProfileId] = useState<string>("");
  const [view, setView] = useState<AppView>("office");
  const [rightPanelView, setRightPanelView] = useState<"events" | "tickets">("events");
  const [rawTicketDialog, setRawTicketDialog] = useState<TicketInspectorItem>();
  const [loopDebugLog, setLoopDebugLog] = useState<LoopDebugLog>({ entries: [] });
  const [agents, setAgents] = useState<WorkspaceAgentConfig[]>([]);
  const [agentProfiles, setAgentProfiles] = useState<AgentProfile[]>([]);
  const [availableSkills, setAvailableSkills] = useState<AvailableSkill[]>([]);
  const [modelConfigs, setModelConfigs] = useState<ModelConfig[]>([]);
  const [modelConfigDraft, setModelConfigDraft] = useState<ModelConfigDraft>({
    name: "",
    provider: "openai",
    model: "",
    apiKey: "",
    baseUrl: "",
    contextWindowTokens: DEFAULT_MODEL_CONTEXT_WINDOW_TOKENS,
    supportsReasoning: false,
    supportsImages: false,
    thinkingLevel: "off",
  });
  const [error, setError] = useState("");
  const [taskSubmitting, setTaskSubmitting] = useState(false);
  const [agentMessageSubmitting, setAgentMessageSubmitting] = useState(false);
  const [deleteDialog, setDeleteDialog] = useState<DeleteWorkspaceDialogState>();
  const rightPanelRef = useRef<HTMLElement | null>(null);
  const selectedWorkspaceIdRef = useRef(selectedId);
  const selectedAgentIdRef = useRef(selectedAgentId);
  selectedWorkspaceIdRef.current = selectedId;
  selectedAgentIdRef.current = selectedAgentId;
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
    void refreshAvailableSkills();
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

  async function refreshAvailableSkills() {
    try {
      const result = await listAvailableSkills();
      setAvailableSkills(result.skills);
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

  async function saveAgent(agent: WorkspaceAgentConfig) {
    if (!selectedId) return;
    try {
      await updateAgent(selectedId, agent.id, {
        provider: agent.provider ?? "mock",
        model: agent.model ?? "",
        skillOverrides: agent.skillOverrides ?? null,
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
    const submission = beginChatSubmission(message);
    const text = submission.message;
    if (!selectedId || !taskId || !agentId || (!text && agentMessageFiles.length === 0) || agentMessageSubmitting) return;
    if (snapshot?.status === "completed" || snapshot?.status === "failed" || snapshot?.status === "interrupted") return;
    setAgentMessage(submission.nextDraft);
    setAgentMessageSubmitting(true);
    try {
      const attachments = await Promise.all(agentMessageFiles.map(async (file) => (await uploadAttachment(selectedId, file)).attachment));
      const result = await sendAgentMessage(selectedId, taskId, agentId, text, attachments);
      setSnapshot(result.snapshot);
      setAgentMessageFiles([]);
      setError("");
    } catch (err) {
      if (selectedWorkspaceIdRef.current === selectedId
        && (selectedAgentIdRef.current || snapshot?.agents[0]?.id) === agentId) {
        setAgentMessage((current) => current || message);
      }
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
        baseUrl: modelConfigDraft.baseUrl,
        contextWindowTokens: modelConfigDraft.contextWindowTokens,
        supportsReasoning: modelConfigDraft.supportsReasoning,
        supportsImages: modelConfigDraft.supportsImages,
        thinkingLevel: modelConfigDraft.supportsReasoning ? modelConfigDraft.thinkingLevel : "off"
      });
      setModelConfigs((current) => [...current, result.config]);
      setModelConfigDraft({ name: "", provider: modelConfigDraft.provider, model: "", apiKey: "", baseUrl: "", contextWindowTokens: DEFAULT_MODEL_CONTEXT_WINDOW_TOKENS, supportsReasoning: false, supportsImages: false, thinkingLevel: "off" });
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
        baseUrl: config.baseUrl,
        contextWindowTokens: config.contextWindowTokens,
        supportsReasoning: config.supportsReasoning,
        supportsImages: config.supportsImages,
        thinkingLevel: config.supportsReasoning ? config.thinkingLevel : "off"
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
      const result = await updateAgentProfile(profile.id, agentProfileUpdateInput(profile));
      setAgentProfiles((current) => current.map((item) => item.id === result.profile.id ? result.profile : item));
      setError("");
    } catch (err) {
      setError((err as Error).message);
    }
  }

  const selectedAgent = snapshot?.agents.find((agent) => agent.id === selectedAgentId);
  const selectedProfile = profiles.find((profile) => profile.id === selectedAgentId) ?? profiles[0];
  const selectedDraft = selectedProfile ? agents.find((agent) => agent.id === selectedProfile.id) : undefined;
  const selectedCatalogProfile = catalogProfiles.find((profile) => profile.id === selectedProfileId) ?? catalogProfiles[0];
  const selectedCatalogDefinition = agentProfiles.find((profile) => profile.id === selectedCatalogProfile?.id) ?? agentProfiles[0];
  const hasActiveFlow = mode === "running" || mode === "paused" || mode === "blocked";
  const taskInputLabel = hasActiveFlow ? "全局补充" : "项目目标";
  const taskInputPlaceholder = hasActiveFlow ? "写给当前团队的补充信息，会进入后续智能体上下文；和单个智能体沟通请点击对应头像" : "描述这个项目要交给团队完成的目标";
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
  const agentMessageDisabled = agentMessageSubmitting || taskIsTerminal || !selectedId || !snapshot?.activeTask || !selectedAgent || (!agentMessage.trim() && agentMessageFiles.length === 0);
  const agentActionDisabled = agentMessageSubmitting || taskIsTerminal || !selectedId || !snapshot?.activeTask || !selectedAgent;

  const currentWorkspace = workspaces.find((workspace) => workspace.id === selectedId);
  const completedTicketCount = snapshot?.tickets?.filter((ticket) => ticket.status === "completed").length ?? 0;

  return (
    <main className="hq-shell">
      <aside className="hq-rail" aria-label="TEAMHQ 主导航">
        <button className="hq-logo" type="button" onClick={() => setView("office")} aria-label="TEAMHQ 办公室">T</button>
        <nav>
          <button className={view === "office" ? "selected" : ""} onClick={() => setView("office")} title="办公室">
            <Building2 size={20} /><span>办公室</span>
          </button>
          <button className={view === "projects" ? "selected" : ""} onClick={() => setView("projects")} title="项目">
            <FolderKanban size={20} /><span>项目</span>
          </button>
          <button className={view === "people" ? "selected" : ""} onClick={() => setView("people")} title="人才中心">
            <Users size={20} /><span>人才</span>
          </button>
          <button className={view === "providers" ? "selected" : ""} onClick={() => setView("providers")} title="模型服务">
            <Cpu size={20} /><span>模型</span>
          </button>
          <button className={view === "operations" ? "selected" : ""} onClick={() => setView("operations")} title="系统运营">
            <Activity size={20} /><span>运营</span>
          </button>
        </nav>
        <div className={`rail-health ${displayedStatus}`} title={statusLabel(displayedStatus)}>
          <span /><small>{statusLabel(displayedStatus)}</small>
        </div>
      </aside>

      <section className="hq-stage">
        <header className="hq-context-bar">
          <div className="context-project">
            <span className="context-label">当前项目</span>
            <label>
              <select value={selectedId} onChange={(event) => setSelectedId(event.target.value)} aria-label="切换当前项目">
                {workspaces.map((workspace) => (
                  <option key={workspace.id} value={workspace.id}>{displayWorkspaceName(workspace.name)}</option>
                ))}
              </select>
              <ChevronDown size={15} />
            </label>
          </div>
          <div className="context-mission">
            <span>{snapshot?.activeTask ? "当前任务" : "团队工作空间"}</span>
            <strong>{snapshot?.activeTask?.title ?? "发布目标，让团队开始工作"}</strong>
          </div>
          <div className="context-status">
            <span className={`live-indicator ${displayedStatus}`} />
            <div><small>{phaseLabel(snapshot?.phase ?? "idle")}</small><strong>{statusLabel(displayedStatus)}</strong></div>
          </div>
        </header>

        <section className={view === "office" ? `office-view ${selectedAgent ? "chat-open" : ""}` : "management-region"}>
          {view === "office" ? (
            <>
              <section className="mission-brief">
                <div className="mission-brief-title">
                  <span className="section-kicker">任务控制</span>
                  <h2>{primaryPanelTitle}</h2>
                  <p>{mode === "blocked" ? blockedPanelCopy.hint : currentWorkspace?.rootPath ?? "先创建项目，再发布第一条任务。"}</p>
                </div>
                <div className="mission-progress" aria-label="工单完成进度">
                  <div><span>计划</span><strong>{snapshot?.mission ? `v${snapshot.mission.planVersion}` : "—"}</strong></div>
                  <div><span>工单</span><strong>{completedTicketCount}/{ticketItems.length}</strong></div>
                  <div><span>成员</span><strong>{nodes.length}</strong></div>
                </div>
                <form className="mission-command" onSubmit={submitTask}>
                  <textarea value={goal} onChange={(event) => setGoal(event.target.value)} placeholder={taskInputPlaceholder} disabled={taskSubmitting} aria-label={taskInputLabel} />
                  <button type="submit" className="mission-send" disabled={taskSubmitView.disabled} title={taskSubmitView.label}>
                    <Send size={17} /><span>{taskSubmitView.label}</span>
                  </button>
                </form>
                <div className="mission-controls">
                  <button type="button" onClick={() => void control("pause")} disabled={mode !== "running"} title="暂停任务"><Pause size={16} /></button>
                  <button type="button" onClick={() => void control("resume")} disabled={mode !== "paused" && mode !== "blocked"} title="继续任务"><Play size={16} /></button>
                  <button type="button" onClick={() => void control("stop")} disabled={mode !== "running" && mode !== "paused" && mode !== "blocked"} title="停止任务"><CircleStop size={16} /></button>
                </div>
                {snapshot?.readOnlyReason ? <p className="error-text">{snapshot.readOnlyReason}</p> : null}
                {error ? <p className="error-text">{error}</p> : null}
              </section>

              <section className="office-main">
                <div className="office-floor">
                  <div className="floor-heading">
                    <div><span>团队办公室</span><strong>{displayWorkspaceName(currentWorkspace?.name ?? "办公室")}</strong></div>
                    <div className="floor-legend"><span className="online" />运行中 <span className="attention" />需要你 <span className="offline" />空闲</div>
                  </div>
                  <div className="team-canvas">
                    <div className="office-ambient" aria-hidden="true">
                      <span className="ambient-label ambient-lounge">休息区</span>
                      <span className="ambient-label ambient-meeting">协作桌</span>
                      <span className="ambient-label ambient-coffee">咖啡角</span>
                    </div>
                    {nodes.map((node) => (
                      <AgentStation
                        key={node.id}
                        node={node}
                        selected={selectedAgentId === node.id}
                        onSelect={() => setSelectedAgentId(node.id)}
                      />
                    ))}
                  </div>
                </div>

                <aside className="activity-panel" ref={rightPanelRef}>
                  <header>
                    <div><span className="section-kicker">实时动态</span><h2>工作动态</h2></div>
                    <div className="activity-tabs" role="tablist" aria-label="办公室动态视图">
                      <button type="button" role="tab" aria-selected={rightPanelView === "events"} className={rightPanelView === "events" ? "selected" : ""} onClick={() => setRightPanelView("events")} title="运行记录">
                        <Activity size={16} />
                      </button>
                      <button type="button" role="tab" aria-selected={rightPanelView === "tickets"} className={rightPanelView === "tickets" ? "selected" : ""} onClick={() => setRightPanelView("tickets")} title="原始工单">
                        <FolderKanban size={16} />
                      </button>
                    </div>
                  </header>
                  <div className="activity-content">
                    {rightPanelView === "events" ? (
                      eventGroups.map((group) => <EventTimelineGroupCard key={group.id} group={group} debugLog={loopDebugLog} />)
                    ) : (
                      <TicketInspector items={ticketItems} onShowRaw={setRawTicketDialog} />
                    )}
                  </div>
                </aside>
              </section>

              {selectedAgent ? (
              <section className="conversation-dock open" role="dialog" aria-label={`${roleLabel(selectedAgent.roleInWorkspace)} 对话`}>
                <div
                  className="conversation-drag-surface"
                  title="拖动对话窗口"
                  aria-label="拖动对话窗口"
                  onPointerDown={beginConversationDrag}
                />
                <button
                  type="button"
                  className="conversation-close"
                  aria-label="关闭对话"
                  title="关闭对话"
                  onClick={() => setSelectedAgentId("")}
                >
                  <X size={17} />
                </button>
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
                      files={agentMessageFiles}
                      workspaceId={selectedId}
                      onFilesChange={setAgentMessageFiles}
                      onUseSuggestion={() => setAgentMessage(suggestedFollowup)}
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
                      files={agentMessageFiles}
                      workspaceId={selectedId}
                      onFilesChange={setAgentMessageFiles}
                      onSend={(message) => void sendSelectedAgentMessage(message)}
                    />
                  ) : null}
                </div>
              </section>
              ) : null}
            </>
          ) : null}

          {view === "people" ? (
            <AgentHub
              profileViews={catalogProfiles}
              profiles={agentProfiles}
              modelConfigs={modelConfigs}
              availableSkills={availableSkills}
              selectedId={selectedCatalogDefinition?.id}
              onSelect={setSelectedProfileId}
              onProfileChange={(next) => setAgentProfiles((current) => current.map((item) => item.id === next.id ? next : item))}
              onSave={(profile) => void saveAgentProfile(profile)}
            />
          ) : null}

          {view === "projects" ? (
            <ProjectsHub
              workspaces={workspaces}
              selectedId={selectedId}
              workspaceForm={workspaceForm}
              snapshot={snapshot}
              profiles={profiles}
              profileDefinitions={agentProfiles}
              modelConfigs={modelConfigs}
              availableSkills={availableSkills}
              selectedAgentId={selectedProfile?.id}
              selectedProfile={selectedProfile}
              selectedDraft={selectedDraft}
              onWorkspaceFormChange={setWorkspaceForm}
              onCreateWorkspace={submitWorkspace}
              onSelectWorkspace={setSelectedId}
              onDeleteWorkspace={(workspace) => setDeleteDialog({ workspace, deleteLocalFolder: false, busy: false })}
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

          {view === "operations" ? (
            <OperationsHub
              workspaces={workspaces}
              snapshot={snapshot}
              events={events}
              ticketCount={ticketItems.length}
              onOpenOffice={() => setView("office")}
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
          <p>你正在删除 TEAMHQ 里的项目：{workspaceName}</p>
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
            : "默认只从 TEAMHQ 项目列表移除，不删除本地文件夹。"}
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

const AGENT_ROLE_ICONS: Record<string, LucideIcon> = {
  boss: Crown,
  pm: ClipboardList,
  architect: DraftingCompass,
  dev: Code2,
  specialist: UserRound,
  qa: ShieldCheck,
};

function AgentStation(props: {
  node: AgentNodeView;
  selected: boolean;
  onSelect: () => void;
}) {
  const Icon = AGENT_ROLE_ICONS[props.node.role] ?? UserRound;
  const stateClass = props.node.active ? "active" : props.node.needsAttention ? "needs-attention" : props.node.status;
  const stateCopy = props.node.needsAttention
    ? "需要你回复"
    : props.node.currentStep ?? statusLabel(props.node.status);
  return (
    <button
      type="button"
      className={`agent-station ${stateClass} ${props.selected ? "selected" : ""}`}
      data-role={props.node.role}
      style={{ left: `${props.node.x}%`, top: `${props.node.y}%` }}
      onClick={props.onSelect}
      title={props.node.currentStepTitle ?? props.node.currentStep ?? statusLabel(props.node.status)}
    >
      <span className="agent-status-bubble">
        <strong>{props.node.label}</strong>
        <small>{stateCopy}</small>
      </span>
      <span className="agent-person" aria-hidden="true">
        <span className="agent-avatar"><Icon size={21} strokeWidth={1.8} /></span>
        <span className="agent-body" />
        <span className="agent-state-dot" />
      </span>
      {props.node.needsAttention ? <span className="attention-badge">!</span> : null}
    </button>
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
    </section>
  );
}

function useChatThreadAutoScroll(scrollKey: string) {
  const threadRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (threadRef.current) scrollChatThreadToLatest(threadRef.current);
  }, [scrollKey]);
  return threadRef;
}

function AgentThreadBubbleView({ bubble, workspaceId }: { bubble: AgentThreadBubble; workspaceId: string }) {
  if (bubble.collapsed) {
    return (
      <article className={`chat-message ${bubble.role} collapsed-message`}>
        <details className="thread-message-details">
          <summary>
            <span>
              <strong>{bubble.title ?? "辅助信息"}</strong>
              <small>{bubble.summary ?? "点击查看详情"}</small>
            </span>
          </summary>
          <div className="thread-message-detail-body">
            <AgentMessageBody rawText={bubble.body} />
          </div>
        </details>
      </article>
    );
  }
  return (
    <article className={`chat-message ${bubble.role}`}>
      {bubble.title ? <strong className="thread-bubble-title">{bubble.title}</strong> : null}
      {bubble.body ? <AgentMessageBody rawText={bubble.body} /> : null}
      {bubble.attachments?.length ? (
        <div className="chat-attachments">
          {bubble.attachments.map((attachment) => (
            <img
              key={attachment.attachmentId}
              src={`/api/workspaces/${encodeURIComponent(workspaceId)}/attachments/${attachment.attachmentId}`}
              alt={attachment.fileName}
            />
          ))}
        </div>
      ) : null}
    </article>
  );
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
  onSend: (message: string) => void;
  files: File[];
  workspaceId: string;
  onFilesChange: (files: File[]) => void;
}) {
  const messageBody = props.prompt.transcript.replace(/^[^\n]+:\n/, "");
  const bubbles = props.prompt.manualTest
    ? props.bubbles
    : appendCurrentAgentPrompt(props.bubbles, messageBody);
  const latestBubble = bubbles.at(-1);
  const threadRef = useChatThreadAutoScroll(`${props.agentName}:${bubbles.length}:${latestBubble?.id ?? "empty"}:${latestBubble?.body.length ?? 0}`);
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
      <div className="chat-thread" ref={threadRef}>
        {bubbles.map((bubble) => <AgentThreadBubbleView key={bubble.id} bubble={bubble} workspaceId={props.workspaceId} />)}
        {props.prompt.manualTest ? (
          <article className="chat-message agent">
            <ManualTestActionCard
              action={props.prompt.manualTest}
            />
          </article>
        ) : null}
      </div>
      {!props.prompt.manualTest ? (
        <button type="button" className="quick-reply" title={props.prompt.suggestion} onClick={props.onUseSuggestion}>使用建议方案</button>
      ) : null}
      <div className="chat-composer">
        <ChatAttachmentPicker files={props.files} onChange={props.onFilesChange} />
        {props.prompt.manualTest ? (
          <div className="manual-test-shortcuts" aria-label="人工测试快捷回复">
            <span>快捷回复</span>
            <button type="button" disabled={props.actionDisabled} onClick={() => props.onChange(props.prompt.manualTest?.passMessage ?? "")}>测试通过</button>
            <button type="button" disabled={props.actionDisabled} onClick={() => props.onChange(props.prompt.manualTest?.failMessage ?? "")}>测试不通过</button>
          </div>
        ) : null}
        <textarea
          aria-label={props.prompt.inputLabel}
          value={props.value}
          onChange={(event) => props.onChange(event.target.value)}
          onKeyDown={(event) => {
            const action = chatComposerKeyAction({
              key: event.key,
              shiftKey: event.shiftKey,
              isComposing: event.nativeEvent.isComposing,
            });
            if (action !== "submit") return;
            event.preventDefault();
            if (!props.disabled) props.onSend(props.value);
          }}
          placeholder={props.prompt.placeholder}
        />
        <button type="submit" className="chat-send-button" disabled={props.disabled} aria-label={props.prompt.submitLabel} title={props.prompt.submitLabel}>
          <Send size={18} />
        </button>
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
  files: File[];
  workspaceId: string;
  onFilesChange: (files: File[]) => void;
}) {
  const agentName = roleLabel(props.agent.roleInWorkspace);
  const statusText = props.agent.currentStep ?? capabilityLabels(props.agent.roleInWorkspace, props.agent.capabilities).join("、") ?? statusLabel(props.agent.status);
  const latestBubble = props.bubbles.at(-1);
  const threadRef = useChatThreadAutoScroll(`${props.agent.id}:${props.bubbles.length}:${latestBubble?.id ?? "empty"}:${latestBubble?.body.length ?? 0}`);
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
      <div className="chat-thread" ref={threadRef}>
        {props.bubbles.length > 0 ? props.bubbles.map((bubble) => (
          <AgentThreadBubbleView key={bubble.id} bubble={bubble} workspaceId={props.workspaceId} />
        )) : (
          <article className="chat-message agent">
            <p className="agent-plain-message">{statusText || "当前没有正在执行的步骤。你可以直接给这个智能体留补充信息。"}</p>
          </article>
        )}
      </div>
      <div className="chat-composer">
        <ChatAttachmentPicker files={props.files} onChange={props.onFilesChange} />
        <textarea
          aria-label={`回复${agentName}`}
          value={props.value}
          onChange={(event) => props.onChange(event.target.value)}
          onKeyDown={(event) => {
            const action = chatComposerKeyAction({
              key: event.key,
              shiftKey: event.shiftKey,
              isComposing: event.nativeEvent.isComposing,
            });
            if (action !== "submit") return;
            event.preventDefault();
            if (!props.disabled) props.onSend(props.value);
          }}
          placeholder={`回复${agentName}`}
        />
        <button type="submit" className="chat-send-button" disabled={props.disabled} aria-label={props.sending ? "发送中" : "发送"} title={props.sending ? "发送中" : "发送"}>
          <Send size={18} />
        </button>
      </div>
    </form>
  );
}

function ChatAttachmentPicker(props: { files: File[]; onChange: (files: File[]) => void }) {
  return (
    <div className="chat-attachment-picker">
      {props.files.map((file, index) => (
        <span className="pending-attachment" key={`${file.name}:${file.size}:${index}`}>
          <PendingImage file={file} />
          <button type="button" title="移除图片" onClick={() => props.onChange(props.files.filter((_, itemIndex) => itemIndex !== index))}>×</button>
        </span>
      ))}
      <label className="attachment-button">
        <input
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif"
          multiple
          onChange={(event) => {
            const next = Array.from(event.target.files ?? []);
            if (next.length) props.onChange([...props.files, ...next].slice(0, 4));
            event.target.value = "";
          }}
        />
        <ImagePlus size={17} />
        <span>图片</span>
      </label>
    </div>
  );
}

function PendingImage({ file }: { file: File }) {
  const url = useMemo(() => URL.createObjectURL(file), [file]);
  useEffect(() => () => URL.revokeObjectURL(url), [url]);
  return <img src={url} alt={file.name} />;
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
  availableSkills: AvailableSkill[];
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
          <span className="section-kicker">组织与能力</span>
          <h2>人才中心</h2>
          <p>管理长期存在的智能体员工档案：灵魂、身份、能力、默认技能、模型和工具权限。项目实例继承档案，并可显式覆盖。</p>
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
            availableSkills={props.availableSkills}
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
  availableSkills: AvailableSkill[];
  onChange: (profile: AgentProfile) => void;
  onSave: (profile: AgentProfile) => void;
}) {
  const [skillQuery, setSkillQuery] = useState("");
  const capabilitiesText = props.profile.capabilities.join("、");
  const policy = normalizePolicy(props.profile.defaultPolicy);
  const modelTarget = { provider: props.profile.defaultProvider, model: props.profile.defaultModel };
  const modelOptions = modelSelectionOptions(modelTarget, props.modelConfigs);
  const selectedModelValue = modelSelectionValue(modelTarget, props.modelConfigs);
  const configuredTools = new Set(policy.enabledTools ?? []);
  const effectiveTools = new Set(toolsForPolicy(policy).map((tool) => tool.name));
  const normalizedSkillQuery = skillQuery.trim().toLocaleLowerCase();
  const filteredSkills = normalizedSkillQuery
    ? props.availableSkills.filter((skill) => `${skill.name} ${skill.description}`.toLocaleLowerCase().includes(normalizedSkillQuery))
    : props.availableSkills;
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
        <input
          className="skill-search"
          aria-label="搜索技能"
          placeholder="搜索技能"
          value={skillQuery}
          onChange={(event) => setSkillQuery(event.target.value)}
        />
        <div className="skill-picker" aria-label="默认技能">
          {filteredSkills.length ? filteredSkills.map((skill) => {
            const checked = (props.profile.defaultSkills ?? []).includes(skill.name);
            return (
              <label key={skill.name} className="skill-option" title={skill.filePath}>
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={(event) => {
                    const next = new Set(props.profile.defaultSkills ?? []);
                    if (event.target.checked) next.add(skill.name);
                    else next.delete(skill.name);
                    props.onChange({ ...props.profile, defaultSkills: Array.from(next) });
                  }}
                />
                <span><strong>{skill.name}</strong><small>{skill.description}</small></span>
              </label>
            );
          }) : <small>{props.availableSkills.length ? "没有匹配的技能。" : "未发现可用技能。请在 ~/.agents/skills 中安装符合智能体技能规范的技能。"}</small>}
        </div>
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

function ProjectsHub(props: {
  workspaces: Workspace[];
  selectedId: string;
  workspaceForm: { name: string; rootPath: string; policyProfile: Workspace["policyProfile"] };
  snapshot?: WorkspaceSnapshot;
  profiles: AgentProfileView[];
  profileDefinitions: AgentProfile[];
  modelConfigs: ModelConfig[];
  availableSkills: AvailableSkill[];
  selectedAgentId?: string;
  selectedProfile?: AgentProfileView;
  selectedDraft?: WorkspaceAgentConfig;
  onWorkspaceFormChange: (form: { name: string; rootPath: string; policyProfile: Workspace["policyProfile"] }) => void;
  onCreateWorkspace: (event: React.FormEvent) => void;
  onSelectWorkspace: (id: string) => void;
  onDeleteWorkspace: (workspace: Workspace) => void;
  onSelect: (id: string) => void;
  onRefresh: () => void;
  onDraftChange: (agent: WorkspaceAgentConfig) => void;
  onSave: (agent: WorkspaceAgentConfig) => void;
}) {
  const selectedWorkspace = props.workspaces.find((workspace) => workspace.id === props.selectedId);
  const completedTickets = props.snapshot?.tickets?.filter((ticket) => ticket.status === "completed").length ?? 0;
  const totalTickets = props.snapshot?.tickets?.length ?? 0;

  return (
    <section className="projects-hub">
      <aside className="project-catalog">
        <header>
          <span className="section-kicker">项目目录</span>
          <h2>项目</h2>
          <p>项目空间是团队长期工作的边界。创建空项目后，再进入办公室发布任务。</p>
        </header>
        <form className="project-create-form" onSubmit={props.onCreateWorkspace}>
          <label>
            <span>项目名称</span>
            <input value={props.workspaceForm.name} onChange={(event) => props.onWorkspaceFormChange({ ...props.workspaceForm, name: event.target.value })} />
          </label>
          <label>
            <span>工作目录</span>
            <input value={props.workspaceForm.rootPath} onChange={(event) => props.onWorkspaceFormChange({ ...props.workspaceForm, rootPath: event.target.value })} placeholder="C:\\项目\\路径" />
          </label>
          <label>
            <span>安全策略</span>
            <select value={props.workspaceForm.policyProfile} onChange={(event) => props.onWorkspaceFormChange({ ...props.workspaceForm, policyProfile: event.target.value as Workspace["policyProfile"] })}>
              <option value="production">生产：限制在项目内</option>
              <option value="development">开发：允许本机访问</option>
            </select>
          </label>
          <button type="submit" className="primary-action">创建空项目</button>
        </form>
        <div className="project-catalog-list">
          {props.workspaces.map((workspace) => (
            <article key={workspace.id} className={workspace.id === props.selectedId ? "project-catalog-item selected" : "project-catalog-item"}>
              <button type="button" onClick={() => props.onSelectWorkspace(workspace.id)}>
                <strong>{displayWorkspaceName(workspace.name)}</strong>
                <span>{workspace.rootPath}</span>
              </button>
              <button type="button" className="workspace-delete" onClick={() => props.onDeleteWorkspace(workspace)}>删除</button>
            </article>
          ))}
        </div>
      </aside>

      <section className="project-workspace">
        <header className="project-overview-header">
          <div>
            <span className="section-kicker">当前项目</span>
            <h2>{selectedWorkspace ? displayWorkspaceName(selectedWorkspace.name) : "尚未选择项目"}</h2>
            <p>{selectedWorkspace?.rootPath ?? "从左侧创建或选择一个项目。"}</p>
          </div>
          {selectedWorkspace ? <span className={`project-state ${props.snapshot?.status ?? "idle"}`}>{statusLabel(props.snapshot?.status ?? "idle")}</span> : null}
        </header>

        {selectedWorkspace ? (
          <>
            <section className="project-metrics" aria-label="项目概览">
              <div><span>当前任务</span><strong>{props.snapshot?.activeTask?.title ?? "尚未发布"}</strong></div>
              <div><span>计划</span><strong>{props.snapshot?.mission ? `v${props.snapshot.mission.planVersion} · ${statusLabel(props.snapshot.mission.planStatus)}` : "尚未创建"}</strong></div>
              <div><span>工单</span><strong>{completedTickets} / {totalTickets}</strong></div>
              <div><span>团队成员</span><strong>{props.snapshot?.agents.length ?? props.profiles.length}</strong></div>
            </section>
            <ProjectTeam
              profiles={props.profiles}
              profileDefinitions={props.profileDefinitions}
              modelConfigs={props.modelConfigs}
              availableSkills={props.availableSkills}
              selectedId={props.selectedAgentId}
              selectedProfile={props.selectedProfile}
              selectedDraft={props.selectedDraft}
              onSelect={props.onSelect}
              onRefresh={props.onRefresh}
              onDraftChange={props.onDraftChange}
              onSave={props.onSave}
            />
          </>
        ) : (
          <div className="project-empty-state">
            <strong>这里还没有项目</strong>
            <p>创建项目空间后，可以配置团队实例并进入办公室发布第一条任务。</p>
          </div>
        )}
      </section>
    </section>
  );
}

function ProjectTeam(props: {
  profiles: AgentProfileView[];
  profileDefinitions: AgentProfile[];
  modelConfigs: ModelConfig[];
  availableSkills: AvailableSkill[];
  selectedId?: string;
  selectedProfile?: AgentProfileView;
  selectedDraft?: WorkspaceAgentConfig;
  onSelect: (id: string) => void;
  onRefresh: () => void;
  onDraftChange: (agent: WorkspaceAgentConfig) => void;
  onSave: (agent: WorkspaceAgentConfig) => void;
}) {
  const [teamQuery, setTeamQuery] = useState("");
  const [teamPage, setTeamPage] = useState(0);
  const normalizedQuery = teamQuery.trim().toLocaleLowerCase();
  const filteredProfiles = normalizedQuery
    ? props.profiles.filter((profile) =>
        `${profile.identity.title} ${profile.identity.subtitle} ${profile.identity.scope} ${profile.capabilities.join(" ")}`
          .toLocaleLowerCase()
          .includes(normalizedQuery)
      )
    : props.profiles;
  const directoryPage = paginateTeamDirectory(
    filteredProfiles,
    teamPage,
    TEAM_DIRECTORY_PAGE_SIZE
  );
  const { items: visibleProfiles, page: currentPage, pageCount } = directoryPage;

  useEffect(() => {
    setTeamPage(0);
  }, [teamQuery, props.profiles.length]);

  return (
    <section className="management-panel team-workbench">
      <header className="management-header">
        <div>
          <h2>项目团队实例</h2>
          <p>这里是当前项目里的运行成员。全局档案不在这里被改写，项目可按需覆盖模型、技能和工具权限。</p>
        </div>
        <button type="button" onClick={props.onRefresh}>刷新团队</button>
      </header>
      <div className="team-layout">
        <div className="team-directory-toolbar">
          <label className="team-search">
            <Search size={16} />
            <input
              aria-label="搜索团队成员"
              placeholder="搜索姓名、岗位或能力"
              value={teamQuery}
              onChange={(event) => setTeamQuery(event.target.value)}
            />
          </label>
          <span className="team-count">共 {filteredProfiles.length} 人</span>
        </div>
        <section className="team-roster" aria-label="项目团队成员">
          {visibleProfiles.map((profile) => (
            <button
              key={profile.id}
              type="button"
              className={profile.id === props.selectedId ? "team-member selected" : "team-member"}
              onClick={() => props.onSelect(profile.id)}
            >
              <span className="profile-avatar">{profile.identity.avatar}</span>
              <strong>{profile.identity.title}</strong>
              <small>{profile.identity.subtitle}</small>
              <span className="team-member-capabilities">
                {profile.capabilities.slice(0, 4).join(" · ") || "尚未标注能力"}
              </span>
              <em>{profile.statusLabel}</em>
            </button>
          ))}
          {!visibleProfiles.length ? (
            <div className="team-directory-empty">没有匹配的团队成员</div>
          ) : null}
        </section>
        {pageCount > 1 ? (
          <nav className="team-pagination" aria-label="团队成员分页">
            <button
              type="button"
              aria-label="上一页成员"
              disabled={currentPage === 0}
              onClick={() => setTeamPage((page) => Math.max(0, page - 1))}
            >
              <ChevronLeft size={17} />
            </button>
            <span>{currentPage + 1} / {pageCount}</span>
            <button
              type="button"
              aria-label="下一页成员"
              disabled={currentPage >= pageCount - 1}
              onClick={() => setTeamPage((page) => Math.min(pageCount - 1, page + 1))}
            >
              <ChevronRight size={17} />
            </button>
          </nav>
        ) : null}
        <AgentDetailPanel
          profile={props.selectedProfile}
          profileDefinition={props.profileDefinitions.find((profile) => profile.id === props.selectedDraft?.profileId)}
          draft={props.selectedDraft}
          modelConfigs={props.modelConfigs}
          availableSkills={props.availableSkills}
          onDraftChange={props.onDraftChange}
          onSave={props.onSave}
        />
      </div>
    </section>
  );
}

function AgentDetailPanel(props: {
  profile?: AgentProfileView;
  profileDefinition?: AgentProfile;
  draft?: WorkspaceAgentConfig;
  modelConfigs: ModelConfig[];
  availableSkills: AvailableSkill[];
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
        <span className="agent-runtime-status">{props.profile.statusLabel}</span>
      </header>

      <details className="agent-profile-disclosure">
        <summary>
          <span>
            <strong>继承的智能体档案</strong>
            <small>灵魂、岗位、能力手册与运行边界</small>
          </span>
          <ChevronDown size={18} />
        </summary>
        <div className="agent-profile-facts">
          <section className="agent-section">
            <h4>灵魂特质</h4>
            <p>{props.profile.soul}</p>
          </section>

          <section className="agent-section">
            <h4>岗位契约</h4>
            <p>{props.profile.identity.title}是当前项目团队里的{props.profile.identity.subtitle}智能体。</p>
          </section>

          <section className="agent-section agent-capability-manual">
            <h4>能力手册</h4>
            <pre className="agent-md-preview">{props.profile.agentMd}</pre>
          </section>

          <section className="agent-section">
            <h4>默认工具</h4>
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
        </div>
      </details>

      <section className="agent-section runtime-config">
        <header className="runtime-config-header">
          <div>
            <h4>项目运行配置</h4>
            <p>只覆盖当前项目，不会改写全局智能体档案。</p>
          </div>
        </header>
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
            <InstanceSkillConfig
              draft={draft}
              defaultSkills={props.profileDefinition?.defaultSkills ?? []}
              availableSkills={props.availableSkills}
              onChange={props.onDraftChange}
            />
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
            <button type="button" className="primary-action agent-save" onClick={() => props.onSave(draft)}>保存项目配置</button>
          </>
        ) : (
          <p>团队配置加载后可编辑项目级覆盖。</p>
        )}
      </section>
    </aside>
  );
}

function InstanceSkillConfig(props: {
  draft: WorkspaceAgentConfig;
  defaultSkills: string[];
  availableSkills: AvailableSkill[];
  onChange: (agent: WorkspaceAgentConfig) => void;
}) {
  const [query, setQuery] = useState("");
  const inheritsDefaults = props.draft.skillOverrides === undefined;
  const enabledSkills = new Set(props.draft.skillOverrides ?? props.defaultSkills);
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const filteredSkills = normalizedQuery
    ? props.availableSkills.filter((skill) => `${skill.name} ${skill.description}`.toLocaleLowerCase().includes(normalizedQuery))
    : props.availableSkills;

  return (
    <div className="instance-skill-config">
      <Toggle
        label="继承档案默认技能"
        checked={inheritsDefaults}
        onChange={(checked) => props.onChange({
          ...props.draft,
          skillOverrides: checked ? undefined : [...enabledSkills],
        })}
      />
      <small>{inheritsDefaults ? "当前随智能体档案更新。" : "当前使用这个项目的专属技能配置。"}</small>
      <input
        className="skill-search"
        aria-label="搜索项目技能"
        placeholder="搜索技能"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      <div className="skill-picker" aria-label="项目技能">
        {filteredSkills.length ? filteredSkills.map((skill) => (
          <label key={skill.name} className="skill-option" title={skill.filePath}>
            <input
              type="checkbox"
              checked={enabledSkills.has(skill.name)}
              disabled={inheritsDefaults}
              onChange={(event) => {
                const next = new Set(enabledSkills);
                if (event.target.checked) next.add(skill.name);
                else next.delete(skill.name);
                props.onChange({ ...props.draft, skillOverrides: Array.from(next) });
              }}
            />
            <span><strong>{skill.name}</strong><small>{skill.description}</small></span>
          </label>
        )) : <small>{props.availableSkills.length ? "没有匹配的技能。" : "未发现可用技能。"}</small>}
      </div>
    </div>
  );
}

function thinkingLevelOptions(): Array<{ value: ModelConfig["thinkingLevel"]; label: string }> {
  return [
    { value: "off", label: "关闭" },
    { value: "minimal", label: "极低" },
    { value: "low", label: "低" },
    { value: "medium", label: "中" },
    { value: "high", label: "高" },
    { value: "xhigh", label: "很高" },
    { value: "max", label: "最高" },
  ];
}

function OperationsHub(props: {
  workspaces: Workspace[];
  snapshot?: WorkspaceSnapshot;
  events: AutoAgentEvent[];
  ticketCount: number;
  onOpenOffice: () => void;
}) {
  const runningAgents = props.snapshot?.agents.filter((agent) => agent.status === "running").length ?? 0;
  const attentionAgents = props.snapshot?.agents.filter((agent) => agent.status === "waiting" || agent.status === "blocked" || agent.status === "failed").length ?? 0;
  const failedEvents = props.events.filter((event) => event.type.endsWith(".failed") || event.type === "run.failed");
  const recentEvents = props.events.slice(-12).reverse();

  return (
    <section className="operations-hub">
      <header className="management-header">
        <div>
          <span className="section-kicker">平台态势</span>
          <h2>系统运营</h2>
          <p>这里汇总三大引擎的真实运行事实，只负责观察、检索和进入现场，不参与业务流转。</p>
        </div>
        <button type="button" className="primary-action" onClick={props.onOpenOffice}>返回办公室</button>
      </header>

      <section className="operations-metrics" aria-label="系统运行概览">
        <div><span>项目</span><strong>{props.workspaces.length}</strong><small>已登记项目空间</small></div>
        <div><span>运行成员</span><strong>{runningAgents}</strong><small>正在执行工作轮次</small></div>
        <div><span>等待处理</span><strong>{attentionAgents}</strong><small>等待、受阻或失败</small></div>
        <div><span>当前工单</span><strong>{props.ticketCount}</strong><small>当前项目工单</small></div>
      </section>

      <div className="operations-grid">
        <section className="engine-health">
          <header>
            <h3>引擎状态</h3>
            <span>{props.snapshot ? "数据连接正常" : "尚未选择项目"}</span>
          </header>
          <div className="engine-health-row">
            <span className="engine-monogram">A</span>
            <div><strong>智能体引擎</strong><small>对话线程、目标、工作轮次、技能与工具执行</small></div>
            <em>{runningAgents ? `${runningAgents} 运行中` : "就绪"}</em>
          </div>
          <div className="engine-health-row">
            <span className="engine-monogram">T</span>
            <div><strong>工单引擎</strong><small>任务图、依赖、状态和工作交接</small></div>
            <em>{props.ticketCount ? `${props.ticketCount} 张工单` : "就绪"}</em>
          </div>
          <div className="engine-health-row">
            <span className="engine-monogram">M</span>
            <div><strong>任务控制</strong><small>任务、计划、工单与智能体协调</small></div>
            <em>{props.snapshot?.mission?.planStatus ? statusLabel(props.snapshot.mission.planStatus) : "就绪"}</em>
          </div>
        </section>

        <section className="operations-activity">
          <header>
            <h3>最近活动</h3>
            <span>{failedEvents.length ? `${failedEvents.length} 条失败事件` : "未发现失败事件"}</span>
          </header>
          <div className="operations-activity-list">
            {recentEvents.length ? recentEvents.map((event) => {
              const item = buildEventTimelineItem(event);
              const copy = operationsActivityCopy(item.title, item.detail, item.actor, event.type);
              return (
                <article key={event.id} className={item.tone === "danger" ? "failed" : ""}>
                  <time>{new Date(event.timestamp).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</time>
                  <div><strong>{copy.title}</strong><small>{copy.detail}</small></div>
                </article>
              );
            }) : <p className="operations-empty">当前项目还没有运行记录。</p>}
          </div>
        </section>
      </div>
    </section>
  );
}

function operationsActivityCopy(title: string, detail: string | undefined, actor: string, eventType: AutoAgentEvent["type"]) {
  const translatedTitles: Record<string, string> = {
    accepted: "目标结论已接受",
    running: "开始执行",
    waiting: "等待下一步",
    system_note: "系统记录",
    ticket_received: "收到工单"
  };
  const translatedTitle = translatedTitles[title] ?? title;
  const isInternalPayload = (value: string) => (
    value.length > 180
    || value.includes("[current-ticket]")
    || value.includes("goal_resolution")
    || value.includes("domainOutcome")
    || value.includes("output-schema=")
    || value.trimStart().startsWith("{")
  );
  const safeActor = isInternalPayload(actor) ? "Agent" : actor;
  if (isInternalPayload(title)) {
    return { title: "已组装任务上下文", detail: `${safeActor}已接收当前工单和执行约束` };
  }
  if (actor.includes("proposalSubmitted") || detail?.includes("proposalSubmitted")) {
    return { title: translatedTitle, detail: "Agent 提交了目标处理结论" };
  }
  if (detail?.includes("[current-ticket]")) {
    return { title: translatedTitle, detail: `${safeActor}提交了当前工单处理结论` };
  }
  if (detail && isInternalPayload(detail)) {
    return { title: translatedTitle, detail: `${safeActor}完成了一次运行处理，原始数据可在运行记录中查看` };
  }
  return { title: translatedTitle, detail: detail ?? `${safeActor} · ${eventType}` };
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
          <span className="section-kicker">推理基础设施</span>
          <h2>模型服务</h2>
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
          <label>
            <span>上下文窗口（tokens）</span>
            <input type="number" min="1" step="1000" value={props.draft.contextWindowTokens} onChange={(event) => props.onDraftChange({ ...props.draft, contextWindowTokens: Number(event.target.value) })} />
          </label>
          <label>
            <span>推理模型</span>
            <input type="checkbox" checked={props.draft.supportsReasoning} onChange={(event) => props.onDraftChange({ ...props.draft, supportsReasoning: event.target.checked, thinkingLevel: event.target.checked ? "medium" : "off" })} />
          </label>
          <label>
            <span>支持图片输入</span>
            <input type="checkbox" checked={props.draft.supportsImages} onChange={(event) => props.onDraftChange({ ...props.draft, supportsImages: event.target.checked })} />
          </label>
          <label>
            <span>推理强度</span>
            <select disabled={!props.draft.supportsReasoning} value={props.draft.thinkingLevel} onChange={(event) => props.onDraftChange({ ...props.draft, thinkingLevel: event.target.value as ModelConfig["thinkingLevel"] })}>
              {thinkingLevelOptions().map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
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
        <span>上下文窗口（tokens）</span>
        <input type="number" min="1" step="1000" value={props.config.contextWindowTokens} onChange={(event) => props.onChange({ ...props.config, contextWindowTokens: Number(event.target.value) })} />
      </label>
      <label>
        <span>推理模型</span>
        <input type="checkbox" checked={props.config.supportsReasoning} onChange={(event) => props.onChange({ ...props.config, supportsReasoning: event.target.checked, thinkingLevel: event.target.checked ? "medium" : "off" })} />
      </label>
      <label>
        <span>支持图片输入</span>
        <input type="checkbox" checked={props.config.supportsImages} onChange={(event) => props.onChange({ ...props.config, supportsImages: event.target.checked })} />
      </label>
      <label>
        <span>推理强度</span>
        <select disabled={!props.config.supportsReasoning} value={props.config.thinkingLevel} onChange={(event) => props.onChange({ ...props.config, thinkingLevel: event.target.value as ModelConfig["thinkingLevel"] })}>
          {thinkingLevelOptions().map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
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
