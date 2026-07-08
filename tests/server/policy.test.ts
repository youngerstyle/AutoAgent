import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { EventLedger } from "../../src/server/storage/event-ledger";
import { writeWorkspaceFile } from "../../src/server/tools/file-tools";
import { pollWorkspaceProcess, runWorkspaceCommand, startWorkspaceService } from "../../src/server/tools/shell-tool";
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

  it("allows non-developer roles to write project documents inside their artifact boundary", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "autoagent-policy-"));
    const context = toolContext(workspace(root, "production"), agent("pm"));

    await writeWorkspaceFile(context, "docs/plan.md", "计划");

    await expect(readFile(path.join(root, "docs", "plan.md"), "utf8")).resolves.toBe("计划");
  });

  it("still denies non-developer roles from writing source or runnable deliverables", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "autoagent-policy-"));
    const context = toolContext(workspace(root, "production"), agent("pm"));

    await expect(writeWorkspaceFile(context, "index.html", "<canvas></canvas>")).rejects.toMatchObject({ status: 403 });
  });

  it("starts long-running services without blocking the agent loop", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "autoagent-policy-"));
    const context = toolContext(workspace(root, "development"), agent("dev"));
    await writeFile(
      path.join(root, "service.js"),
      "console.log('http://127.0.0.1:12345'); setTimeout(() => process.exit(0), 10000); setInterval(() => {}, 1000);\n",
      "utf8"
    );

    const result = await startWorkspaceService(context, "node service.js");

    try {
      expect(result.exitCode).toBe(0);
      expect(result.running).toBe(true);
      expect(result.serviceId).toMatch(/^svc_/);
      expect(result.urls).toContain("http://127.0.0.1:12345");
      const poll = await pollWorkspaceProcess(context, result.serviceId);
      expect(poll.running).toBe(true);
      expect(poll.stdout).toContain("http://127.0.0.1:12345");
    } finally {
      if (result.pid) {
        try {
          process.kill(result.pid);
        } catch {
          // Process may have exited on its own.
        }
      }
    }
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
