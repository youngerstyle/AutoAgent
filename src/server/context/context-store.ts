import { mkdir } from "node:fs/promises";
import path from "node:path";
import { readJson, writeJson } from "../storage/json.js";
import { workspaceAgentContextFile, workspaceAgentDir, workspaceAgentMemoryFile } from "../storage/paths.js";
import type { AgentContextState, WorkspaceAgentMemory } from "./types.js";

export class ContextStore {
  async readState(workspaceRoot: string, workspaceAgentId: string, taskRunId: string): Promise<AgentContextState> {
    return readJson<AgentContextState>(workspaceAgentContextFile(workspaceRoot, workspaceAgentId, taskRunId), {
      id: taskRunId,
      workspaceAgentId,
      taskRunId,
      checkpoints: [],
      updatedAt: new Date().toISOString()
    });
  }

  async writeState(workspaceRoot: string, workspaceAgentId: string, taskRunId: string, state: AgentContextState): Promise<void> {
    await writeJson(workspaceAgentContextFile(workspaceRoot, workspaceAgentId, taskRunId), state);
  }

  async readMemory(workspaceRoot: string, workspaceAgentId: string): Promise<WorkspaceAgentMemory> {
    return readJson<WorkspaceAgentMemory>(workspaceAgentMemoryFile(workspaceRoot, workspaceAgentId), {
      workspaceAgentId,
      durableFacts: [],
      projectConventions: [],
      knownCommands: [],
      recentLessons: [],
      updatedAt: new Date().toISOString()
    });
  }

  async writeMemory(workspaceRoot: string, workspaceAgentId: string, memory: WorkspaceAgentMemory): Promise<void> {
    await mkdir(path.dirname(workspaceAgentMemoryFile(workspaceRoot, workspaceAgentId)), { recursive: true });
    await writeJson(workspaceAgentMemoryFile(workspaceRoot, workspaceAgentId), memory);
  }

  async ensureContextDir(workspaceRoot: string, workspaceAgentId: string): Promise<string> {
    const dir = path.join(workspaceAgentDir(workspaceRoot, workspaceAgentId), "context");
    await mkdir(dir, { recursive: true });
    return dir;
  }
}

