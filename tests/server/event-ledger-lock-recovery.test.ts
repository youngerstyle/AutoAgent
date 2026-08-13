import { mkdir, mkdtemp, open, readdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { EventLedger } from "../../src/server/storage/event-ledger";

const lockPath = (root: string) => path.join(root, ".autoagent", "event-append.lock");
const lockBytes = (filePath: string) => readFile(filePath, null);
const event = (index: number) => ({
  workspaceId: "ws_lock", taskId: "task_lock", taskRunId: `run_${index}`,
  type: "task.created" as const, summary: `event-${index}`, payload: { index },
});
const bounded = { lock: { acquireTimeoutMs: 100, publicationGraceMs: 10, retryDelayMs: 5 } };
// Keep malformed-lock assertions short while allowing the deliberately
// competing append test to tolerate normal filesystem scheduling jitter.
const competing = { lock: { acquireTimeoutMs: 2000, publicationGraceMs: 10, retryDelayMs: 5 } };

async function preparedRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "autoagent-lock-recovery-"));
  await mkdir(path.dirname(lockPath(root)), { recursive: true });
  return root;
}

describe("EventLedger workspace lock recovery", () => {
  it.each(["", "{\"token\":", "not-json", JSON.stringify({ token: "x", pid: 1 })])(
    "does not wait forever for malformed lock %j", async (contents) => {
      const root = await preparedRoot();
      await writeFile(lockPath(root), contents, "utf8");
      const started = Date.now();
      await expect(new EventLedger(undefined, bounded).append(root, event(1))).rejects.toMatchObject({ name: "WorkspaceLockTimeoutError" });
      expect(Date.now() - started).toBeLessThan(1000);
    },
  );

  it("reclaims a valid same-host owner whose process is dead", async () => {
    const root = await preparedRoot();
    await writeFile(lockPath(root), JSON.stringify({ version: 1, token: "dead", pid: 2147483647, hostname: os.hostname(), createdAt: new Date().toISOString(), heartbeatAt: new Date().toISOString(), leaseUntil: new Date(Date.now() + 30000).toISOString(), state: "ready" }), "utf8");
    await expect(new EventLedger(undefined, bounded).append(root, event(2))).resolves.toMatchObject({ workspaceSequence: 1 });
  });

  it("recovers after an injected publication-boundary failure", async () => {
    const root = await preparedRoot();
    const injected = new EventLedger(undefined, {
      lock: {
        ...bounded.lock,
        afterCreateBeforePublish: async () => {
          await writeFile(lockPath(root), JSON.stringify({
            version: 1,
            token: "partial",
            pid: 2147483647,
            hostname: os.hostname(),
            createdAt: new Date().toISOString(),
            heartbeatAt: new Date().toISOString(),
            leaseUntil: new Date(Date.now() + 30000).toISOString(),
            state: "ready",
          }), "utf8");
          throw new Error("injected publication-boundary crash");
        },
      },
    });
    await expect(injected.append(root, event(4))).rejects.toThrow("injected publication-boundary crash");
    await expect(new EventLedger(undefined, bounded).append(root, event(5))).resolves.toMatchObject({ workspaceSequence: 1 });
  });

  it("rejects a foreign owner conservatively within the deadline", async () => {
    const root = await preparedRoot();
    await writeFile(lockPath(root), JSON.stringify({ version: 1, token: "foreign", pid: 1, hostname: "other-host", createdAt: new Date(Date.now() - 2000).toISOString(), heartbeatAt: new Date(Date.now() - 2000).toISOString(), leaseUntil: new Date(Date.now() - 1).toISOString(), state: "ready" }), "utf8");
    const started = Date.now();
    await expect(new EventLedger(undefined, bounded).append(root, event(6))).rejects.toThrow(/foreign-owner/);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("rejects an internally inconsistent v1 owner as malformed", async () => {
    const root = await preparedRoot();
    await writeFile(lockPath(root), JSON.stringify({ version: 1, token: "bad-time", pid: 2147483647, hostname: os.hostname(), createdAt: "not-a-date", heartbeatAt: new Date().toISOString(), leaseUntil: new Date(Date.now() - 1).toISOString(), state: "ready" }), "utf8");
    await expect(new EventLedger(undefined, bounded).append(root, event(7))).rejects.toThrow(/malformed-owner/);
  });

  it("does not remove a live owner and returns a bounded diagnostic", async () => {
    const root = await preparedRoot();
    const owner = { version: 1, token: "live", pid: process.pid, hostname: os.hostname(), createdAt: new Date(Date.now() - 2000).toISOString(), heartbeatAt: new Date(Date.now() - 2000).toISOString(), leaseUntil: new Date(Date.now() - 1).toISOString(), state: "ready" };
    await writeFile(lockPath(root), JSON.stringify(owner), "utf8");
    await expect(new EventLedger(undefined, bounded).append(root, event(3))).rejects.toThrow(/ready-owner/);
    expect(JSON.parse(await readFile(lockPath(root), "utf8"))).toMatchObject(owner);
  });

  it("preserves a replacement owner when stale cleanup is released after quarantine claim", async () => {
    const root = await preparedRoot();
    const canonical = lockPath(root);
    const oldOwner = {
      version: 1, token: "old-owner", pid: 2147483647, hostname: os.hostname(),
      createdAt: new Date(Date.now() - 2000).toISOString(), heartbeatAt: new Date(Date.now() - 2000).toISOString(),
      leaseUntil: new Date(Date.now() - 1).toISOString(), state: "ready",
    };
    const replacement = {
      version: 1, token: "replacement-owner", pid: process.pid, hostname: os.hostname(),
      createdAt: new Date().toISOString(), heartbeatAt: new Date().toISOString(),
      leaseUntil: new Date(Date.now() + 30000).toISOString(), state: "ready",
    };
    await writeFile(canonical, JSON.stringify(oldOwner), "utf8");
    let releaseClaim!: () => void;
    let markClaimed!: () => void;
    const claimStarted = new Promise<void>((resolve) => { markClaimed = resolve; });
    const claimBarrier = new Promise<void>((resolve) => { releaseClaim = resolve; });
    const cleanup = new EventLedger(undefined, {
      lock: {
        ...competing.lock,
        afterQuarantineClaim: async () => { markClaimed(); await claimBarrier; },
      },
    }).append(root, event(8));
    // The append reaches the deterministic post-claim barrier before the
    // replacement is created, so this is a protocol race rather than timing.
    await claimStarted;
    await writeFile(canonical, JSON.stringify(replacement), "utf8");
    const before = await lockBytes(canonical);
    releaseClaim();
    await expect(cleanup).rejects.toThrow(/ready-owner/);
    expect(await lockBytes(canonical)).toEqual(before);
    expect(JSON.parse(before.toString("utf8")).token).toBe("replacement-owner");
    expect((await readdir(path.dirname(canonical))).some((name) => name.startsWith(path.basename(canonical) + ".quarantine-"))).toBe(false);
  }, 10_000);

  it("restores a replacement owner that wins before stale cleanup claims the pathname", async () => {
    const root = await preparedRoot();
    const canonical = lockPath(root);
    const oldOwner = {
      version: 1, token: "pre-claim-old-owner", pid: 2147483647, hostname: os.hostname(),
      createdAt: new Date(Date.now() - 2000).toISOString(), heartbeatAt: new Date(Date.now() - 2000).toISOString(),
      leaseUntil: new Date(Date.now() - 1).toISOString(), state: "ready",
    };
    const replacement = JSON.stringify({
      version: 1, token: "pre-claim-replacement", pid: process.pid, hostname: os.hostname(),
      createdAt: new Date().toISOString(), heartbeatAt: new Date().toISOString(),
      leaseUntil: new Date(Date.now() + 30000).toISOString(), state: "ready",
    });
    await writeFile(canonical, JSON.stringify(oldOwner), "utf8");
    const cleanup = new EventLedger(undefined, {
      lock: {
        ...bounded.lock,
        beforeQuarantineClaim: async () => { await writeFile(canonical, replacement, "utf8"); },
      },
    }).append(root, event(10));

    await expect(cleanup).rejects.toThrow(/ready-owner/);
    expect(await readFile(canonical, "utf8")).toBe(replacement);
    expect((await readdir(path.dirname(canonical))).some((name) => name.startsWith(path.basename(canonical) + ".quarantine-"))).toBe(false);
  });

  it("preserves a replacement owner when release is released after quarantine claim", async () => {
    const root = await preparedRoot();
    const canonical = lockPath(root);
    const replacement = JSON.stringify({
      version: 1, token: "release-replacement-owner", pid: process.pid, hostname: os.hostname(),
      createdAt: new Date().toISOString(), heartbeatAt: new Date().toISOString(),
      leaseUntil: new Date(Date.now() + 30000).toISOString(), state: "ready",
    });
    let releaseClaim!: () => void;
    let markClaimed!: () => void;
    const claimStarted = new Promise<void>((resolve) => { markClaimed = resolve; });
    const claimBarrier = new Promise<void>((resolve) => { releaseClaim = resolve; });
    const ledger = new EventLedger(undefined, {
      lock: {
        ...competing.lock,
        afterReleaseQuarantineClaim: async () => { markClaimed(); await claimBarrier; },
      },
    });

    const appended = ledger.append(root, event(9));
    // Wait until the append, rather than this test, has published its lock.
    // Otherwise the replacement owner could win the initial acquisition race.
    const publicationDeadline = Date.now() + 2_000;
    let published = false;
    while (Date.now() < publicationDeadline) {
      try {
        const current = await readFile(canonical, "utf8");
        if (current.includes('"state":"ready"')) {
          published = true;
          break;
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    expect(published).toBe(true);
    await claimStarted;
    // The release hook runs after the exact old pathname has been quarantined;
    // canonical is therefore available for an exclusive replacement owner.
    const lockHandle = await open(canonical, "wx", 0o600);
    await lockHandle.writeFile(replacement, "utf8");
    await lockHandle.sync();
    await lockHandle.close();
    const before = await lockBytes(canonical);
    expect(before.toString("utf8")).toBe(replacement);
    releaseClaim();
    await expect(appended).resolves.toMatchObject({ workspaceSequence: 1 });
    expect(await lockBytes(canonical)).toEqual(before);
    expect(JSON.parse(before.toString("utf8")).token).toBe("release-replacement-owner");
    expect((await readdir(path.dirname(canonical))).some((name) => name.startsWith(path.basename(canonical) + ".quarantine-"))).toBe(false);
  }, 10_000);

  it("preserves claimed quarantine for cleanup diagnostics when post-claim handling fails", async () => {
    const root = await preparedRoot();
    const canonical = lockPath(root);
    const oldOwner = {
      version: 1, token: "cleanup-failure-old", pid: 2147483647, hostname: os.hostname(),
      createdAt: new Date(Date.now() - 2000).toISOString(), heartbeatAt: new Date(Date.now() - 2000).toISOString(),
      leaseUntil: new Date(Date.now() - 1).toISOString(), state: "ready",
    };
    const replacement = JSON.stringify({
      version: 1, token: "cleanup-failure-replacement", pid: process.pid, hostname: os.hostname(),
      createdAt: new Date().toISOString(), heartbeatAt: new Date().toISOString(),
      leaseUntil: new Date(Date.now() + 30000).toISOString(), state: "ready",
    });
    await writeFile(canonical, JSON.stringify(oldOwner), "utf8");
    await expect(new EventLedger(undefined, {
      lock: {
        ...bounded.lock,
        afterQuarantineClaim: async (quarantinePath, lockPath) => {
          await writeFile(lockPath, replacement, "utf8");
          throw new Error("cleanup quarantine handling failed");
        },
      },
    }).append(root, event(10))).rejects.toThrow("cleanup quarantine handling failed");
    expect(await readFile(canonical, "utf8")).toBe(replacement);
    expect((await readdir(path.dirname(canonical))).some((name) => name.startsWith(path.basename(canonical) + ".quarantine-"))).toBe(true);
  });

  it("preserves claimed quarantine for release diagnostics when post-claim handling fails", async () => {
    const root = await preparedRoot();
    const canonical = lockPath(root);
    const replacement = JSON.stringify({
      version: 1, token: "release-failure-replacement", pid: process.pid, hostname: os.hostname(),
      createdAt: new Date().toISOString(), heartbeatAt: new Date().toISOString(),
      leaseUntil: new Date(Date.now() + 30000).toISOString(), state: "ready",
    });
    let releaseFailure!: () => void;
    const failure = new Promise<void>((resolve) => { releaseFailure = resolve; });
    const ledger = new EventLedger(undefined, {
      lock: {
        ...competing.lock,
        afterReleaseQuarantineClaim: async (quarantinePath, lockPath) => {
          await writeFile(lockPath, replacement, "utf8");
          releaseFailure();
          throw new Error("release quarantine handling failed");
        },
      },
    });
    const appended = ledger.append(root, event(11));
    await failure;
    await expect(appended).rejects.toThrow("release quarantine handling failed");
    expect(await readFile(canonical, "utf8")).toBe(replacement);
    expect((await readdir(path.dirname(canonical))).some((name) => name.startsWith(path.basename(canonical) + ".quarantine-"))).toBe(true);
  });

  it("keeps workspace sequences unique under competing ledger instances", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "autoagent-lock-race-"));
    const ledgers = [new EventLedger(undefined, competing), new EventLedger(undefined, competing)];
    const events = await Promise.all(Array.from({ length: 8 }, (_, index) => ledgers[index % 2].append(root, event(index))));
    expect(new Set(events.map((item) => item.workspaceSequence)).size).toBe(8);
  });
});
