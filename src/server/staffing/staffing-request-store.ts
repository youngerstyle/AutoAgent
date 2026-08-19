import path from "node:path";
import type { TeamStaffingOutcome } from "../../shared/contracts/staffing.js";
import { readJson, updateJson } from "../storage/json.js";

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
  /** Frozen before the first send so retries keep the same message identity and payload. */
  contextMessage?: string;
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
    await updateJson<StaffingRequestState>(this.file(), { schemaVersion: 1, requests: [] }, (current) => ({
        schemaVersion: 1,
        requests: [
          ...current.requests.filter((item) => item.staffingRequestId !== request.staffingRequestId),
          request,
        ],
      } satisfies StaffingRequestState));
  }

  private file(): string {
    return path.join(this.workspaceRoot, ".autoagent", "mission-control", "staffing-requests.json");
  }
}
