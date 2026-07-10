import { createId } from "../../shared/ids.js";
import type { LoopDebugLog, WorkspaceSnapshot } from "../../shared/types.js";
import type { AgentProfileStore } from "../agents/profile-store.js";
import type { ProviderRegistry } from "../providers/provider-registry.js";
import type { WorkspaceStore } from "../storage/workspace-store.js";
import type { WorkflowPolicyStore } from "../tickets/workflow-policy-store.js";
import type { WorkflowPolicyRef } from "../../shared/contracts/ticket-engine.js";
import { RuntimeHost } from "./runtime-host.js";
import { DEFAULT_MINIMAL_TEAM_POLICY_CONFIG, seedMinimalTeamWorkflowPolicy } from "../tickets/workflow-policy-config.js";

export class RuntimeHostRegistry {
  private readonly hosts = new Map<string, RuntimeHost>();

  constructor(
    private readonly workspaces: WorkspaceStore,
    private readonly profiles: AgentProfileStore,
    private readonly providers: ProviderRegistry,
    private readonly policyStore: WorkflowPolicyStore,
    private readonly policyRef: WorkflowPolicyRef,
  ) {}

  async snapshotByWorkspace(workspaceId: string): Promise<WorkspaceSnapshot> {
    const host = await this.host(workspaceId);
    return host.snapshot();
  }

  async startTask(input: { workspaceId: string; goal: string; title?: string }): Promise<WorkspaceSnapshot> {
    const host = await this.host(input.workspaceId);
    await host.createTask({
      taskId: createId("task"),
      title: input.title?.trim() || input.goal.trim().slice(0, 40) || "新任务",
      objective: input.goal.trim(),
    });
    return host.snapshot();
  }

  async pauseTask(workspaceId: string, taskId: string): Promise<WorkspaceSnapshot> {
    const host = await this.host(workspaceId);
    await host.pauseTask(taskId);
    return host.snapshot();
  }

  async resumeTask(workspaceId: string, taskId: string): Promise<WorkspaceSnapshot> {
    const host = await this.host(workspaceId);
    await host.resumeTask(taskId);
    return host.snapshot();
  }

  async stopTask(workspaceId: string, taskId: string): Promise<WorkspaceSnapshot> {
    const host = await this.host(workspaceId);
    await host.cancelTask(taskId, "human stopped the task");
    return host.snapshot();
  }

  async followUpTask(workspaceId: string, taskId: string, message: string): Promise<WorkspaceSnapshot> {
    const host = await this.host(workspaceId);
    const snapshot = await host.snapshot();
    const boss = snapshot.agents.find((agent) => agent.roleInWorkspace === "boss");
    if (!boss) throw new Error("Boss Agent is unavailable");
    return host.sendAgentMessage(taskId, boss.id, message);
  }

  async sendAgentMessage(workspaceId: string, taskId: string, agentId: string, message: string): Promise<WorkspaceSnapshot> {
    const host = await this.host(workspaceId);
    return host.sendAgentMessage(taskId, agentId, message);
  }

  async loopDebugLogByWorkspace(workspaceId: string): Promise<LoopDebugLog> {
    const snapshot = await this.snapshotByWorkspace(workspaceId);
    return {
      task: snapshot.activeTask,
      taskRun: snapshot.activeTaskRun,
      entries: snapshot.recentEvents.map((event) => ({
        id: event.id,
        kind: "flow",
        timestamp: event.timestamp,
        actor: event.actorId ?? "system",
        title: event.summary,
        content: JSON.stringify(event.payload),
        sequence: event.sequence,
      })),
    };
  }

  stopAll(): void {
    for (const host of this.hosts.values()) host.stop();
  }

  private async host(workspaceId: string): Promise<RuntimeHost> {
    const existing = this.hosts.get(workspaceId);
    if (existing) return existing;
    const workspace = await this.workspaces.get(workspaceId);
    await seedMinimalTeamWorkflowPolicy(this.policyStore, DEFAULT_MINIMAL_TEAM_POLICY_CONFIG);
    const host = new RuntimeHost(workspace, this.profiles, this.providers, this.policyStore, this.policyRef);
    await host.start();
    this.hosts.set(workspaceId, host);
    return host;
  }
}
