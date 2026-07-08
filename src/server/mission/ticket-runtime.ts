import { createId } from "../../shared/ids.js";
import type { AgentInboxMessage, AgentRole, Ticket, TicketBlocker, TicketType, WorkspaceAgent } from "../../shared/types.js";
import { RUNTIME_LIMITS } from "../runtime-limits.js";

export interface CreateTicketInput {
  workspaceId: string;
  taskId: string;
  taskRunId: string;
  type: TicketType;
  brief: string;
  expectedArtifact: string;
  targetAgentId?: string;
  targetRole?: AgentRole;
  capabilityTags?: string[];
  priority?: number;
  parentTicketId?: string;
  createdByTicketId?: string;
  dependsOnTicketIds?: string[];
  returnReason?: string;
}

export interface ClaimedTicket {
  ticket: Ticket;
  message: AgentInboxMessage;
}

export interface HumanTicketAction {
  action: "manual_test_passed" | "manual_test_failed" | "approved" | "rejected";
  message: string;
}

export interface YieldTicketInput {
  reason: string;
  assignmentRunId?: string;
  nextRunAfter?: string;
}

export class TicketRuntime {
  constructor(
    private readonly tickets = new Map<string, Ticket>(),
    private readonly messages = new Map<string, AgentInboxMessage>()
  ) {}

  createTicket(input: CreateTicketInput, now = new Date()): Ticket {
    const createdAt = now.toISOString();
    const ticket: Ticket = {
      id: createId("tk"),
      workspaceId: input.workspaceId,
      taskId: input.taskId,
      taskRunId: input.taskRunId,
      type: input.type,
      status: "pending",
      brief: input.brief,
      expectedArtifact: input.expectedArtifact,
      targetAgentId: input.targetAgentId,
      targetRole: input.targetRole,
      capabilityTags: input.capabilityTags,
      priority: input.priority ?? 0,
      attempt: 0,
      parentTicketId: input.parentTicketId,
      createdByTicketId: input.createdByTicketId,
      dependsOnTicketIds: input.dependsOnTicketIds,
      returnReason: input.returnReason,
      createdAt,
      updatedAt: createdAt
    };
    this.tickets.set(ticket.id, ticket);
    this.deliver(ticket, now);
    return ticket;
  }

  ticket(ticketId: string): Ticket | undefined {
    return this.tickets.get(ticketId);
  }

  allTickets(): Ticket[] {
    return Array.from(this.tickets.values());
  }

  allMessages(): AgentInboxMessage[] {
    return Array.from(this.messages.values());
  }

  inboxForAgent(agentId: string): AgentInboxMessage[] {
    return this.allMessages().filter((message) => message.toAgentId === agentId || message.claimedByAgentId === agentId);
  }

  claimNext(agent: WorkspaceAgent, nowFactory: () => Date = () => new Date(), leaseMs = RUNTIME_LIMITS.ticketLeaseMs): ClaimedTicket | undefined {
    const now = nowFactory();
    this.expireLeases(now);
    const alreadyBusy = this.allMessages().some((message) =>
      message.status === "claimed"
      && message.claimedByAgentId === agent.id
      && (!message.leaseUntil || new Date(message.leaseUntil).getTime() > now.getTime())
    );
    if (alreadyBusy) return undefined;

    const candidates = this.allMessages()
      .filter((message) => message.status === "pending")
      .filter((message) => message.toAgentId === agent.id || (!message.toAgentId && message.toRole === agent.roleInWorkspace))
      .filter((message) => {
        const ticket = this.tickets.get(message.ticketId);
        return ticket ? this.dependenciesSatisfied(ticket) : false;
      })
      .sort((a, b) => b.priority - a.priority || a.createdAt.localeCompare(b.createdAt));
    const message = candidates[0];
    if (!message) return undefined;

    const ticket = this.tickets.get(message.ticketId);
    if (!ticket || ticket.status !== "pending") return undefined;

    const leaseUntil = new Date(now.getTime() + leaseMs).toISOString();
    message.status = "claimed";
    message.claimedByAgentId = agent.id;
    message.leaseUntil = leaseUntil;
    message.updatedAt = now.toISOString();
    ticket.status = "running";
    ticket.leaseUntil = leaseUntil;
    ticket.attempt += 1;
    ticket.execution = {
      ...(ticket.execution ?? {}),
      sliceStatus: "running"
    };
    ticket.updatedAt = now.toISOString();
    return { ticket, message };
  }

  ack(ticketId: string, result: unknown, now = new Date()): Ticket | undefined {
    const ticket = this.tickets.get(ticketId);
    if (!ticket) return undefined;
    ticket.status = "completed";
    ticket.result = result;
    ticket.leaseUntil = undefined;
    ticket.execution = {
      ...(ticket.execution ?? {}),
      sliceStatus: "idle"
    };
    ticket.updatedAt = now.toISOString();
    for (const message of this.allMessages().filter((item) => item.ticketId === ticketId && item.status === "claimed")) {
      message.status = "acked";
      message.leaseUntil = undefined;
      message.updatedAt = now.toISOString();
    }
    return ticket;
  }

  blockTicket(ticketId: string, blocker: TicketBlocker, now = new Date()): Ticket | undefined {
    const ticket = this.tickets.get(ticketId);
    if (!ticket) return undefined;
    ticket.status = "blocked";
    ticket.blocker = blocker;
    ticket.leaseUntil = undefined;
    ticket.execution = {
      ...(ticket.execution ?? {}),
      sliceStatus: "idle"
    };
    ticket.updatedAt = now.toISOString();
    return ticket;
  }

  yieldTicket(ticketId: string, input: YieldTicketInput, now = new Date()): Ticket | undefined {
    const ticket = this.tickets.get(ticketId);
    if (!ticket) return undefined;
    const continuationCount = (ticket.execution?.continuationCount ?? 0) + 1;
    ticket.status = "pending";
    ticket.leaseUntil = undefined;
    ticket.execution = {
      ...(ticket.execution ?? {}),
      sliceStatus: "yielded",
      yieldedAt: now.toISOString(),
      yieldReason: input.reason,
      continuationCount,
      lastAssignmentRunId: input.assignmentRunId,
      nextRunAfter: input.nextRunAfter
    };
    ticket.updatedAt = now.toISOString();

    const related = this.allMessages().filter((message) => message.ticketId === ticketId);
    const reusable = related.find((message) => message.status === "claimed" || message.status === "expired" || message.status === "pending");
    if (reusable) {
      reusable.status = "pending";
      reusable.claimedByAgentId = undefined;
      reusable.leaseUntil = undefined;
      reusable.updatedAt = now.toISOString();
    } else {
      this.deliver(ticket, now);
    }
    return ticket;
  }

  reopenBlockedTicket(ticketId: string, now = new Date()): Ticket | undefined {
    const ticket = this.tickets.get(ticketId);
    if (!ticket || ticket.status !== "blocked") return undefined;
    ticket.status = "pending";
    ticket.blocker = undefined;
    ticket.leaseUntil = undefined;
    ticket.execution = {
      ...(ticket.execution ?? {}),
      sliceStatus: "idle"
    };
    ticket.updatedAt = now.toISOString();

    const related = this.allMessages().filter((message) => message.ticketId === ticketId);
    const reusable = related.find((message) => message.status === "claimed" || message.status === "expired" || message.status === "pending");
    if (reusable) {
      reusable.status = "pending";
      reusable.claimedByAgentId = undefined;
      reusable.leaseUntil = undefined;
      reusable.updatedAt = now.toISOString();
    } else {
      this.deliver(ticket, now);
    }
    return ticket;
  }

  completeHumanAction(ticketId: string, action: HumanTicketAction, now = new Date()): Ticket | undefined {
    const ticket = this.tickets.get(ticketId);
    if (!ticket) return undefined;
    if (ticket.type === "qa" && ticket.blocker?.type === "manual_test_required") {
      if (action.action === "manual_test_passed") {
        this.ack(ticket.id, { humanAction: action }, now);
        return this.createTicket({
          workspaceId: ticket.workspaceId,
          taskId: ticket.taskId,
          taskRunId: ticket.taskRunId,
          type: "boss_acceptance",
          brief: "验收已通过人工测试的交付物",
          expectedArtifact: "验收结论",
          targetRole: "boss",
          parentTicketId: ticket.id,
          createdByTicketId: ticket.id
        }, now);
      }
      if (action.action === "manual_test_failed") {
        ticket.status = "returned";
        ticket.returnReason = action.message;
        ticket.updatedAt = now.toISOString();
        return this.createTicket({
          workspaceId: ticket.workspaceId,
          taskId: ticket.taskId,
          taskRunId: ticket.taskRunId,
          type: "rework",
          brief: `根据测试打回返工：${action.message}`,
          expectedArtifact: "修复后的交付物",
          targetRole: "dev",
          parentTicketId: ticket.id,
          createdByTicketId: ticket.id,
          returnReason: action.message
        }, now);
      }
    }
    return undefined;
  }

  cancelOpenTickets(reason: string, now = new Date()): void {
    const timestamp = now.toISOString();
    for (const ticket of this.tickets.values()) {
      if (ticket.status !== "pending" && ticket.status !== "running" && ticket.status !== "blocked") continue;
      ticket.status = "cancelled";
      ticket.returnReason = reason;
      ticket.leaseUntil = undefined;
      ticket.updatedAt = timestamp;
    }
    for (const message of this.messages.values()) {
      if (message.status !== "pending" && message.status !== "claimed") continue;
      message.status = "cancelled";
      message.leaseUntil = undefined;
      message.updatedAt = timestamp;
    }
  }

  cancelOpenDescendants(rootTicketId: string, reason: string, now = new Date()): void {
    const timestamp = now.toISOString();
    const descendantIds = new Set<string>();
    let changed = true;
    while (changed) {
      changed = false;
      for (const ticket of this.tickets.values()) {
        if (ticket.id === rootTicketId || descendantIds.has(ticket.id)) continue;
        const linkedToRoot = ticket.parentTicketId === rootTicketId
          || ticket.createdByTicketId === rootTicketId
          || ticket.dependsOnTicketIds?.includes(rootTicketId);
        const linkedToDescendant = ticket.parentTicketId && descendantIds.has(ticket.parentTicketId)
          || ticket.createdByTicketId && descendantIds.has(ticket.createdByTicketId)
          || ticket.dependsOnTicketIds?.some((id) => descendantIds.has(id));
        if (!linkedToRoot && !linkedToDescendant) continue;
        descendantIds.add(ticket.id);
        changed = true;
      }
    }

    for (const ticketId of descendantIds) {
      const ticket = this.tickets.get(ticketId);
      if (!ticket || (ticket.status !== "pending" && ticket.status !== "running" && ticket.status !== "blocked")) continue;
      ticket.status = "cancelled";
      ticket.returnReason = reason;
      ticket.leaseUntil = undefined;
      ticket.updatedAt = timestamp;
      for (const message of this.messages.values()) {
        if (message.ticketId !== ticketId || (message.status !== "pending" && message.status !== "claimed" && message.status !== "expired")) continue;
        message.status = "cancelled";
        message.leaseUntil = undefined;
        message.updatedAt = timestamp;
      }
    }
  }

  private deliver(ticket: Ticket, now = new Date()): AgentInboxMessage {
    const createdAt = now.toISOString();
    const message: AgentInboxMessage = {
      id: createId("msg"),
      workspaceId: ticket.workspaceId,
      ticketId: ticket.id,
      toAgentId: ticket.targetAgentId,
      toRole: ticket.targetRole,
      status: "pending",
      dedupeKey: `${ticket.taskRunId}:${ticket.id}`,
      correlationId: ticket.parentTicketId ?? ticket.id,
      priority: ticket.priority,
      createdAt,
      updatedAt: createdAt
    };
    this.messages.set(message.id, message);
    return message;
  }

  private dependenciesSatisfied(ticket: Ticket): boolean {
    const dependencies = ticket.dependsOnTicketIds ?? [];
    return dependencies.every((id) => {
      const dependency = this.tickets.get(id);
      return dependency?.status === "completed" || dependency?.status === "returned";
    });
  }

  private expireLeases(now: Date): void {
    for (const message of this.messages.values()) {
      if (message.status !== "claimed" || !message.leaseUntil) continue;
      if (new Date(message.leaseUntil).getTime() > now.getTime()) continue;
      message.status = "expired";
      message.updatedAt = now.toISOString();
      const ticket = this.tickets.get(message.ticketId);
      if (ticket && ticket.status === "running") {
        ticket.status = "pending";
        ticket.leaseUntil = undefined;
        ticket.updatedAt = now.toISOString();
        this.deliver(ticket, now);
      }
    }
  }
}

export function createTicketRuntime(tickets?: Ticket[], messages?: AgentInboxMessage[]): TicketRuntime {
  return new TicketRuntime(
    new Map((tickets ?? []).map((ticket) => [ticket.id, ticket])),
    new Map((messages ?? []).map((message) => [message.id, message]))
  );
}
