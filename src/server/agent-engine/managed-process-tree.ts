import { spawn } from "node:child_process";

export interface ManagedProcessTreeOptions {
  platform?: NodeJS.Platform;
  graceMs?: number;
  forceWaitMs?: number;
}

/** POSIX children need their own process group; Windows is terminated by /T. */
export function managedProcessDetached(platform: NodeJS.Platform = process.platform): boolean {
  return platform !== "win32";
}

export async function terminateManagedProcessTree(
  rootPid: number,
  options: ManagedProcessTreeOptions = {},
): Promise<void> {
  const platform = options.platform ?? process.platform;
  const graceMs = options.graceMs ?? 1_000;
  const forceWaitMs = options.forceWaitMs ?? 2_000;
  if (!Number.isInteger(rootPid) || rootPid <= 0) return;

  if (platform === "win32") {
    if (!pidAlive(rootPid)) return;
    await runTaskkill(rootPid, forceWaitMs);
    await waitUntil(() => !pidAlive(rootPid), forceWaitMs);
    if (pidAlive(rootPid)) safeKill(rootPid, "SIGKILL");
    return;
  }

  const groupTarget = -rootPid;
  if (!signalTargetAlive(groupTarget)) return;
  safeKill(groupTarget, "SIGTERM");
  await waitUntil(() => !signalTargetAlive(groupTarget), graceMs);
  if (signalTargetAlive(groupTarget)) {
    safeKill(groupTarget, "SIGKILL");
    await waitUntil(() => !signalTargetAlive(groupTarget), forceWaitMs);
  }
}

async function runTaskkill(pid: number, timeoutMs: number): Promise<void> {
  await Promise.race([
    new Promise<void>((resolve) => {
      const killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      });
      killer.once("error", () => resolve());
      killer.once("exit", () => resolve());
    }),
    delay(timeoutMs),
  ]);
}

async function waitUntil(done: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!done() && Date.now() < deadline) await delay(25);
}

function pidAlive(pid: number): boolean {
  return signalTargetAlive(pid);
}

function signalTargetAlive(target: number): boolean {
  try {
    process.kill(target, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function safeKill(target: number, signal: NodeJS.Signals): void {
  try {
    process.kill(target, signal);
  } catch {
    // The tree exited between observation and signal delivery.
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
