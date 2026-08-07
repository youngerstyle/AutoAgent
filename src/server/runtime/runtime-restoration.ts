import type { RuntimeHostRegistry } from "./runtime-host-registry.js";

export type RuntimeHostRestorationState = {
  status: "not_started" | "restoring" | "ready" | "degraded" | "failed";
  restoredWorkspaceCount?: number;
  failedWorkspaces?: Array<{
    workspaceId: string;
    workspaceName: string;
    rootPath: string;
    error: string;
  }>;
  error?: string;
};

export class RuntimeRestorationController {
  private active?: Promise<RuntimeHostRestorationState>;

  constructor(
    private readonly registry: RuntimeHostRegistry,
    private readonly setState: (state: RuntimeHostRestorationState) => void,
  ) {}

  async restore(): Promise<RuntimeHostRestorationState> {
    if (this.active) return this.active;
    this.active = this.run();
    try {
      return await this.active;
    } finally {
      this.active = undefined;
    }
  }

  private async run(): Promise<RuntimeHostRestorationState> {
    this.setState({ status: "restoring" });
    try {
      const report = await this.registry.startAll();
      const state: RuntimeHostRestorationState = report.failedWorkspaces.length
        ? {
            status: "degraded",
            restoredWorkspaceCount: report.restoredWorkspaceIds.length,
            failedWorkspaces: report.failedWorkspaces,
          }
        : {
            status: "ready",
            restoredWorkspaceCount: report.restoredWorkspaceIds.length,
          };
      this.setState(state);
      return state;
    } catch (error) {
      const state: RuntimeHostRestorationState = {
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
      };
      this.setState(state);
      throw error;
    }
  }
}
