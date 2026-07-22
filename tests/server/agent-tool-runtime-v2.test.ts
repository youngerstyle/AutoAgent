import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AgentToolRuntime } from "../../src/server/agent-engine/tool-runtime.js";

describe("AgentToolRuntime", () => {
  it("uses explicit configured tools instead of role routing", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "autoagent-tool-v2-"));
    const runtime = new AgentToolRuntime({
      profile: "development",
      workspaceRoot: root,
      canReadWorkspace: true,
      canWriteWorkspace: true,
      canExecuteCommands: false,
    }, ["writeFile"]);

    expect(await runtime.execute({ tool: "readFile", path: "note.txt" })).toMatchObject({ ok: false });
    expect(await runtime.execute({ tool: "writeFile", path: "note.txt", content: "hello" })).toMatchObject({ ok: true });
    expect(await readFile(path.join(root, "note.txt"), "utf8")).toBe("hello");
  });

  it("turns command failures into observations", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "autoagent-tool-v2-shell-"));
    const runtime = new AgentToolRuntime({
      profile: "development",
      workspaceRoot: root,
      canReadWorkspace: true,
      canWriteWorkspace: true,
      canExecuteCommands: true,
    }, ["shell"]);

    const result = await runtime.execute({ tool: "shell", command: "node -e \"process.exit(3)\"" });
    expect(result).toMatchObject({ tool: "shell", ok: false, exitCode: 3 });
  });

  it("yields a long-running shell command as a pollable managed process", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "autoagent-tool-v2-yield-"));
    const runtime = new AgentToolRuntime({
      profile: "development",
      workspaceRoot: root,
      canReadWorkspace: true,
      canWriteWorkspace: true,
      canExecuteCommands: true,
    }, ["shell", "pollProcess"], { shellYieldMs: 30 });

    const started = await runtime.execute({
      tool: "shell",
      command: "node -e \"setTimeout(() => console.log('finished'), 150)\"",
    });
    expect(started).toMatchObject({ tool: "shell", ok: true, running: true, serviceId: expect.any(String) });

    await new Promise((resolve) => setTimeout(resolve, 250));
    const completed = await runtime.execute({ tool: "pollProcess", serviceId: String(started.serviceId) });
    expect(completed).toMatchObject({ tool: "pollProcess", ok: true, running: false, exitCode: 0 });
    expect(completed.stdout).toContain("finished");
  });

  it("settles parallel shell calls even when one command remains running", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "autoagent-tool-v2-parallel-"));
    const runtime = new AgentToolRuntime({
      profile: "development",
      workspaceRoot: root,
      canReadWorkspace: true,
      canWriteWorkspace: true,
      canExecuteCommands: true,
    }, ["shell"], { shellYieldMs: 200 });

    const [short, long] = await Promise.all([
      runtime.execute({ tool: "shell", command: "node -e \"console.log('short')\"" }),
      runtime.execute({ tool: "shell", command: "node -e \"setTimeout(() => {}, 1000)\"" }),
    ]);
    expect(short).toMatchObject({ ok: true, running: false, exitCode: 0 });
    expect(long).toMatchObject({ ok: true, running: true, serviceId: expect.any(String) });
  });

  it("rejects relative and absolute paths outside the workspace when host access is disabled", async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), "autoagent-tool-v2-boundary-"));
    const root = path.join(parent, "workspace");
    const outside = path.join(parent, "outside.txt");
    await writeFile(outside, "secret", "utf8");
    const runtime = new AgentToolRuntime({
      profile: "development",
      workspaceRoot: root,
      canReadWorkspace: true,
      canWriteWorkspace: true,
      canExecuteCommands: false,
      allowHostAccess: false,
    }, ["listFiles", "readFile", "writeFile"]);

    await expect(runtime.execute({ tool: "readFile", path: "../outside.txt" })).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining("Path escapes workspace"),
    });
    await expect(runtime.execute({ tool: "readFile", path: outside })).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining("Path escapes workspace"),
    });
    await expect(runtime.execute({ tool: "writeFile", path: "../created.txt", content: "bad" })).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining("Path escapes workspace"),
    });
  });

  it("keeps relative paths workspace-scoped even when explicit host access is enabled", async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), "autoagent-tool-v2-host-boundary-"));
    const root = path.join(parent, "workspace");
    const outside = path.join(parent, "outside.txt");
    await writeFile(outside, "reference", "utf8");
    const runtime = new AgentToolRuntime({
      profile: "development",
      workspaceRoot: root,
      canReadWorkspace: true,
      canWriteWorkspace: true,
      canExecuteCommands: false,
      allowHostAccess: true,
    }, ["listFiles", "readFile", "writeFile"]);

    await expect(runtime.execute({ tool: "listFiles", path: ".." })).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining("Path escapes workspace"),
    });
    await expect(runtime.execute({ tool: "readFile", path: "../outside.txt" })).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining("Path escapes workspace"),
    });
    await expect(runtime.execute({ tool: "readFile", path: outside })).resolves.toMatchObject({
      ok: true,
      content: "reference",
    });
  });

  it("describes the actual host shell and directs file creation through writeFile", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "autoagent-tool-v2-definition-"));
    const runtime = new AgentToolRuntime({
      profile: "development",
      workspaceRoot: root,
      canReadWorkspace: true,
      canWriteWorkspace: true,
      canExecuteCommands: true,
    }, ["writeFile", "shell", "startService"]);

    const definitions = runtime.definitions();
    const shell = definitions.find((item) => item.name === "shell");
    const startService = definitions.find((item) => item.name === "startService");

    expect(shell?.description).toContain("writeFile");
    if (process.platform === "win32") {
      expect(shell?.description).toContain("Windows cmd.exe");
      expect(shell?.description).toContain("不要使用 Bash heredoc");
      expect(startService?.description).toContain("Windows cmd.exe");
    } else {
      expect(shell?.description).toContain("POSIX shell");
      expect(startService?.description).toContain("POSIX shell");
    }
  });
});
