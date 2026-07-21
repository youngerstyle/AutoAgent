import { createId } from "../../shared/ids.js";
import type { LoopDebugLog, WorkspaceSnapshot } from "../../shared/types.js";
import type { AgentProfileStore } from "../agents/profile-store.js";
import type { ProviderRegistry } from "../providers/provider-registry.js";
import type { WorkspaceStore } from "../storage/workspace-store.js";
import type { PlanPolicyStore } from "../tickets/plan-policy-store.js";
import type { PlanPolicyRef } from "../../shared/contracts/ticket-engine.js";
import { RuntimeHost } from "./runtime-host.js";
import { DEFAULT_MINIMAL_TEAM_POLICY_CONFIG, seedMinimalTeamPlanPolicy } from "../tickets/plan-policy-config.js";

export class RuntimeHostRegistry {
  private readonly hosts = new Map<string, RuntimeHost>();

  constructor(
    private readonly workspaces: WorkspaceStore,
    private readonly profiles: AgentProfileStore,
    private readonly providers: ProviderRegistry,
    private readonly policyStore: PlanPolicyStore,
    private readonly policyRef: PlanPolicyRef,
  ) {}

  async snapshotByWorkspace(workspaceId: string): Promise<WorkspaceSnapshot> {
    const host = await this.host(workspaceId, false);
    return host.snapshot();
  }

  async startTask(input: { workspaceId: string; goal: string; title?: string }): Promise<WorkspaceSnapshot> {
    const host = await this.host(input.workspaceId, true);
    await host.createTask({
      taskId: createId("task"),
      title: input.title?.trim() || input.goal.trim().slice(0, 40) || "新任务",
      objective: input.goal.trim(),
    });
    return host.snapshot();
  }

  async pauseTask(workspaceId: string, taskId: string): Promise<WorkspaceSnapshot> {
    const host = await this.host(workspaceId, false);
    await host.pauseTask(taskId);
    return host.snapshot();
  }

  async resumeTask(workspaceId: string, taskId: string): Promise<WorkspaceSnapshot> {
    const host = await this.host(workspaceId, true);
    await host.resumeTask(taskId);
    return host.snapshot();
  }

  async stopTask(workspaceId: string, taskId: string): Promise<WorkspaceSnapshot> {
    const host = await this.host(workspaceId, false);
    await host.cancelTask(taskId, "human stopped the task");
    return host.snapshot();
  }

  async followUpTask(workspaceId: string, taskId: string, message: string): Promise<WorkspaceSnapshot> {
    const host = await this.host(workspaceId, true);
    return host.sendTaskMessage(taskId, message);
  }

  async sendAgentMessage(workspaceId: string, taskId: string, agentId: string, message: string, messageId?: string): Promise<WorkspaceSnapshot> {
    const host = await this.host(workspaceId, true);
    return host.sendAgentMessage(taskId, agentId, message, messageId);
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

  private async host(workspaceId: string, startScheduler: boolean): Promise<RuntimeHost> {
    const existing = this.hosts.get(workspaceId);
    if (existing) {
      if (startScheduler) await existing.start();
      return existing;
    }
    const workspace = await this.workspaces.get(workspaceId);
    await seedMinimalTeamPlanPolicy(this.policyStore, DEFAULT_MINIMAL_TEAM_POLICY_CONFIG);
    const host = new RuntimeHost(workspace, this.profiles, this.providers, this.policyStore, this.policyRef);
    if (startScheduler) {
      await host.start();
    } else {
      await host.hydrate();
    }
    this.hosts.set(workspaceId, host);
    return host;
  }
}
