import { useEffect, useMemo, useState } from "react";
import type { AutoAgentEvent, Workspace, WorkspaceSnapshot } from "../shared/types";
import { createWorkspace, getSnapshot, listWorkspaces, pauseTask, resumeTask, startTask, stopTask } from "./api";
import { buildAgentNodes, taskControlMode } from "./view-model";

export function App() {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [selectedId, setSelectedId] = useState<string>("");
  const [snapshot, setSnapshot] = useState<WorkspaceSnapshot>();
  const [events, setEvents] = useState<AutoAgentEvent[]>([]);
  const [goal, setGoal] = useState("");
  const [workspaceForm, setWorkspaceForm] = useState({ name: "Demo workspace", rootPath: "", policyProfile: "production" as Workspace["policyProfile"] });
  const [selectedAgentId, setSelectedAgentId] = useState<string>("");
  const [error, setError] = useState("");
  const nodes = useMemo(() => buildAgentNodes(snapshot), [snapshot]);
  const mode = taskControlMode(snapshot);

  useEffect(() => {
    void refreshWorkspaces();
  }, []);

  useEffect(() => {
    if (!selectedId) return;
    void refreshSnapshot(selectedId);
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

  async function submitWorkspace(event: React.FormEvent) {
    event.preventDefault();
    try {
      const result = await createWorkspace(workspaceForm);
      await refreshWorkspaces();
      setSelectedId(result.workspace.id);
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

  const selectedAgent = snapshot?.agents.find((agent) => agent.id === selectedAgentId) ?? snapshot?.agents[0];

  return (
    <main className="app-shell">
      <header className="topbar">
        <div>
          <h1>AutoAgent</h1>
          <span>Local autonomous team console</span>
        </div>
        <strong className={`status-pill ${snapshot?.status ?? "idle"}`}>{snapshot?.status ?? "idle"}</strong>
      </header>
      <section className="workspace-shell">
        <aside className="workspace-list">
          <form className="workspace-form" onSubmit={submitWorkspace}>
            <label>
              <span>Name</span>
              <input value={workspaceForm.name} onChange={(event) => setWorkspaceForm({ ...workspaceForm, name: event.target.value })} />
            </label>
            <label>
              <span>Path</span>
              <input value={workspaceForm.rootPath} onChange={(event) => setWorkspaceForm({ ...workspaceForm, rootPath: event.target.value })} placeholder="C:\\path\\to\\project" />
            </label>
            <label>
              <span>Policy</span>
              <select value={workspaceForm.policyProfile} onChange={(event) => setWorkspaceForm({ ...workspaceForm, policyProfile: event.target.value as Workspace["policyProfile"] })}>
                <option value="production">production</option>
                <option value="development">development</option>
              </select>
            </label>
            <button type="submit">Create</button>
          </form>
          <div className="workspace-items">
            {workspaces.map((workspace) => (
              <button key={workspace.id} className={workspace.id === selectedId ? "workspace-item selected" : "workspace-item"} onClick={() => setSelectedId(workspace.id)}>
                <strong>{workspace.name}</strong>
                <span>{workspace.rootPath}</span>
              </button>
            ))}
          </div>
        </aside>
        <section className="console-region">
          <section className="task-panel">
            <form onSubmit={submitTask}>
              <textarea value={goal} onChange={(event) => setGoal(event.target.value)} placeholder="Describe the workspace goal for the team" />
              <button type="submit" disabled={!selectedId || mode === "running"}>Start</button>
            </form>
            <div className="control-row">
              <button type="button" onClick={() => void control("pause")} disabled={mode !== "running"}>Pause</button>
              <button type="button" onClick={() => void control("resume")} disabled={mode !== "paused"}>Resume</button>
              <button type="button" onClick={() => void control("stop")} disabled={mode !== "running" && mode !== "paused"}>Stop</button>
            </div>
            {error ? <p className="error-text">{error}</p> : null}
          </section>

          <section className="canvas-panel">
            <div className="team-canvas">
              <div className="canvas-phase">{snapshot?.phase ?? "idle"}</div>
              {nodes.map((node) => (
                <button
                  key={node.id}
                  className={node.active ? "agent-node active" : `agent-node ${node.status}`}
                  style={{ left: `${node.x}%`, top: `${node.y}%` }}
                  onClick={() => setSelectedAgentId(node.id)}
                  title={node.currentStep ?? node.status}
                >
                  <span className="avatar">{initials(node.label)}</span>
                  <strong>{node.label}</strong>
                  <small>{node.currentStep ?? node.status}</small>
                </button>
              ))}
            </div>
            <div className="agent-detail">
              <strong>{selectedAgent?.name ?? "No agent selected"}</strong>
              <span>{selectedAgent?.roleInWorkspace ?? "idle"}</span>
              <p>{selectedAgent?.currentStep ?? selectedAgent?.capabilities?.join(", ") ?? "Create a workspace to seed the team."}</p>
            </div>
          </section>

          <aside className="event-panel">
            {events.map((event) => (
              <article key={event.id} className="event-item">
                <span>{event.type}</span>
                <strong>{event.summary}</strong>
              </article>
            ))}
          </aside>
        </section>
      </section>
    </main>
  );
}

function initials(label: string): string {
  return label.split(/\s+/).map((part) => part[0]).join("").slice(0, 2).toUpperCase();
}
