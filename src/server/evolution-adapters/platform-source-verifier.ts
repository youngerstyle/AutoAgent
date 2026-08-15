import type { EvolutionSourceRef } from "../../shared/contracts/evolution.js";
import { AgentStore } from "../agent-engine/agent-store.js";
import { EvidenceLedger } from "../agent-engine/evidence-ledger.js";
import { AgentTraceStore } from "../agent-engine/trace-store.js";
import type { EvolutionSourceVerificationPort } from "../evolution/source-verification-port.js";
import { MissionStore } from "../mission-process/mission-store.js";
import { TicketStore } from "../tickets/ticket-store.js";
import { EvolutionStore, type EvolutionScopeAuthority } from "../evolution/evolution-store.js";

export class PlatformEvolutionSourceVerifier implements EvolutionSourceVerificationPort {
  constructor(private readonly workspaceId: string, private readonly workspaceRoot: string) {}

  async verify(ref: EvolutionSourceRef): Promise<boolean> {
    if (ref.workspaceId !== this.workspaceId) return false;
    if (ref.kind === "evidence" || ref.kind === "human_feedback") return Boolean(await new EvidenceLedger(this.workspaceRoot).get(ref.ref));
    if (ref.kind === "trace") return Boolean(ref.agentId && (await new AgentTraceStore(this.workspaceRoot, ref.agentId).list()).some((trace) => trace.traceId === ref.ref));
    if (ref.kind === "goal_proposal" || ref.kind === "goal_decision") {
      if (!ref.agentId) return false;
      const aggregate = await new AgentStore(this.workspaceRoot, ref.agentId).read();
      return ref.kind === "goal_proposal" ? aggregate.proposals.some((item) => item.proposalId === ref.ref) : aggregate.decisions.some((item) => item.decisionId === ref.ref);
    }
    if (ref.kind === "mission") return Boolean(await new MissionStore(this.workspaceRoot, ref.ref).read());
    if (ref.kind === "ticket") {
      if (!ref.taskId || !ref.taskRunId) return false;
      const tickets = new TicketStore(this.workspaceRoot, ref.taskId, ref.taskRunId);
      for (const planId of await tickets.listPlanIds()) if ((await tickets.read(planId))?.tickets.some((item) => item.ticketId === ref.ref)) return true;
    }
    return false;
  }
}

export function platformEvolutionStore(
  workspaceId: string,
  workspaceRoot: string,
  now: () => Date = () => new Date(),
  authority: EvolutionScopeAuthority = {},
): EvolutionStore {
  return new EvolutionStore(workspaceId, workspaceRoot, now, authority, new PlatformEvolutionSourceVerifier(workspaceId, workspaceRoot));
}
