import type { EvolutionProviderAttestation, EvolutionSourcePatchArtifact, ScmPreparedChange, VersionedEvolutionRef } from "../../shared/contracts/evolution.js";
export type { EvolutionProviderAttestation, ScmPreparedChange, SourcePatchDeliveryRecord, SourcePatchDeliveryStatus } from "../../shared/contracts/evolution.js";

export interface ScmProvider {
  readonly providerId: string;
  currentRevision(repositoryId: string): Promise<string>;
  prepareChange(input: { candidateId: string; contentHash: string; artifact: EvolutionSourcePatchArtifact }): Promise<ScmPreparedChange>;
  requiredChecks(change: ScmPreparedChange, names: string[]): Promise<EvolutionProviderAttestation[]>;
  review(change: ScmPreparedChange): Promise<EvolutionProviderAttestation>;
  merge(change: ScmPreparedChange): Promise<{ mergeCommit: string; attestation: EvolutionProviderAttestation }>;
}

export interface BuildProvider {
  readonly providerId: string;
  build(input: { sourceCommit: string; candidateRef: VersionedEvolutionRef }): Promise<{
    artifactRef: VersionedEvolutionRef;
    attestation: EvolutionProviderAttestation;
  }>;
}

export interface DeploymentProvider {
  readonly providerId: string;
  currentProduction(): Promise<VersionedEvolutionRef | undefined>;
  deployCanary(input: { artifactRef: VersionedEvolutionRef; previousDeployment?: VersionedEvolutionRef }): Promise<{
    deploymentRef: VersionedEvolutionRef;
    attestation: EvolutionProviderAttestation;
  }>;
  promoteProduction(deploymentRef: VersionedEvolutionRef): Promise<EvolutionProviderAttestation>;
  actualRevision(deploymentRef: VersionedEvolutionRef): Promise<{ sourceCommit: string; runtimeSnapshotHash: string; attestation: EvolutionProviderAttestation }>;
  rollback(previousDeployment: VersionedEvolutionRef): Promise<EvolutionProviderAttestation>;
}

export interface EvolutionDeliveryProviders {
  scm: ScmProvider;
  build: BuildProvider;
  deployment: DeploymentProvider;
}
