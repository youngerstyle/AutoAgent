import { randomUUID } from "node:crypto";
import { open, mkdir, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

type LockMetadata = {
  token: string;
  pid: number;
  hostname: string;
  acquiredAt: string;
};

export class ServiceInstanceLockError extends Error {
  constructor(
    readonly lockFile: string,
    readonly owner?: Pick<LockMetadata, "pid" | "hostname" | "acquiredAt">,
  ) {
    const ownerDescription = owner
      ? `PID ${owner.pid} on ${owner.hostname}, started ${owner.acquiredAt}`
      : "an unknown process";
    super(`AUTOAGENT_HOME is already owned by ${ownerDescription}: ${lockFile}`);
    this.name = "ServiceInstanceLockError";
  }
}

export class ServiceInstanceLock {
  private releasePromise?: Promise<void>;

  private constructor(
    readonly file: string,
    private readonly token: string,
  ) {}

  static async acquire(autoAgentHome: string): Promise<ServiceInstanceLock> {
    const file = path.join(autoAgentHome, ".service-instance.lock");
    await mkdir(autoAgentHome, { recursive: true });

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const token = randomUUID();
      let handle: Awaited<ReturnType<typeof open>> | undefined;
      try {
        handle = await open(file, "wx", 0o600);
        const metadata: LockMetadata = {
          token,
          pid: process.pid,
          hostname: os.hostname(),
          acquiredAt: new Date().toISOString(),
        };
        await handle.writeFile(`${JSON.stringify(metadata)}\n`, "utf8");
        await handle.sync();
        await handle.close();
        return new ServiceInstanceLock(file, token);
      } catch (error) {
        await handle?.close().catch(() => undefined);
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }

      const existing = await readLock(file);
      if (existing && existing.hostname === os.hostname() && !isProcessAlive(existing.pid)) {
        if (await removeUnchangedLock(file, existing)) continue;
      }
      throw new ServiceInstanceLockError(file, existing);
    }

    throw new ServiceInstanceLockError(file);
  }

  async release(): Promise<void> {
    this.releasePromise ??= this.removeOwnedLock();
    await this.releasePromise;
  }

  private async removeOwnedLock(): Promise<void> {
    try {
      const existing = await readLock(this.file);
      if (existing?.token === this.token) await rm(this.file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

async function removeUnchangedLock(file: string, expected: LockMetadata): Promise<boolean> {
  try {
    const [content, info] = await Promise.all([readFile(file, "utf8"), stat(file)]);
    const current = parseLock(content);
    if (current?.token !== expected.token) return false;
    const latestInfo = await stat(file);
    if (latestInfo.mtimeMs !== info.mtimeMs || latestInfo.size !== info.size) return false;
    await rm(file);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }
}

async function readLock(file: string): Promise<LockMetadata | undefined> {
  try {
    return parseLock(await readFile(file, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function parseLock(content: string): LockMetadata | undefined {
  try {
    const value = JSON.parse(content) as Record<string, unknown>;
    if (
      typeof value.token !== "string"
      || !Number.isSafeInteger(value.pid)
      || typeof value.hostname !== "string"
      || typeof value.acquiredAt !== "string"
    ) return undefined;
    return value as LockMetadata;
  } catch {
    return undefined;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
