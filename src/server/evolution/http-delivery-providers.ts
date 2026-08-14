import { createHash } from "node:crypto";
import type {
  EvolutionProviderAttestation,
  EvolutionSourcePatchArtifact,
  ScmPreparedChange,
  VersionedEvolutionRef,
} from "../../shared/contracts/evolution.js";
import type { BuildProvider, DeploymentProvider, EvolutionDeliveryProviders, ScmProvider } from "./delivery-providers.js";

export interface HttpDeliveryProviderOptions {
  baseUrl: string;
  bearerToken: string;
  timeoutMs?: number;
  /** Test/development only. Production configuration must use HTTPS. */
  allowInsecureLoopback?: boolean;
}

export function createHttpEvolutionDeliveryProviders(options: HttpDeliveryProviderOptions): EvolutionDeliveryProviders {
  const client = new ProviderGatewayClient(options);
  return {
    scm: new HttpScmProvider(client),
    build: new HttpBuildProvider(client),
    deployment: new HttpDeploymentProvider(client),
  };
}

export function configuredHttpEvolutionDeliveryProviders(env: NodeJS.ProcessEnv = process.env): EvolutionDeliveryProviders | undefined {
  const baseUrl = env.AUTOAGENT_EVOLUTION_DELIVERY_BASE_URL?.trim();
  const bearerToken = env.AUTOAGENT_EVOLUTION_DELIVERY_TOKEN?.trim();
  if (!baseUrl && !bearerToken) return undefined;
  if (!baseUrl || !bearerToken) throw new Error("Evolution delivery requires both AUTOAGENT_EVOLUTION_DELIVERY_BASE_URL and AUTOAGENT_EVOLUTION_DELIVERY_TOKEN");
  const timeout = env.AUTOAGENT_EVOLUTION_DELIVERY_TIMEOUT_MS?.trim();
  const timeoutMs = timeout ? Number(timeout) : undefined;
  return createHttpEvolutionDeliveryProviders({ baseUrl, bearerToken, ...(timeoutMs === undefined ? {} : { timeoutMs }) });
}

class HttpScmProvider implements ScmProvider {
  readonly providerId = "provider-gateway/scm/v1";
  constructor(private readonly client: ProviderGatewayClient) {}
  currentRevision(repositoryId: string): Promise<string> {
    return this.client.post("scm/current-revision", { repositoryId }, (value) => requiredString(asObject(value).revision, "SCM revision"));
  }
  prepareChange(input: { candidateId: string; contentHash: string; artifact: EvolutionSourcePatchArtifact }): Promise<ScmPreparedChange> {
    return this.client.post("scm/changes", input, preparedChange);
  }
  requiredChecks(change: ScmPreparedChange, names: string[]): Promise<EvolutionProviderAttestation[]> {
    return this.client.post("scm/checks", { change, names }, (value) => {
      const values = asObject(value).attestations;
      if (!Array.isArray(values)) throw invalidResponse("SCM check attestations");
      return values.map(attestation);
    });
  }
  review(change: ScmPreparedChange): Promise<EvolutionProviderAttestation> {
    return this.client.post("scm/review", { change }, (value) => attestation(asObject(value).attestation));
  }
  merge(change: ScmPreparedChange): Promise<{ mergeCommit: string; attestation: EvolutionProviderAttestation }> {
    return this.client.post("scm/merge", { change }, (value) => {
      const object = asObject(value);
      return { mergeCommit: requiredString(object.mergeCommit, "SCM merge commit"), attestation: attestation(object.attestation) };
    });
  }
}

class HttpBuildProvider implements BuildProvider {
  readonly providerId = "provider-gateway/build/v1";
  constructor(private readonly client: ProviderGatewayClient) {}
  build(input: { sourceCommit: string; candidateRef: VersionedEvolutionRef }) {
    return this.client.post("builds", input, (value) => {
      const object = asObject(value);
      return { artifactRef: versionedRef(object.artifactRef), attestation: attestation(object.attestation) };
    });
  }
}

class HttpDeploymentProvider implements DeploymentProvider {
  readonly providerId = "provider-gateway/deployment/v1";
  constructor(private readonly client: ProviderGatewayClient) {}
  currentProduction(): Promise<VersionedEvolutionRef | undefined> {
    return this.client.post("deployments/current-production", {}, (value) => {
      const ref = asObject(value).deploymentRef;
      return ref === null || ref === undefined ? undefined : versionedRef(ref);
    });
  }
  deployCanary(input: { artifactRef: VersionedEvolutionRef; previousDeployment?: VersionedEvolutionRef }) {
    return this.client.post("deployments/canary", input, (value) => {
      const object = asObject(value);
      return { deploymentRef: versionedRef(object.deploymentRef), attestation: attestation(object.attestation) };
    });
  }
  promoteProduction(deploymentRef: VersionedEvolutionRef): Promise<EvolutionProviderAttestation> {
    return this.client.post("deployments/production", { deploymentRef }, (value) => attestation(asObject(value).attestation));
  }
  actualRevision(deploymentRef: VersionedEvolutionRef) {
    return this.client.post("deployments/actual-revision", { deploymentRef }, (value) => {
      const object = asObject(value);
      return {
        sourceCommit: requiredString(object.sourceCommit, "deployment source commit"),
        runtimeSnapshotHash: requiredString(object.runtimeSnapshotHash, "deployment runtime snapshot hash"),
        attestation: attestation(object.attestation),
      };
    });
  }
  rollback(previousDeployment: VersionedEvolutionRef): Promise<EvolutionProviderAttestation> {
    return this.client.post("deployments/rollback", { previousDeployment }, (value) => attestation(asObject(value).attestation));
  }
}

class ProviderGatewayClient {
  private readonly baseUrl: URL;
  private readonly timeoutMs: number;
  constructor(private readonly options: HttpDeliveryProviderOptions) {
    this.baseUrl = validatedBaseUrl(options.baseUrl, options.allowInsecureLoopback === true);
    if (!options.bearerToken?.trim() || /[\r\n]/.test(options.bearerToken)) throw new Error("Evolution delivery bearer token is invalid");
    this.timeoutMs = options.timeoutMs ?? 30_000;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1_000 || this.timeoutMs > 300_000) throw new Error("Evolution delivery timeout must be between 1 and 300 seconds");
  }

  async post<T>(operation: string, body: unknown, parse: (value: unknown) => T): Promise<T> {
    const serialized = JSON.stringify(body);
    const idempotencyKey = createHash("sha256").update(`${operation}\0${serialized}`).digest("hex");
    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const response = await fetch(new URL(`v1/${operation}`, this.baseUrl), {
          method: "POST",
          redirect: "error",
          signal: controller.signal,
          headers: {
            authorization: `Bearer ${this.options.bearerToken}`,
            "content-type": "application/json",
            "x-autoagent-idempotency-key": idempotencyKey,
          },
          body: serialized,
        });
        const text = await response.text();
        if (text.length > 1_048_576) throw new Error("Evolution delivery provider response exceeded 1 MiB");
        if (!response.ok) {
          const error = new Error(`Evolution delivery provider ${operation} failed with HTTP ${response.status}`);
          if (attempt === 0 && [429, 502, 503, 504].includes(response.status)) { lastError = error; continue; }
          throw error;
        }
        let decoded: unknown;
        try { decoded = JSON.parse(text); } catch { throw invalidResponse(`${operation} JSON`); }
        return parse(decoded);
      } catch (error) {
        lastError = error;
        if (attempt > 0 || (error instanceof Error && error.message.startsWith("Evolution delivery provider response"))) throw error;
      } finally {
        clearTimeout(timeout);
      }
    }
    throw lastError instanceof Error ? lastError : new Error("Evolution delivery provider request failed");
  }
}

function validatedBaseUrl(value: string, allowInsecureLoopback: boolean): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("Evolution delivery base URL is invalid"); }
  const loopback = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(allowInsecureLoopback && url.protocol === "http:" && loopback)) throw new Error("Evolution delivery provider requires HTTPS");
  if (url.username || url.password || url.search || url.hash) throw new Error("Evolution delivery base URL must not contain credentials, query, or fragment");
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  return url;
}
function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalidResponse("object");
  return value as Record<string, unknown>;
}
function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim() || /[\r\n]/.test(value)) throw invalidResponse(label);
  return value;
}
function versionedRef(value: unknown): VersionedEvolutionRef {
  const object = asObject(value);
  return { id: requiredString(object.id, "versioned ref id"), version: requiredString(object.version, "versioned ref version"), contentHash: requiredString(object.contentHash, "versioned ref content hash") };
}
function preparedChange(value: unknown): ScmPreparedChange {
  const object = asObject(value);
  return {
    provider: requiredString(object.provider, "SCM provider"), repositoryId: requiredString(object.repositoryId, "SCM repository"),
    baseCommit: requiredString(object.baseCommit, "SCM base commit"), changeRef: requiredString(object.changeRef, "SCM change ref"),
    candidateCommit: requiredString(object.candidateCommit, "SCM candidate commit"),
    ...(object.webUrl === undefined ? {} : { webUrl: requiredString(object.webUrl, "SCM web URL") }),
  };
}
function attestation(value: unknown): EvolutionProviderAttestation {
  const object = asObject(value);
  const status = requiredString(object.status, "attestation status");
  if (!(["pending", "passed", "failed"] as string[]).includes(status)) throw invalidResponse("attestation status");
  const observedAt = requiredString(object.observedAt, "attestation timestamp");
  if (!Number.isFinite(Date.parse(observedAt))) throw invalidResponse("attestation timestamp");
  return {
    provider: requiredString(object.provider, "attestation provider"), subject: requiredString(object.subject, "attestation subject"),
    revision: requiredString(object.revision, "attestation revision"), status: status as EvolutionProviderAttestation["status"],
    observedAt, evidenceRef: requiredString(object.evidenceRef, "attestation evidence ref"),
  };
}
function invalidResponse(label: string): Error { return new Error(`Evolution delivery provider returned an invalid ${label}`); }
