import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CompanyIdentityStore } from "../../src/server/storage/company-identity-store.js";

describe("CompanyIdentityStore", () => {
  it("creates one stable identity per private deployment under concurrent initialization", async () => {
    const firstHome = await mkdtemp(path.join(os.tmpdir(), "autoagent-company-a-"));
    const secondHome = await mkdtemp(path.join(os.tmpdir(), "autoagent-company-b-"));
    const store = new CompanyIdentityStore(firstHome, () => new Date("2026-08-15T04:00:00.000Z"));

    const identities = await Promise.all(Array.from({ length: 8 }, () => store.getOrCreate()));

    expect(new Set(identities.map((identity) => identity.companyId)).size).toBe(1);
    expect(identities[0]).toMatchObject({ schemaVersion: 1, companyId: expect.stringMatching(/^company_[a-f0-9]{16}$/), createdAt: "2026-08-15T04:00:00.000Z" });
    expect((await store.getOrCreate()).companyId).toBe(identities[0]!.companyId);
    expect((await new CompanyIdentityStore(secondHome).getOrCreate()).companyId).not.toBe(identities[0]!.companyId);
  });

  it("fails closed instead of silently replacing a corrupted company identity", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "autoagent-company-corrupt-"));
    await writeFile(path.join(home, "company.json"), JSON.stringify({ schemaVersion: 1, companyId: "company-replaced" }), "utf8");
    await expect(new CompanyIdentityStore(home).getOrCreate()).rejects.toThrow("Company identity is invalid");
  });
});
