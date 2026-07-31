import path from "node:path";
import type { TeamStaffingOutcome } from "../../shared/contracts/staffing.js";
import { readJson, writeJson } from "../storage/json.js";

export interface StaffingRequestRecord {
  staffingRequestId: string;
  taskId: string;
  workspaceId: string;
  objective: string;
  staffingProfileId: string;
  staffingAgentId: string;
  status: "pending" | "running" | "blocked" | "completed" | "failed";
  threadId?: string;
  goalId?: string;
  proposal?: TeamStaffingOutcome;
  blockReason?: string;
  retryAt?: string;
  providerFailures?: number;
  createdAt: string;
  updatedAt: string;
}

interface StaffingRequestState {
  schemaVersion: 1;
  requests: StaffingRequestRecord[];
}

export class StaffingRequestStore {
  private pending: Promise<void> = Promise.resolve();

  constructor(private readonly workspaceRoot: string) {}

  async list(): Promise<StaffingRequestRecord[]> {
    return (await readJson<StaffingRequestState>(
      this.file(),
      { schemaVersion: 1, requests: [] },
    )).requests;
  }

  async getByTask(taskId: string): Promise<StaffingRequestRecord | undefined> {
    return (await this.list()).find((request) => request.taskId === taskId);
  }

  async save(request: StaffingRequestRecord): Promise<void> {
    const operation = this.pending.then(async () => {
      const requests = await this.list();
      await writeJson(this.file(), {
        schemaVersion: 1,
        requests: [
          ...requests.filter((item) => item.staffingRequestId !== request.staffingRequestId),
          request,
        ],
      } satisfies StaffingRequestState);
    });
    this.pending = operation.catch(() => undefined);
    await operation;
  }

  private file(): string {
    return path.join(this.workspaceRoot, ".autoagent", "mission-control", "staffing-requests.json");
  }
}
