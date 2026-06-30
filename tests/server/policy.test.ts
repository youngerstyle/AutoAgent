import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { EventLedger } from "../../src/server/storage/event-ledger";
import { writeWorkspaceFile } from "../../src/server/tools/file-tools";
import { runWorkspaceCommand } from "../../src/server/tools/shell-tool";
import type { Workspace, WorkspaceAgent } from "../../src/shared/types";

describe("tool policy", () => {
  it("denies production writes outside the workspace", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "autoagent-policy-"));
    const context = toolContext(workspace(root, "production"), agent("dev"));

    await expect(writeWorkspaceFile(context, path.join(os.tmpdir(), "escape.txt"), "no")).rejects.toMatchObject({ status: 403 });

    const events = await context.ledger.read(root, "task_1", "tr_1");
    expect(events.some((event) => event.type === "tool.denied")).toBe(true);
  });

  it("allows development writes outside the workspace", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "autoagent-policy-"));
    const outside = path.join(await mkdtemp(path.join(os.tmpdir(), "autoagent-outside-")), "ok.txt");
    const context = toolContext(workspace(root, "development"), agent("dev"));

    await writeWorkspaceFile(context, outside, "ok");

    await expect(readFile(outside, "utf8")).resolves.toBe("ok");
  });

  it("enforces role command permissions", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "autoagent-policy-"));
    const context = toolContext(workspace(root, "production"), agent("pm"));

    await expect(runWorkspaceCommand(context, "node --version")).rejects.toMatchObject({ status: 403 });
  });
});

function workspace(rootPath: string, policyProfile: Workspace["policyProfile"]): Workspace {
  return { id: "ws_1", name: "Workspace", rootPath, policyProfile, createdAt: new Date().toISOString() };
}

function agent(roleInWorkspace: WorkspaceAgent["roleInWorkspace"]): WorkspaceAgent {
  return { id: `wa_${roleInWorkspace}`, workspaceId: "ws_1", profileId: `prof_${roleInWorkspace}`, roleInWorkspace, agentDir: "agent", status: "idle" };
}

function toolContext(workspaceValue: Workspace, agentValue: WorkspaceAgent) {
  return {
    workspace: workspaceValue,
    agent: agentValue,
    taskId: "task_1",
    taskRunId: "tr_1",
    ledger: new EventLedger()
  };
}
