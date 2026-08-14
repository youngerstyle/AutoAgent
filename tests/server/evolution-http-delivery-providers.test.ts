import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import type { EvolutionProviderAttestation, EvolutionSourcePatchArtifact, ScmPreparedChange, VersionedEvolutionRef } from "../../src/shared/contracts/evolution.js";
import { configuredHttpEvolutionDeliveryProviders, createHttpEvolutionDeliveryProviders } from "../../src/server/evolution/http-delivery-providers.js";

const servers: ReturnType<typeof createServer>[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve())))); });

describe("HTTPS evolution delivery provider gateway", () => {
  it("implements SCM, build, deployment, actual revision, and rollback without a platform shell", async () => {
    const requests: Array<{ path: string; authorization?: string; idempotency?: string; body: unknown }> = [];
    let checkAttempts = 0;
    const server = createServer(async (req, res) => {
      const body = await jsonBody(req);
      requests.push({ path: req.url!, authorization: header(req, "authorization"), idempotency: header(req, "x-autoagent-idempotency-key"), body });
      if (req.url === "/v1/scm/checks" && checkAttempts++ === 0) return json(res, 503, { error: "retry" });
      const values: Record<string, unknown> = {
        "/v1/scm/current-revision": { revision: "a".repeat(40) },
        "/v1/scm/changes": prepared(),
        "/v1/scm/checks": { attestations: [proof("test", "candidate-commit")] },
        "/v1/scm/review": { attestation: proof("review", "candidate-commit") },
        "/v1/scm/merge": { mergeCommit: "b".repeat(40), attestation: proof("merge", "candidate-commit") },
        "/v1/builds": { artifactRef: ref("artifact", "8"), attestation: proof("build", "b".repeat(40)) },
        "/v1/deployments/current-production": { deploymentRef: ref("deployment-old", "7") },
        "/v1/deployments/canary": { deploymentRef: ref("deployment-new", "8"), attestation: proof("canary", "deployment-new") },
        "/v1/deployments/production": { attestation: proof("production", "deployment-new") },
        "/v1/deployments/actual-revision": { sourceCommit: "b".repeat(40), runtimeSnapshotHash: "runtime-snapshot", attestation: proof("runtime", "deployment-new") },
        "/v1/deployments/rollback": { attestation: proof("rollback", "deployment-old") },
      };
      const value = values[req.url!];
      return value ? json(res, 200, value) : json(res, 404, { error: "not found" });
    });
    servers.push(server);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test gateway did not bind TCP");
    const providers = createHttpEvolutionDeliveryProviders({ baseUrl: `http://127.0.0.1:${address.port}`, bearerToken: "test-token", allowInsecureLoopback: true });
    const change = await providers.scm.prepareChange({ candidateId: "candidate", contentHash: "candidate-hash", artifact: sourceArtifact() });
    expect(await providers.scm.currentRevision("repo")).toBe("a".repeat(40));
    expect(await providers.scm.requiredChecks(change, ["test"])).toEqual([expect.objectContaining({ status: "passed", subject: "test" })]);
    expect(await providers.scm.review(change)).toMatchObject({ subject: "review" });
    expect(await providers.scm.merge(change)).toMatchObject({ mergeCommit: "b".repeat(40) });
    const built = await providers.build.build({ sourceCommit: "b".repeat(40), candidateRef: ref("candidate", "1") });
    const previous = await providers.deployment.currentProduction();
    const deployed = await providers.deployment.deployCanary({ artifactRef: built.artifactRef, previousDeployment: previous });
    expect(await providers.deployment.promoteProduction(deployed.deploymentRef)).toMatchObject({ status: "passed" });
    expect(await providers.deployment.actualRevision(deployed.deploymentRef)).toMatchObject({ sourceCommit: "b".repeat(40), runtimeSnapshotHash: "runtime-snapshot" });
    expect(await providers.deployment.rollback(previous!)).toMatchObject({ subject: "rollback" });
    expect(requests.every((item) => item.authorization === "Bearer test-token" && /^[a-f0-9]{64}$/.test(item.idempotency ?? ""))).toBe(true);
    const retries = requests.filter((item) => item.path === "/v1/scm/checks");
    expect(retries).toHaveLength(2);
    expect(retries[0]!.idempotency).toBe(retries[1]!.idempotency);
  });

  it("fails closed for insecure production URLs, partial credentials, and malformed attestations", async () => {
    expect(() => createHttpEvolutionDeliveryProviders({ baseUrl: "http://provider.example", bearerToken: "secret" })).toThrow("requires HTTPS");
    expect(() => configuredHttpEvolutionDeliveryProviders({ AUTOAGENT_EVOLUTION_DELIVERY_BASE_URL: "https://provider.example" })).toThrow("requires both");
    expect(configuredHttpEvolutionDeliveryProviders({})).toBeUndefined();

    const server = createServer((_req, res) => json(res, 200, { attestation: { status: "passed" } }));
    servers.push(server);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test gateway did not bind TCP");
    const providers = createHttpEvolutionDeliveryProviders({ baseUrl: `http://127.0.0.1:${address.port}`, bearerToken: "test-token", allowInsecureLoopback: true });
    await expect(providers.deployment.promoteProduction(ref("deployment", "1"))).rejects.toThrow("invalid attestation");
  });
});

function sourceArtifact(): EvolutionSourcePatchArtifact {
  return { schemaVersion: 1, repositoryId: "repo", baseCommit: "a".repeat(40), targetBranch: "main", files: ["src/a.ts"], patch: "diff --git a/src/a.ts b/src/a.ts", requiredChecks: ["test"] };
}
function prepared(): ScmPreparedChange {
  return { provider: "github", repositoryId: "repo", baseCommit: "a".repeat(40), changeRef: "refs/heads/evol/candidate", candidateCommit: "c".repeat(40), webUrl: "https://example.test/change" };
}
function ref(id: string, version: string): VersionedEvolutionRef { return { id, version, contentHash: `${id}-hash` }; }
function proof(subject: string, revision: string): EvolutionProviderAttestation {
  return { provider: "gateway-test", subject, revision, status: "passed", observedAt: "2026-08-14T00:00:00.000Z", evidenceRef: `https://example.test/evidence/${subject}` };
}
function header(req: IncomingMessage, name: string): string | undefined { const value = req.headers[name]; return Array.isArray(value) ? value[0] : value; }
async function jsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
function json(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(value));
}
