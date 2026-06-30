import { useEffect, useMemo, useState } from "react";
import type { AgentPolicy, AgentProfile, AutoAgentEvent, ModelConfig, ProviderName, Workspace, WorkspaceSnapshot } from "../shared/types";
import { capabilityLabels, displayText, phaseLabel, roleLabel, statusLabel } from "../shared/labels";
import {
  createModelConfig,
  createWorkspace,
  getSnapshot,
  listAgentProfiles,
  listAgents,
  listModelConfigs,
  listWorkspaces,
  pauseTask,
  resumeTask,
  setDefaultModelConfig,
  startTask,
  stopTask,
  updateAgent,
  updateAgentProfile,
  updateModelConfig,
  type WorkspaceAgentConfig
} from "./api";
import { buildAgentCatalogProfiles, buildAgentNodes, buildAgentProfiles, taskControlMode, type AgentProfileView } from "./view-model";

type RealProviderName = Exclude<ProviderName, "mock">;
type ModelConfigDraft = Pick<ModelConfig, "name" | "model"> & {
  provider: RealProviderName;
  apiKey: string;
  baseUrl: string;
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
  const nodes = useMemo(() => buildAgentNodes(snapshot), [snapshot]);
  const profiles = useMemo(() => buildAgentProfiles(snapshot, agentProfiles), [snapshot, agentProfiles]);
  const catalogProfiles = useMemo(() => buildAgentCatalogProfiles(agentProfiles), [agentProfiles]);
  const mode = taskControlMode(snapshot);

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
      setEvents((current) => [event, ...current].slice(0, 80));
      void refreshSnapshot(selectedId);
    });
    source.onerror = () => setError("Live event stream disconnected");
    return () => source.close();
  }, [selectedId]);

  async function refreshWorkspaces() {
    try {
      const result = await listWorkspaces();
      setWorkspaces(result.workspaces);
      if (!selectedId && result.workspaces[0]) setSelectedId(result.workspaces[0].id);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function refreshSnapshot(workspaceId = selectedId) {
    if (!workspaceId) return;
    try {
      const result = await getSnapshot(workspaceId);
      setSnapshot(result.snapshot);
      setEvents(result.snapshot.recentEvents.slice().reverse());
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
      await refreshWorkspaces();
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
      const result = await startTask(selectedId, goal);
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
        loopDefinition: profile.loopDefinition,
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
      <section className="workspace-shell">
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
              <button key={workspace.id} className={workspace.id === selectedId ? "workspace-item selected" : "workspace-item"} onClick={() => setSelectedId(workspace.id)}>
                <strong>{displayWorkspaceName(workspace.name)}</strong>
                <span>{workspace.rootPath}</span>
              </button>
            ))}
          </div>
        </aside>
        <section className={view === "run" ? "console-region" : "management-region"}>
          {view === "run" ? <>
            <section className="task-panel">
            <form onSubmit={submitTask}>
              <textarea value={goal} onChange={(event) => setGoal(event.target.value)} placeholder="描述这个项目要交给团队完成的目标" />
              <button type="submit" disabled={!selectedId || mode === "running"}>开始</button>
            </form>
            <div className="control-row">
              <button type="button" onClick={() => void control("pause")} disabled={mode !== "running"}>暂停</button>
              <button type="button" onClick={() => void control("resume")} disabled={mode !== "paused"}>继续</button>
              <button type="button" onClick={() => void control("stop")} disabled={mode !== "running" && mode !== "paused"}>停止</button>
            </div>
            {error ? <p className="error-text">{error}</p> : null}
            </section>

            <section className="canvas-panel">
            <div className="team-canvas">
              <div className="canvas-phase">{phaseLabel(snapshot?.phase ?? "idle")}</div>
              {nodes.map((node) => (
                <button
                  key={node.id}
                  className={node.active ? "agent-node active" : `agent-node ${node.status}`}
                  style={{ left: `${node.x}%`, top: `${node.y}%` }}
                  onClick={() => setSelectedAgentId(node.id)}
                  title={node.currentStep ?? statusLabel(node.status)}
                >
                  <span className="avatar">{initials(node.label)}</span>
                  <strong>{node.label}</strong>
                  <small>{node.currentStep ?? statusLabel(node.status)}</small>
                </button>
              ))}
            </div>
            <div className="agent-detail">
              <strong>{selectedAgent ? roleLabel(selectedAgent.roleInWorkspace) : "未选择成员"}</strong>
              <span>{selectedAgent ? roleLabel(selectedAgent.roleInWorkspace) : "空闲"}</span>
              <p>{(displayText(selectedAgent?.currentStep) ?? (selectedAgent ? capabilityLabels(selectedAgent.roleInWorkspace, selectedAgent.capabilities).join("、") : "")) || "创建项目后会生成固定团队。"}</p>
            </div>
            </section>

            <aside className="event-panel">
            {events.map((event) => (
              <article key={event.id} className="event-item">
                <span>{event.type}</span>
                <strong>{displayText(event.summary)}</strong>
              </article>
            ))}
            </aside>
          </> : null}

          {view === "studio" ? (
            <AgentHub
              profileViews={catalogProfiles}
              profiles={agentProfiles}
              selectedId={selectedCatalogDefinition?.id}
              onSelect={setSelectedProfileId}
              onProfileChange={(next) => setAgentProfiles((current) => current.map((item) => item.id === next.id ? next : item))}
              onSave={(profile) => void saveAgentProfile(profile)}
            />
          ) : null}

          {view === "team" ? (
            <ProjectTeam
              profiles={profiles}
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
    </main>
  );
}

function AgentHub(props: {
  profileViews: AgentProfileView[];
  profiles: AgentProfile[];
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
          <p>这里编辑全局身份、人格边界、循环方式和默认能力；项目团队只引用这些档案，不在这里产生项目状态。</p>
        </div>
      </header>
      <div className="studio-layout">
        <div className="agent-studio-grid">
          {props.profileViews.map((profile) => (
            <button
              key={profile.id}
              type="button"
              className={profile.id === props.selectedId ? "agent-profile-card selected" : "agent-profile-card"}
              onClick={() => props.onSelect(profile.id)}
            >
              <span className="profile-avatar">{profile.identity.avatar}</span>
              <strong>{profile.identity.title}</strong>
              <small>{profile.identity.subtitle}</small>
              <p>{profile.soul}</p>
              <div className="profile-meta">
                <span>全局定义</span>
                <span>{profile.model.providerLabel}</span>
              </div>
            </button>
          ))}
        </div>
        {selected && selectedView ? (
          <AgentDefinitionEditor
            profile={selected}
            view={selectedView}
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

function AgentDefinitionEditor(props: {
  profile: AgentProfile;
  view: AgentProfileView;
  onChange: (profile: AgentProfile) => void;
  onSave: (profile: AgentProfile) => void;
}) {
  const loopText = (props.profile.loopDefinition ?? []).join("\n");
  const capabilitiesText = props.profile.capabilities.join("、");
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
        <h4>身份定义</h4>
        <label>
          <span>名称</span>
          <input value={props.profile.name} onChange={(event) => props.onChange({ ...props.profile, name: event.target.value })} />
        </label>
        <label>
          <span>身份说明</span>
          <textarea aria-label="身份说明" value={props.profile.identity ?? ""} onChange={(event) => props.onChange({ ...props.profile, identity: event.target.value })} />
        </label>
      </section>

      <section className="agent-section">
        <h4>人格边界</h4>
        <label>
          <span>行为原则和人格边界</span>
          <textarea aria-label="人格边界" value={props.profile.soul ?? ""} onChange={(event) => props.onChange({ ...props.profile, soul: event.target.value })} />
        </label>
      </section>

      <section className="agent-section">
        <h4>循环定义</h4>
        <label>
          <span>每行一个循环步骤</span>
          <textarea aria-label="循环步骤" value={loopText} onChange={(event) => props.onChange({ ...props.profile, loopDefinition: event.target.value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean) })} />
        </label>
      </section>

      <section className="agent-section">
        <h4>能力标签</h4>
        <label>
          <span>用顿号分隔</span>
          <input value={capabilitiesText} onChange={(event) => props.onChange({ ...props.profile, capabilities: event.target.value.split(/[、,，]/).map((item) => item.trim()).filter(Boolean) })} />
        </label>
      </section>

      <section className="agent-section runtime-config">
        <h4>默认模型</h4>
        <div className="runtime-fields">
          <label>
            <span>模型服务</span>
            <select value={props.profile.defaultProvider} onChange={(event) => props.onChange({ ...props.profile, defaultProvider: event.target.value as ProviderName })}>
              <option value="mock">模拟服务</option>
              <option value="openai">OpenAI</option>
              <option value="anthropic">Anthropic</option>
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
  onDraftChange: (agent: WorkspaceAgentConfig) => void;
  onSave: (agent: WorkspaceAgentConfig) => void;
}) {
  if (!props.profile) {
    return <aside className="agent-detail-panel empty-state">创建或选择项目后会生成项目团队。</aside>;
  }

  const draft = props.draft;
  const policy = normalizePolicy(draft?.policyOverride ?? props.profile.policy);
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
        <h4>身份定义</h4>
        <p>{props.profile.identity.title}是当前项目团队里的{props.profile.identity.subtitle}智能体。</p>
      </section>

      <section className="agent-section">
        <h4>人格边界</h4>
        <p>{props.profile.soul}</p>
      </section>

      <section className="agent-section">
        <h4>循环定义</h4>
        <ol className="loop-list">
          {props.profile.loopSteps.map((step) => <li key={step}>{step}</li>)}
        </ol>
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
                <span>模型服务</span>
                <select value={draft.provider ?? "mock"} onChange={(event) => props.onDraftChange({ ...draft, provider: event.target.value as ProviderName })}>
                  <option value="mock">模拟服务</option>
                  <option value="openai">OpenAI</option>
                  <option value="anthropic">Anthropic</option>
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
