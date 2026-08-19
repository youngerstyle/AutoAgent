import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const writeQueues = new Map<string, Promise<void>>();
// Antivirus/indexer handles on Windows can outlive a short burst of retries.
// Keep the update atomic and wait for a bounded release rather than deleting
// the destination or falling back to an in-place partial write.
const RENAME_MAX_ATTEMPTS = 90;
const RENAME_RETRY_BACKOFF_MS = 25;

export async function readJson<T>(filePath: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return fallback;
    }
    throw error;
  }
}

export async function writeJson(filePath: string, value: unknown): Promise<void> {
  const key = path.resolve(filePath).toLowerCase();
  const previous = writeQueues.get(key) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(() => writeJsonNow(filePath, value));
  writeQueues.set(key, next);
  try {
    await next;
  } finally {
    if (writeQueues.get(key) === next) {
      writeQueues.delete(key);
    }
  }
}

export async function updateJson<T>(filePath: string, fallback: T, update: (current: T) => T | Promise<T>): Promise<T> {
  const key = path.resolve(filePath).toLowerCase();
  const previous = writeQueues.get(key) ?? Promise.resolve();
  const operation = previous.catch(() => undefined).then(async () => {
    const next = await update(await readJson(filePath, fallback));
    await writeJsonNow(filePath, next);
    return next;
  });
  const queued = operation.then(() => undefined, () => undefined);
  writeQueues.set(key, queued);
  try {
    return await operation;
  } finally {
    if (writeQueues.get(key) === queued) {
      writeQueues.delete(key);
    }
  }
}

async function writeJsonNow(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  try {
    await renameWithRetry(tmp, filePath);
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function renameWithRetry(source: string, target: string): Promise<void> {
  for (let attempt = 0; attempt < RENAME_MAX_ATTEMPTS; attempt += 1) {
    try {
      await rename(source, target);
      return;
    } catch (error) {
      if (!isRetriableRenameError(error) || attempt === RENAME_MAX_ATTEMPTS - 1) throw error;
      await delay(Math.min(500, RENAME_RETRY_BACKOFF_MS * (attempt + 1)));
    }
  }
}

function isRetriableRenameError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "EPERM" || code === "EBUSY" || code === "ENOTEMPTY";
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
