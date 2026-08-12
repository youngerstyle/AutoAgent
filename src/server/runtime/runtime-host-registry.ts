import { createId } from "../../shared/ids.js";
import type { LoopDebugLog, WorkspaceSnapshot } from "../../shared/types.js";
import type { AgentMessageAttachment } from "../../shared/contracts/agent-engine.js";
import type { AgentProfileStore } from "../agents/profile-store.js";
import type { ProviderRegistry } from "../providers/provider-registry.js";
import type { WorkspaceStore } from "../storage/workspace-store.js";
import type { PlanPolicyStore } from "../tickets/plan-policy-store.js";
import type { PlanPolicyRef } from "../../shared/contracts/ticket-engine.js";
import type { Workspace } from "../../shared/types.js";
import { RuntimeHost, planHasRunnableTickets, runtimeTaskStatusFor } from "./runtime-host.js";
import { RuntimeHostStore } from "./runtime-host-store.js";
import { MissionStore } from "../mission-process/mission-store.js";
import { TicketStore } from "../tickets/ticket-store.js";
import { StaffingRequestStore } from "../staffing/staffing-request-store.js";
import { DEFAULT_MINIMAL_TEAM_POLICY_CONFIG, seedMinimalTeamPlanPolicy } from "../tickets/plan-policy-config.js";
import { RuntimeExecutionGate, RuntimeHostScheduler } from "./runtime-scheduler.js";
import { ensureProjectOwner } from "../agents/roster.js";

export class RuntimeHostRegistry {
  private readonly hosts = new Map<string, RuntimeHost>();
  private readonly pendingHosts = new Map<string, Promise<RuntimeHost>>();
  private readonly scheduler: RuntimeHostScheduler;
  private readonly executionGate: RuntimeExecutionGate;

  constructor(
    private readonly workspaces: WorkspaceStore,
    private readonly profiles: AgentProfileStore,
    private readonly providers: ProviderRegistry,
    private readonly policyStore: PlanPolicyStore,
    private readonly policyRef: PlanPolicyRef,
    private readonly restoreConcurrency = 2,
    options: { executionConcurrency?: number } = {},
  ) {
    const executionConcurrency = options.executionConcurrency ?? 2;
    this.scheduler = new RuntimeHostScheduler(executionConcurrency);
    this.executionGate = new RuntimeExecutionGate(executionConcurrency);
  }

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

  async sendAgentMessage(workspaceId: string, taskId: string, agentId: string, message: string, messageId?: string, attachments?: AgentMessageAttachment[]): Promise<WorkspaceSnapshot> {
    const host = await this.host(workspaceId, true);
    return host.sendAgentMessage(taskId, agentId, message, messageId, attachments);
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

  async stopAll(): Promise<void> {
    const pending = await Promise.allSettled(this.pendingHosts.values());
    const hosts = [
      ...this.hosts.values(),
      ...pending.flatMap((result) => result.status === "fulfilled" ? [result.value] : []),
    ];
    this.hosts.clear();
    this.pendingHosts.clear();
    await Promise.allSettled([...new Set(hosts)].map((host) => host.stop()));
    await this.scheduler.stop();
  }

  async removeWorkspace(
    workspaceId: string,
    options: { deleteLocalFolder?: boolean } = {},
  ): Promise<Workspace> {
    const pending = this.pendingHosts.get(workspaceId);
    const host = this.hosts.get(workspaceId) ?? (pending ? await pending : undefined);
    this.hosts.delete(workspaceId);
    this.pendingHosts.delete(workspaceId);
    if (host) await host.stop();
    return this.workspaces.remove(workspaceId, options);
  }

  async startAll(): Promise<{
    restoredWorkspaceIds: string[];
    failedWorkspaces: Array<{
      workspaceId: string;
      workspaceName: string;
      rootPath: string;
      error: string;
    }>;
  }> {
    const workspaces = await this.workspaces.list();
    const failures: Array<{ workspace: Workspace; reason: unknown }> = [];
    const restoredWorkspaceIds: string[] = [];
    let cursor = 0;
    const worker = async () => {
      while (cursor < workspaces.length) {
        const workspace = workspaces[cursor++];
        if (!workspace) return;
        try {
          if (await this.workspaceNeedsScheduler(workspace)) {
            await this.host(workspace.id, true);
            restoredWorkspaceIds.push(workspace.id);
          }
        } catch (reason) {
          failures.push({ workspace, reason });
        }
      }
    };
    const workerCount = Math.min(this.restoreConcurrency, workspaces.length);
    await Promise.all(Array.from({ length: workerCount }, () => worker()));
    return {
      restoredWorkspaceIds,
      failedWorkspaces: failures.map((failure) => ({
        workspaceId: failure.workspace.id,
        workspaceName: failure.workspace.name,
        rootPath: failure.workspace.rootPath,
        error: failure.reason instanceof Error ? failure.reason.message : String(failure.reason),
      })),
    };
  }

  /**
   * Restoration is a fact check, not a replay request. A completed Plan with
   * a linked Mission is readable history and must not create a RuntimeHost or
   * a background scheduler during process startup.
   */
  private async workspaceNeedsScheduler(workspace: Workspace): Promise<boolean> {
    const runtimeStore = new RuntimeHostStore(workspace.rootPath);
    const staffingStore = new StaffingRequestStore(workspace.rootPath);
    for (const record of await runtimeStore.list()) {
      if (record.status !== "active") continue;
      const mission = await new MissionStore(workspace.rootPath, record.missionId).read();
      if (!mission) {
        const staffing = await staffingStore.getByTask(record.taskId);
        if (staffing && !new Set(["blocked", "failed", "completed"]).has(staffing.status)) return true;
        continue;
      }
      const ticketAggregate = await new TicketStore(workspace.rootPath, record.taskId, record.runId).read(mission.record.planId);
      if (!ticketAggregate) return true;
      const nextStatus = runtimeTaskStatusFor(ticketAggregate.plan.status, mission.record.status);
      if (nextStatus !== record.status) {
        await runtimeStore.save({ ...record, status: nextStatus, updatedAt: new Date().toISOString() });
      }
      if (nextStatus === "active" && planHasRunnableTickets(ticketAggregate.tickets)) return true;
    }
    return false;
  }

  private async host(workspaceId: string, startScheduler: boolean): Promise<RuntimeHost> {
    const existing = this.hosts.get(workspaceId);
    if (existing) {
      if (startScheduler) await existing.start();
      return existing;
    }
    let pending = this.pendingHosts.get(workspaceId);
    if (!pending) {
      pending = this.createHost(workspaceId, startScheduler);
      this.pendingHosts.set(workspaceId, pending);
    }
    const host = await pending;
    if (startScheduler) await host.start();
    return host;
  }

  private async createHost(workspaceId: string, startScheduler: boolean): Promise<RuntimeHost> {
    try {
      const workspace = await this.workspaces.get(workspaceId);
      await ensureProjectOwner(workspace, await this.profiles.list());
      await seedMinimalTeamPlanPolicy(this.policyStore, DEFAULT_MINIMAL_TEAM_POLICY_CONFIG);
      const host = new RuntimeHost(workspace, this.profiles, this.providers, this.policyStore, this.policyRef, {
        scheduler: this.scheduler,
        schedulerKey: workspace.id,
        executionGate: this.executionGate,
      });
      if (startScheduler) {
        await host.start();
      } else {
        await host.hydrate();
      }
      this.hosts.set(workspaceId, host);
      return host;
    } finally {
      this.pendingHosts.delete(workspaceId);
    }
  }
}
