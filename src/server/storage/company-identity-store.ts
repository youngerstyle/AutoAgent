import path from "node:path";
import { createId } from "../../shared/ids.js";
import { globalCompanyIdentityFile } from "./paths.js";
import { readJson, writeJson } from "./json.js";

export interface CompanyIdentity { schemaVersion: 1; companyId: string; createdAt: string }
const queues = new Map<string, Promise<void>>();

/** Stable identity of exactly one private AutoAgent deployment. */
export class CompanyIdentityStore {
  constructor(private readonly homeDir: string, private readonly now: () => Date = () => new Date()) {}

  async getOrCreate(): Promise<CompanyIdentity> {
    return this.exclusive(async () => {
      const existing = await readJson<unknown>(globalCompanyIdentityFile(this.homeDir), undefined);
      if (existing !== undefined) return parse(existing);
      const identity: CompanyIdentity = { schemaVersion: 1, companyId: createId("company"), createdAt: this.now().toISOString() };
      await writeJson(globalCompanyIdentityFile(this.homeDir), identity);
      return identity;
    });
  }

  async get(): Promise<CompanyIdentity | undefined> {
    const existing = await readJson<unknown>(globalCompanyIdentityFile(this.homeDir), undefined);
    return existing === undefined ? undefined : parse(existing);
  }

  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const key = path.resolve(globalCompanyIdentityFile(this.homeDir)).toLowerCase();
    const previous = queues.get(key) ?? Promise.resolve(); const pending = previous.catch(() => undefined).then(operation);
    const settled = pending.then(() => undefined, () => undefined); queues.set(key, settled);
    return pending.finally(() => { if (queues.get(key) === settled) queues.delete(key); });
  }
}

function parse(value: unknown): CompanyIdentity {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Company identity is invalid");
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== 1 || typeof record.companyId !== "string" || !/^company_[a-f0-9]{16}$/.test(record.companyId)
    || typeof record.createdAt !== "string" || !Number.isFinite(Date.parse(record.createdAt))
    || Object.keys(record).some((key) => !["schemaVersion", "companyId", "createdAt"].includes(key))) throw new Error("Company identity is invalid");
  return structuredClone(record) as unknown as CompanyIdentity;
}
