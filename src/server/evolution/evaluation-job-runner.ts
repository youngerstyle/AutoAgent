import type { EvaluationJob } from "../../shared/contracts/evolution.js";
import { HttpError } from "../errors.js";
import type { EvolutionEvaluationRunner } from "./evaluation-runner.js";
import type { EvolutionEvaluationStore } from "./evaluation-store.js";
import type { EvaluationJobStore } from "./evaluation-job-store.js";

export class EvaluationJobRunner {
  constructor(
    private readonly jobs: EvaluationJobStore,
    private readonly evaluations: EvolutionEvaluationStore,
    private readonly runner: EvolutionEvaluationRunner,
    private readonly leaseMs = 30_000,
  ) {}

  async runNext(workerId: string): Promise<EvaluationJob | undefined> {
    const job = await this.jobs.claim(workerId, this.leaseMs);
    if (!job?.lease) return undefined;
    const token = job.lease.token;
    const evaluationCommand = `evaluation-job:${job.jobId}`;
    let heartbeatFailure: unknown;
    const heartbeat = setInterval(() => {
      void this.jobs.heartbeat(job.jobId, token, this.leaseMs).catch((error) => { heartbeatFailure = error; });
    }, Math.max(500, Math.floor(this.leaseMs / 3)));
    heartbeat.unref?.();
    try {
      const replay = await this.evaluations.getEvaluationByCommand(evaluationCommand);
      const evaluation = replay ?? await this.runner.run({ ...job.request, commandId: evaluationCommand });
      if (heartbeatFailure) throw heartbeatFailure;
      return await this.jobs.succeed(job.jobId, token, { evaluationId: evaluation.evaluationId, decision: evaluation.decision });
    } catch (error) {
      const category = isTerminal(error) ? "terminal" : "transient";
      try {
        return await this.jobs.fail(job.jobId, token, { category, message: error instanceof Error ? error.message : String(error) });
      } catch (leaseError) {
        if (leaseError instanceof HttpError && leaseError.code === "EVOLUTION_EVALUATION_JOB_CONFLICT") return this.jobs.get(job.jobId);
        throw leaseError;
      }
    } finally {
      clearInterval(heartbeat);
    }
  }
}

function isTerminal(error: unknown): boolean {
  if (!(error instanceof HttpError)) return false;
  return error.status >= 400 && error.status < 500 && error.status !== 408;
}
