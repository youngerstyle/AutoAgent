import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import type {
  EvolutionActivationRecord,
  EvolutionCandidate,
  EvolutionInheritanceProof,
  PromotionRecord,
  ReleaseTelemetry,
  VersionedEvolutionRef,
} from "../../shared/contracts/evolution.js";
import { DEFAULT_EVOLUTION_ACTIVATION_BOUNDARY } from "../../shared/contracts/evolution.js";
import { workspaceEvolutionActivationLedgerFile } from "../storage/paths.js";

type ActivationEvent =
  | { type: "activation.requested"; commandId: string; occurredAt: string; activation: EvolutionActivationRecord }
  | { type: "activation.pointer_changed"; commandId: string; occurredAt: string; activation: EvolutionActivationRecord }
  | { type: "activation.inherited"; commandId: string; occurredAt: string; activationId: string; proof: EvolutionInheritanceProof }
  | { type: "activation.health_observed"; commandId: string; occurredAt: string; activationId: string; telemetryId: string; health: "healthy" | "degraded" | "inconclusive" }
  | { type: "activation.rolled_back"; commandId: string; occurredAt: string; activationId: string }
  | { type: "activation.superseded"; commandId: string; occurredAt: string; activationId: string };

interface ActivationProjection {
  activations: Map<string, EvolutionActivationRecord>;
  proofs: Map<string, EvolutionInheritanceProof>;
  commands: Map<string, ActivationEvent>;
}

const queues = new Map<string, Promise<void>>();

export class EvolutionActivationStore {
  private readonly file: string;

  constructor(private readonly workspaceRoot: string, private readonly now: () => Date = () => new Date()) {
    this.file = workspaceEvolutionActivationLedgerFile(workspaceRoot);
  }

  async list(): Promise<EvolutionActivationRecord[]> {
    return [...(await this.project()).activations.values()]
      .sort((left, right) => left.requestedAt.localeCompare(right.requestedAt) || left.activationId.localeCompare(right.activationId));
  }

  async listProofs(activationId?: string): Promise<EvolutionInheritanceProof[]> {
    return [...(await this.project()).proofs.values()]
      .filter((proof) => !activationId || proof.activationId === activationId)
      .sort((left, right) => left.observedAt.localeCompare(right.observedAt) || left.proofId.localeCompare(right.proofId));
  }

  async recordPointerChanged(record: PromotionRecord, candidate: EvolutionCandidate, desiredGeneration: number, previousRelease?: VersionedEvolutionRef): Promise<EvolutionActivationRecord | undefined> {
    if (record.stage === "shadow") return undefined;
    let state = await this.project();
    const replay = state.commands.get(`pointer:${record.promotionId}`);
    if (replay?.type === "activation.pointer_changed") return structuredClone(state.activations.get(replay.activation.activationId));
    const requested = await this.recordRequested(record, candidate, desiredGeneration, previousRelease);
    if (!requested) return undefined;
    state = await this.project();
    const timestamp = this.now().toISOString();
    const activation: EvolutionActivationRecord = { ...requested, pointerChangedAt: timestamp };
    await this.append({ type: "activation.pointer_changed", commandId: `pointer:${record.promotionId}`, occurredAt: timestamp, activation });
    return structuredClone((await this.project()).activations.get(activation.activationId));
  }

  /** Records a pointer owned by a shared Agent/Company layer without pretending it is a local Candidate promotion. */
  async recordSharedPointer(input: {
    promotionId: string;
    candidateId: string;
    assetKind: EvolutionActivationRecord["assetKind"];
    target: string;
    scope: EvolutionActivationRecord["scope"];
    releaseRef: VersionedEvolutionRef;
    desiredGeneration: number;
    previousRelease?: VersionedEvolutionRef;
  }): Promise<EvolutionActivationRecord> {
    if (!input.promotionId || !input.candidateId || !input.target || !Number.isSafeInteger(input.desiredGeneration) || input.desiredGeneration < 1) throw new Error("Shared evolution activation input is invalid");
    const commandId = `shared-pointer:${input.promotionId}:${input.desiredGeneration}`;
    const state = await this.project();
    const replay = state.commands.get(commandId);
    if (replay?.type === "activation.pointer_changed") return structuredClone(replay.activation);
    const timestamp = this.now().toISOString();
    const activation: EvolutionActivationRecord = {
      activationId: stableId("activation-shared", input.promotionId, input.releaseRef.contentHash, String(input.desiredGeneration)),
      promotionId: input.promotionId,
      activationKind: "release",
      candidateId: input.candidateId,
      assetKind: input.assetKind,
      target: input.target,
      stage: "production",
      boundary: DEFAULT_EVOLUTION_ACTIVATION_BOUNDARY[input.assetKind],
      desiredGeneration: input.desiredGeneration,
      releaseRef: structuredClone(input.releaseRef),
      ...(input.previousRelease ? { previousRelease: structuredClone(input.previousRelease) } : {}),
      scope: structuredClone(input.scope),
      status: "waiting_for_activation",
      requestedAt: timestamp,
      pointerChangedAt: timestamp,
      proofCount: 0,
    };
    await this.append({ type: "activation.requested", commandId: `${commandId}:requested`, occurredAt: timestamp, activation: { ...activation, pointerChangedAt: undefined } });
    await this.append({ type: "activation.pointer_changed", commandId, occurredAt: timestamp, activation });
    return structuredClone((await this.project()).activations.get(activation.activationId)!);
  }

  async recordRequested(record: PromotionRecord, candidate: EvolutionCandidate, desiredGeneration: number, previousRelease?: VersionedEvolutionRef): Promise<EvolutionActivationRecord | undefined> {
    if (record.stage === "shadow") return undefined;
    const state = await this.project();
    const commandId = `request:${record.promotionId}`;
    const replay = state.commands.get(commandId);
    if (replay?.type === "activation.requested") return structuredClone(state.activations.get(replay.activation.activationId));
    const alreadyProjected = [...state.activations.values()].find((item) => item.promotionId === record.promotionId
      && item.releaseRef.id === record.toRelease.id && item.releaseRef.contentHash === record.toRelease.contentHash);
    if (alreadyProjected) return structuredClone(alreadyProjected);
    const activationId = stableId("activation", record.promotionId, record.toRelease.contentHash);
    const timestamp = this.now().toISOString();
    const activation: EvolutionActivationRecord = {
      activationId, promotionId: record.promotionId, activationKind: "release", candidateId: candidate.candidateId,
      assetKind: candidate.kind, target: candidate.target, stage: record.stage,
      boundary: candidate.mutationSet?.activationBoundary ?? DEFAULT_EVOLUTION_ACTIVATION_BOUNDARY[candidate.kind],
      desiredGeneration, releaseRef: structuredClone(record.toRelease),
      ...(previousRelease ? { previousRelease: structuredClone(previousRelease) } : {}),
      scope: structuredClone(candidate.scope), status: "waiting_for_activation", requestedAt: timestamp, proofCount: 0,
    };
    await this.append({ type: "activation.requested", commandId, occurredAt: timestamp, activation });
    return structuredClone((await this.project()).activations.get(activationId));
  }

  async observe(input: Omit<EvolutionInheritanceProof, "proofId" | "activationId" | "boundary" | "observedAt">): Promise<EvolutionInheritanceProof | undefined> {
    const state = await this.project();
    const activation = [...state.activations.values()].find((item) =>
      item.status !== "rolled_back" && item.status !== "superseded"
      && Boolean(item.pointerChangedAt)
      && item.assetKind === input.assetKind && item.target === input.target
      && item.releaseRef.id === input.releaseRef.id && item.releaseRef.contentHash === input.releaseRef.contentHash
      && item.desiredGeneration === input.desiredGeneration);
    if (!activation) return undefined;
    if (input.actualGeneration !== input.desiredGeneration) throw new Error("Evolution inheritance proof generation does not match the active pointer");
    if (!runtimeSatisfiesBoundary(activation.boundary, input.runtimeKind)) throw new Error(`Evolution ${activation.boundary} activation cannot be proved by ${input.runtimeKind} runtime`);
    if (!/^[a-f0-9]{64}$/.test(input.runtimeSnapshotHash)) throw new Error("Evolution inheritance proof snapshot hash is invalid");
    const proofId = stableId("inheritance", activation.activationId, input.runtimeKind, input.runtimeRef, input.runtimeSnapshotHash);
    const existing = state.proofs.get(proofId);
    if (existing) return structuredClone(existing);
    const observedAt = this.now().toISOString();
    const proof: EvolutionInheritanceProof = {
      ...structuredClone(input), proofId, activationId: activation.activationId,
      boundary: activation.boundary, observedAt,
    };
    await this.append({ type: "activation.inherited", commandId: `inheritance:${proofId}`, occurredAt: observedAt, activationId: activation.activationId, proof });
    return (await this.project()).proofs.get(proofId);
  }

  async recordRollback(record: PromotionRecord): Promise<void> {
    if (record.stage === "shadow") return;
    return this.recordPromotionRollback(record.promotionId, `rollback:${record.promotionId}`);
  }

  async recordPromotionRollback(promotionId: string, commandId = `rollback:${promotionId}`): Promise<void> {
    const state = await this.project();
    const activation = [...state.activations.values()].find((item) => item.promotionId === promotionId);
    if (!activation) return;
    if (state.commands.has(commandId)) return;
    const occurredAt = this.now().toISOString();
    await this.append({ type: "activation.rolled_back", commandId, occurredAt, activationId: activation.activationId });
  }

  /** Create a new desired generation for the known-good release restored by rollback. */
  async recordRestoration(
    rollbackOfPromotionId: string,
    restoredRelease: VersionedEvolutionRef,
    desiredGeneration: number,
    commandId = `rollback-restore:${rollbackOfPromotionId}:${desiredGeneration}`,
  ): Promise<EvolutionActivationRecord | undefined> {
    const state = await this.project();
    const replay = state.commands.get(commandId);
    if (replay?.type === "activation.pointer_changed") return structuredClone(state.activations.get(replay.activation.activationId));
    const source = [...state.activations.values()].find((item) => item.promotionId === rollbackOfPromotionId && item.activationKind !== "rollback_restore");
    if (!source) return undefined;
    if (!Number.isSafeInteger(desiredGeneration) || desiredGeneration <= source.desiredGeneration) throw new Error("Rollback restoration generation must advance the active pointer");
    const timestamp = this.now().toISOString();
    const activationId = stableId("activation-restore", rollbackOfPromotionId, restoredRelease.id, restoredRelease.contentHash, String(desiredGeneration));
    const requested: EvolutionActivationRecord = {
      activationId, promotionId: `rollback:${rollbackOfPromotionId}:${desiredGeneration}`,
      activationKind: "rollback_restore", rollbackOfPromotionId, candidateId: source.candidateId,
      assetKind: source.assetKind, target: source.target, stage: source.stage, boundary: source.boundary,
      desiredGeneration, releaseRef: structuredClone(restoredRelease), previousRelease: structuredClone(source.releaseRef),
      scope: structuredClone(source.scope), status: "waiting_for_activation", requestedAt: timestamp, proofCount: 0,
    };
    await this.append({ type: "activation.requested", commandId: `${commandId}:requested`, occurredAt: timestamp, activation: requested });
    const activation = { ...requested, pointerChangedAt: this.now().toISOString() };
    await this.append({ type: "activation.pointer_changed", commandId, occurredAt: activation.pointerChangedAt, activation });
    return structuredClone((await this.project()).activations.get(activationId));
  }

  async recordSuperseded(promotionId: string): Promise<void> {
    const state = await this.project();
    const activation = [...state.activations.values()].find((item) => item.promotionId === promotionId);
    if (!activation || activation.status === "superseded") return;
    if (state.commands.has(`supersede:${promotionId}`)) return;
    const occurredAt = this.now().toISOString();
    await this.append({ type: "activation.superseded", commandId: `supersede:${promotionId}`, occurredAt, activationId: activation.activationId });
  }

  async recordHealth(promotionId: string, telemetry: Pick<ReleaseTelemetry, "telemetryId" | "decision">): Promise<EvolutionActivationRecord | undefined> {
    const state = await this.project();
    const activation = [...state.activations.values()].find((item) => item.promotionId === promotionId);
    if (!activation) return undefined;
    const commandId = `health:${promotionId}:${telemetry.telemetryId}`;
    if (state.commands.has(commandId)) return structuredClone(activation);
    const occurredAt = this.now().toISOString();
    const health = telemetry.decision === "pass" ? "healthy" : telemetry.decision === "fail" ? "degraded" : "inconclusive";
    await this.append({ type: "activation.health_observed", commandId, occurredAt, activationId: activation.activationId, telemetryId: telemetry.telemetryId, health });
    return structuredClone((await this.project()).activations.get(activation.activationId));
  }

  private async append(event: ActivationEvent): Promise<void> {
    const key = this.file.toLowerCase();
    const previous = queues.get(key) ?? Promise.resolve();
    const pending = previous.catch(() => undefined).then(async () => {
      const state = await this.project();
      const replay = state.commands.get(event.commandId);
      if (replay) {
        if (canonical(replay) !== canonical(event)) throw new Error("Evolution activation command conflict");
        return;
      }
      await mkdir(path.dirname(this.file), { recursive: true });
      await appendFile(this.file, `${JSON.stringify(event)}\n`, { encoding: "utf8", mode: 0o600, flush: true });
    });
    const settled = pending.then(() => undefined, () => undefined);
    queues.set(key, settled);
    try { await pending; } finally { if (queues.get(key) === settled) queues.delete(key); }
  }

  private async project(): Promise<ActivationProjection> {
    const activations = new Map<string, EvolutionActivationRecord>();
    const proofs = new Map<string, EvolutionInheritanceProof>();
    const commands = new Map<string, ActivationEvent>();
    for (const event of await readEvents(this.file)) {
      const replay = commands.get(event.commandId);
      if (replay && canonical(replay) !== canonical(event)) throw new Error("Evolution activation ledger command conflict");
      commands.set(event.commandId, event);
      if (event.type === "activation.requested") {
        const existing = activations.get(event.activation.activationId);
        if (existing && (existing.promotionId !== event.activation.promotionId || existing.releaseRef.id !== event.activation.releaseRef.id || existing.releaseRef.contentHash !== event.activation.releaseRef.contentHash)) throw new Error("Evolution activation id conflict");
        if (!existing || !existing.pointerChangedAt) activations.set(event.activation.activationId, structuredClone(event.activation));
      } else if (event.type === "activation.pointer_changed") {
        const existing = activations.get(event.activation.activationId);
        if (existing && (existing.promotionId !== event.activation.promotionId || existing.releaseRef.id !== event.activation.releaseRef.id || existing.releaseRef.contentHash !== event.activation.releaseRef.contentHash)) throw new Error("Evolution activation pointer identity conflict");
        activations.set(event.activation.activationId, structuredClone(event.activation));
      } else if (event.type === "activation.inherited") {
        const activation = activations.get(event.activationId);
        if (!activation) throw new Error("Evolution inheritance proof references a missing activation");
        const existing = proofs.get(event.proof.proofId);
        if (existing && canonical(existing) !== canonical(event.proof)) throw new Error("Evolution inheritance proof id conflict");
        if (!existing) proofs.set(event.proof.proofId, structuredClone(event.proof));
        activations.set(activation.activationId, {
          ...activation, status: "activated", firstInheritedAt: activation.firstInheritedAt ?? event.occurredAt,
          lastInheritedAt: event.occurredAt, proofCount: existing ? activation.proofCount : activation.proofCount + 1,
        });
      } else if (event.type === "activation.health_observed") {
        const activation = activations.get(event.activationId);
        if (!activation) throw new Error("Evolution health observation references a missing activation");
        activations.set(activation.activationId, {
          ...activation, health: event.health, healthTelemetryId: event.telemetryId, healthObservedAt: event.occurredAt,
          ...(event.health === "degraded" && activation.status === "activated" ? { status: "degraded" as const } : {}),
        });
      } else {
        const activation = activations.get(event.activationId);
        if (!activation) throw new Error("Evolution activation terminal event references a missing activation");
        activations.set(activation.activationId, event.type === "activation.rolled_back"
          ? { ...activation, status: "rolled_back", rolledBackAt: event.occurredAt }
          : { ...activation, status: "superseded", supersededAt: event.occurredAt });
      }
    }
    return { activations, proofs, commands };
  }
}

function runtimeSatisfiesBoundary(boundary: EvolutionInheritanceProof["boundary"], runtimeKind: EvolutionInheritanceProof["runtimeKind"]): boolean {
  const allowed: Record<EvolutionInheritanceProof["boundary"], EvolutionInheritanceProof["runtimeKind"][]> = {
    next_turn: ["turn", "session", "task", "process", "deployment"],
    next_session: ["session", "process", "deployment"],
    next_task: ["task", "process", "deployment"],
    next_restart: ["process", "deployment"],
  };
  return allowed[boundary].includes(runtimeKind);
}

async function readEvents(file: string): Promise<ActivationEvent[]> {
  let content: string;
  try { content = await readFile(file, "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  return content.split("\n").filter(Boolean).map((line) => JSON.parse(line) as ActivationEvent);
}
function stableId(...values: string[]): string { return createHash("sha256").update(values.join("\0"), "utf8").digest("hex"); }
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value);
}
