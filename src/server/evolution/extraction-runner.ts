import type { Workspace } from "../../shared/types.js";
import type { ExtractionJob } from "../../shared/contracts/evolution.js";
import { ExperienceReconciler } from "./experience-reconciler.js";
import { ExtractionJobStore } from "./extraction-job-store.js";

export class ExtractionRunner {
  constructor(
    private readonly workspace: Workspace,
    private readonly jobs = new ExtractionJobStore(workspace.id, workspace.rootPath),
    private readonly reconcile: () => Promise<NonNullable<ExtractionJob["result"]>> = () => new ExperienceReconciler(workspace).reconcile(),
  ) {}

  async runNext(workerId: string): Promise<ExtractionJob | undefined> {
    const job = await this.jobs.claim(workerId);
    if (!job?.lease) return undefined;
    try {
      const result = await this.reconcile();
      return await this.jobs.succeed(job.jobId, job.lease.token, result);
    } catch (error) {
      const category = isTerminal(error) ? "terminal" : "transient";
      return this.jobs.fail(job.jobId, job.lease.token, { category, message: error instanceof Error ? error.message : String(error) });
    }
  }
}

function isTerminal(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "status" in error && typeof (error as { status?: unknown }).status === "number" && (error as { status: number }).status >= 400 && (error as { status: number }).status < 500);
}
