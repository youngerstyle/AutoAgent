import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import type { EvolutionSourcePatchArtifact } from "../../shared/contracts/evolution.js";
import type { EvolutionProviderAttestation, ScmPreparedChange, ScmProvider } from "./delivery-providers.js";

export interface LocalGitCheckCommand {
  program: string;
  args?: string[];
  timeoutMs?: number;
}
export interface LocalGitRepositoryConfig {
  root: string;
  targetBranch: string;
  checks: Record<string, LocalGitCheckCommand>;
}
export interface LocalGitReviewerDecision {
  reviewerId: string;
  approved: boolean;
  evidence: string;
}
export interface LocalGitScmProviderOptions {
  repositories: Record<string, LocalGitRepositoryConfig>;
  attestationRoot: string;
  reviewer(change: ScmPreparedChange): Promise<LocalGitReviewerDecision>;
  tempRoot?: string;
  now?: () => Date;
}

interface LocalChangeState {
  change: ScmPreparedChange;
  requiredChecks?: string[];
  checkAttestations?: EvolutionProviderAttestation[];
  reviewAttestation?: EvolutionProviderAttestation;
}

/**
 * Cross-platform development adapter. It invokes Git directly (no shell),
 * applies mutations in disposable worktrees, and only fast-forwards the
 * configured target ref after persisted checks and independent review pass.
 */
export class LocalGitScmProvider implements ScmProvider {
  readonly providerId = "local-git/v1";
  private readonly now: () => Date;
  constructor(private readonly options: LocalGitScmProviderOptions) { this.now = options.now ?? (() => new Date()); }

  async currentRevision(repositoryId: string): Promise<string> {
    const repository = await this.repository(repositoryId);
    return (await run("git", ["rev-parse", `refs/heads/${repository.targetBranch}`], repository.root)).stdout.trim();
  }

  async prepareChange(input: { candidateId: string; contentHash: string; artifact: EvolutionSourcePatchArtifact }): Promise<ScmPreparedChange> {
    const repository = await this.repository(input.artifact.repositoryId);
    if (input.artifact.targetBranch !== repository.targetBranch) throw new Error("Source Patch target branch is not configured for this repository");
    if (await this.currentRevision(input.artifact.repositoryId) !== input.artifact.baseCommit) throw new Error("Source Patch base commit is stale");
    const branch = `evol/${sanitize(input.candidateId)}-${input.contentHash.slice(0, 12)}`;
    const candidateCommit = await this.withWorktree(repository, input.artifact.baseCommit, async (worktree) => {
      await run("git", ["apply", "--check", "--whitespace=error", "-"], worktree, input.artifact.patch);
      await run("git", ["apply", "--whitespace=error", "-"], worktree, input.artifact.patch);
      await run("git", ["add", "--all"], worktree);
      const changedFiles = (await run("git", ["diff", "--cached", "--name-only", "--diff-filter=ACDMRTUXB"], worktree)).stdout.split(/\r?\n/).filter(Boolean).sort();
      const declaredFiles = [...input.artifact.files].sort();
      if (canonical(changedFiles) !== canonical(declaredFiles)) throw new Error("Applied Source Patch changed files outside its declared MutationSet");
      await run("git", ["-c", "user.name=AutoAgent Evol", "-c", "user.email=evol@autoagent.invalid", "commit", "-m", `evol: ${input.candidateId}`], worktree);
      return (await run("git", ["rev-parse", "HEAD"], worktree)).stdout.trim();
    });
    await run("git", ["update-ref", `refs/heads/${branch}`, candidateCommit], repository.root);
    const change: ScmPreparedChange = {
      provider: this.providerId, repositoryId: input.artifact.repositoryId, baseCommit: input.artifact.baseCommit,
      changeRef: branch, candidateCommit,
    };
    await this.writeState({ change });
    return change;
  }

  async requiredChecks(change: ScmPreparedChange, names: string[]): Promise<EvolutionProviderAttestation[]> {
    const state = await this.requireState(change);
    const repository = await this.repository(change.repositoryId);
    const attestations = await this.withWorktree(repository, change.candidateCommit, async (worktree) => {
      const values: EvolutionProviderAttestation[] = [];
      for (const name of names) {
        const command = repository.checks[name];
        if (!command) throw new Error(`Required check is not configured: ${name}`);
        let result: ProcessResult;
        try { result = await run(command.program, command.args ?? [], worktree, undefined, command.timeoutMs ?? 120_000); }
        catch (error) { result = processFailure(error); }
        values.push(await this.attest(name, change.candidateCommit, result.exitCode === 0 ? "passed" : "failed", {
          kind: "required_check", command: { program: command.program, args: command.args ?? [] }, exitCode: result.exitCode,
          stdout: tail(result.stdout), stderr: tail(result.stderr), candidateCommit: change.candidateCommit,
        }));
      }
      return values;
    });
    await this.writeState({ ...state, requiredChecks: [...names], checkAttestations: attestations });
    return attestations;
  }

  async review(change: ScmPreparedChange): Promise<EvolutionProviderAttestation> {
    const state = await this.requireState(change);
    const decision = await this.options.reviewer(change);
    if (!decision.reviewerId.trim() || !decision.evidence.trim()) throw new Error("Local Git reviewer returned incomplete provenance");
    const attestation = await this.attest("review", change.candidateCommit, decision.approved ? "passed" : "failed", {
      kind: "independent_review", reviewerId: decision.reviewerId, evidence: decision.evidence, candidateCommit: change.candidateCommit,
    });
    await this.writeState({ ...state, reviewAttestation: attestation });
    return attestation;
  }

  async merge(change: ScmPreparedChange): Promise<{ mergeCommit: string; attestation: EvolutionProviderAttestation }> {
    const state = await this.requireState(change);
    const repository = await this.repository(change.repositoryId);
    if (!state.requiredChecks?.length || state.checkAttestations?.length !== state.requiredChecks.length
      || state.checkAttestations.some((item) => item.status !== "passed") || state.reviewAttestation?.status !== "passed") {
      throw new Error("Local Git protected branch requires passing checks and independent review");
    }
    const current = await this.currentRevision(change.repositoryId);
    if (current !== change.baseCommit) throw new Error("Local Git protected branch moved after Candidate preparation");
    await run("git", ["update-ref", `refs/heads/${repository.targetBranch}`, change.candidateCommit, change.baseCommit], repository.root);
    const attestation = await this.attest("merge", change.candidateCommit, "passed", {
      kind: "protected_ref_update", repositoryId: change.repositoryId, targetBranch: repository.targetBranch,
      previousCommit: change.baseCommit, mergeCommit: change.candidateCommit,
    });
    return { mergeCommit: change.candidateCommit, attestation };
  }

  private async repository(repositoryId: string): Promise<LocalGitRepositoryConfig> {
    const configured = this.options.repositories[repositoryId];
    if (!configured) throw new Error(`Local Git repository is not configured: ${repositoryId}`);
    const root = path.resolve(configured.root);
    const bare = (await run("git", ["rev-parse", "--is-bare-repository"], root)).stdout.trim() === "true";
    const actual = path.resolve((await run("git", ["rev-parse", bare ? "--absolute-git-dir" : "--show-toplevel"], root)).stdout.trim());
    if (actual.toLowerCase() !== root.toLowerCase()) throw new Error("Configured Local Git root is not the repository top level");
    if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(configured.targetBranch)) throw new Error("Configured Local Git target branch is invalid");
    if (!bare) {
      const checkedOut = (await run("git", ["symbolic-ref", "--quiet", "--short", "HEAD"], root).catch(() => ({ stdout: "", stderr: "", exitCode: 1 }))).stdout.trim();
      if (checkedOut === configured.targetBranch) throw new Error("Local Git protected target branch must not be the current service checkout");
    }
    return { ...configured, root };
  }

  private async withWorktree<T>(repository: LocalGitRepositoryConfig, revision: string, operation: (worktree: string) => Promise<T>): Promise<T> {
    const tempRoot = path.resolve(this.options.tempRoot ?? os.tmpdir());
    await mkdir(tempRoot, { recursive: true });
    const worktree = await mkdtemp(path.join(tempRoot, "autoagent-evol-worktree-"));
    let attached = false;
    try {
      await run("git", ["worktree", "add", "--detach", worktree, revision], repository.root);
      attached = true;
      return await operation(worktree);
    } finally {
      if (attached) await run("git", ["worktree", "remove", "--force", worktree], repository.root).catch(() => undefined);
      await rm(worktree, { recursive: true, force: true });
    }
  }

  private stateFile(changeRef: string): string { return path.join(path.resolve(this.options.attestationRoot), "changes", `${hash(changeRef)}.json`); }
  private async requireState(change: ScmPreparedChange): Promise<LocalChangeState> {
    let state: LocalChangeState;
    try { state = JSON.parse(await readFile(this.stateFile(change.changeRef), "utf8")) as LocalChangeState; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error("Local Git change provenance is missing"); throw error; }
    if (canonical(state.change) !== canonical(change)) throw new Error("Local Git change provenance does not match the requested change");
    return state;
  }
  private async writeState(state: LocalChangeState): Promise<void> {
    const file = this.stateFile(state.change.changeRef);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, `${JSON.stringify(state)}\n`, { encoding: "utf8", mode: 0o600 });
  }
  private async attest(subject: string, revision: string, status: "passed" | "failed", evidence: unknown): Promise<EvolutionProviderAttestation> {
    const observedAt = this.now().toISOString();
    const id = hash(canonical({ provider: this.providerId, subject, revision, status, observedAt, evidence }));
    const file = path.join(path.resolve(this.options.attestationRoot), "attestations", `${id}.json`);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, `${JSON.stringify({ schemaVersion: 1, provider: this.providerId, subject, revision, status, observedAt, evidence })}\n`, { encoding: "utf8", mode: 0o600 });
    return { provider: this.providerId, subject, revision, status, observedAt, evidenceRef: `local-attestation:${id}` };
  }
}

interface ProcessResult { exitCode: number; stdout: string; stderr: string }
function run(program: string, args: string[], cwd: string, input?: string, timeoutMs = 60_000): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { cwd, shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = ""; let stderr = ""; let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; }); child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", (code) => {
      clearTimeout(timer);
      const result = { exitCode: timedOut ? 124 : code ?? 1, stdout, stderr };
      if (result.exitCode === 0) resolve(result);
      else reject(Object.assign(new Error(`${program} exited with ${result.exitCode}: ${tail(stderr || stdout)}`), { processResult: result }));
    });
    child.stdin.end(input);
  });
}
function processFailure(error: unknown): ProcessResult {
  const value = error as { processResult?: ProcessResult };
  return value.processResult ?? { exitCode: 1, stdout: "", stderr: error instanceof Error ? error.message : String(error) };
}
function sanitize(value: string): string { return value.replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 80); }
function tail(value: string): string { return value.length <= 8_000 ? value : value.slice(-8_000); }
function hash(value: string): string { return createHash("sha256").update(value, "utf8").digest("hex"); }
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value);
}
