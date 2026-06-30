import { useEffect, useMemo, useState } from "react";
import type { AgentPolicy, AutoAgentEvent, ProviderConfig, ProviderName, Workspace, WorkspaceSnapshot } from "../shared/types";
import { capabilityLabels, displayText, phaseLabel, roleLabel, statusLabel } from "../shared/labels";
import {
  createWorkspace,
  getProviderConfig,
  getSnapshot,
  listAgents,
  listWorkspaces,
  pauseTask,
  resumeTask,
  saveProviderConfig,
  startTask,
  stopTask,
  updateAgent,
  type WorkspaceAgentConfig
} from "./api";
import { buildAgentNodes, taskControlMode } from "./view-model";

export function App() {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [selectedId, setSelectedId] = useState<string>("");
  const [snapshot, setSnapshot] = useState<WorkspaceSnapshot>();
  const [events, setEvents] = useState<AutoAgentEvent[]>([]);
  const [goal, setGoal] = useState("");
  const [workspaceForm, setWorkspaceForm] = useState({ name: "演示项目", rootPath: "", policyProfile: "production" as Workspace["policyProfile"] });
  const [selectedAgentId, setSelectedAgentId] = useState<string>("");
  const [view, setView] = useState<"run" | "agents" | "providers">("run");
  const [agents, setAgents] = useState<WorkspaceAgentConfig[]>([]);
  const [providerConfigs, setProviderConfigs] = useState<Partial<Record<Exclude<ProviderName, "mock">, ProviderConfig>>>({});
  const [providerDrafts, setProviderDrafts] = useState<Record<Exclude<ProviderName, "mock">, ProviderConfig>>({
    openai: { provider: "openai", model: "gpt-4.1-mini" },
    anthropic: { provider: "anthropic", model: "claude-3-5-sonnet-latest" }
  });
  const [error, setError] = useState("");
  const nodes = useMemo(() => buildAgentNodes(snapshot), [snapshot]);
  const mode = taskControlMode(snapshot);

  useEffect(() => {
    void refreshWorkspaces();
  }, []);

  useEffect(() => {
    if (!selectedId) return;
    void refreshSnapshot(selectedId);
    void refreshAgents(selectedId);
    void refreshProviderConfig();
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

  async function refreshProviderConfig() {
    try {
      const result = await getProviderConfig();
      setProviderConfigs(result.providers);
      setProviderDrafts({
        openai: { provider: "openai", model: result.providers.openai?.model ?? "gpt-4.1-mini", baseUrl: result.providers.openai?.baseUrl },
        anthropic: { provider: "anthropic", model: result.providers.anthropic?.model ?? "claude-3-5-sonnet-latest", baseUrl: result.providers.anthropic?.baseUrl }
      });
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

  async function saveProvider(provider: Exclude<ProviderName, "mock">) {
    try {
      const draft = providerDrafts[provider];
      await saveProviderConfig(provider, draft);
      await refreshProviderConfig();
      setError("");
    } catch (err) {
      setError((err as Error).message);
    }
  }

  const selectedAgent = snapshot?.agents.find((agent) => agent.id === selectedAgentId) ?? snapshot?.agents[0];

  return (
    <main className="app-shell">
      <header className="topbar">
        <div>
          <h1>AutoAgent</h1>
          <span>本地自动化团队平台</span>
        </div>
        <nav className="topnav">
          <button className={view === "run" ? "selected" : ""} onClick={() => setView("run")}>运行台</button>
          <button className={view === "agents" ? "selected" : ""} onClick={() => setView("agents")}>团队配置</button>
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

          {view === "agents" ? (
            <section className="management-panel">
              <header className="management-header">
                <h2>团队运行配置</h2>
                <button type="button" onClick={() => void refreshAgents()}>刷新团队</button>
              </header>
              <div className="agent-config-grid">
                {agents.map((agent, index) => (
                  <AgentConfigCard
                    key={agent.id}
                    agent={agent}
                    onChange={(next) => setAgents((current) => current.map((item, itemIndex) => itemIndex === index ? next : item))}
                    onSave={() => void saveAgent(agent)}
                  />
                ))}
              </div>
            </section>
          ) : null}

          {view === "providers" ? (
            <section className="management-panel">
              <header className="management-header">
                <h2>模型服务配置</h2>
                <button type="button" onClick={() => void refreshProviderConfig()}>刷新配置</button>
              </header>
              <div className="provider-grid">
                {(["openai", "anthropic"] as const).map((provider) => (
                  <ProviderConfigCard
                    key={provider}
                    provider={provider}
                    configured={Boolean(providerConfigs[provider]?.apiKey)}
                    draft={providerDrafts[provider]}
                    onChange={(next) => setProviderDrafts((current) => ({ ...current, [provider]: next }))}
                    onSave={() => void saveProvider(provider)}
                  />
                ))}
              </div>
            </section>
          ) : null}
        </section>
      </section>
    </main>
  );
}

function AgentConfigCard(props: {
  agent: WorkspaceAgentConfig;
  onChange: (agent: WorkspaceAgentConfig) => void;
  onSave: () => void;
}) {
  const agent = props.agent;
  const policy = normalizePolicy(agent.policyOverride);
  return (
    <article className="config-card">
      <header>
        <strong>{agent.name ?? roleLabel(agent.roleInWorkspace)}</strong>
        <span>{roleLabel(agent.roleInWorkspace)}</span>
      </header>
      <label>
        <span>模型服务</span>
        <select value={agent.provider ?? "mock"} onChange={(event) => props.onChange({ ...agent, provider: event.target.value as ProviderName })}>
          <option value="mock">模拟服务</option>
          <option value="openai">OpenAI</option>
          <option value="anthropic">Anthropic</option>
        </select>
      </label>
      <label>
        <span>模型</span>
        <input value={agent.model ?? ""} onChange={(event) => props.onChange({ ...agent, model: event.target.value })} />
      </label>
      <div className="policy-grid">
        <Toggle label="读项目" checked={policy.canReadWorkspace} onChange={(checked) => props.onChange({ ...agent, policyOverride: { ...policy, canReadWorkspace: checked } })} />
        <Toggle label="写项目" checked={policy.canWriteWorkspace} onChange={(checked) => props.onChange({ ...agent, policyOverride: { ...policy, canWriteWorkspace: checked } })} />
        <Toggle label="执行命令" checked={policy.canExecuteCommands} onChange={(checked) => props.onChange({ ...agent, policyOverride: { ...policy, canExecuteCommands: checked } })} />
        <Toggle label="访问本机" checked={Boolean(policy.allowHostAccess)} onChange={(checked) => props.onChange({ ...agent, policyOverride: { ...policy, allowHostAccess: checked } })} />
      </div>
      <p>{capabilityLabels(agent.roleInWorkspace, agent.capabilities).join("、")}</p>
      <button type="button" onClick={props.onSave}>保存团队配置</button>
    </article>
  );
}

function ProviderConfigCard(props: {
  provider: Exclude<ProviderName, "mock">;
  configured: boolean;
  draft: ProviderConfig;
  onChange: (config: ProviderConfig) => void;
  onSave: () => void;
}) {
  return (
    <article className="config-card">
      <header>
        <strong>{props.provider}</strong>
        <span>{props.configured ? "已配置密钥" : "未配置密钥"}</span>
      </header>
      <label>
        <span>默认模型</span>
        <input value={props.draft.model} onChange={(event) => props.onChange({ ...props.draft, model: event.target.value })} />
      </label>
      <label>
        <span>接口密钥</span>
        <input type="password" placeholder={props.configured ? "保留现有密钥" : "输入接口密钥"} onChange={(event) => props.onChange({ ...props.draft, apiKey: event.target.value })} />
      </label>
      <label>
        <span>服务地址</span>
        <input value={props.draft.baseUrl ?? ""} onChange={(event) => props.onChange({ ...props.draft, baseUrl: event.target.value })} />
      </label>
      <button type="button" onClick={props.onSave}>保存模型服务</button>
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
