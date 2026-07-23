import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AgentToolRuntime, agentCommandEnvironment } from "../../src/server/agent-engine/tool-runtime.js";

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

  it("exposes platform-installed Skill CLIs inside workspace shell commands", async () => {
    const environment = agentCommandEnvironment({ PATH: "host-bin" }, "C:\\platform");
    expect(environment.PATH).toBe(["C:\\platform", "node_modules", ".bin"].join(path.sep) + path.delimiter + "host-bin");

    const root = await mkdtemp(path.join(os.tmpdir(), "autoagent-tool-v2-skill-cli-"));
    const runtime = new AgentToolRuntime({
      profile: "development",
      workspaceRoot: root,
      canReadWorkspace: true,
      canWriteWorkspace: true,
      canExecuteCommands: true,
    }, ["shell"]);

    const result = await runtime.execute({ tool: "shell", command: "agent-browser --version" });
    expect(result).toMatchObject({ tool: "shell", ok: true, exitCode: 0 });
    expect(String(result.stdout)).toMatch(/\d+\.\d+\.\d+/);
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

    let completed = await runtime.execute({ tool: "pollProcess", serviceId: String(started.serviceId) });
    const deadline = Date.now() + 2_000;
    while (completed.running && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      completed = await runtime.execute({ tool: "pollProcess", serviceId: String(started.serviceId) });
    }
    expect(completed).toMatchObject({ tool: "pollProcess", ok: true, running: false, exitCode: 0 });
    expect(completed.stdout).toContain("finished");
  });

  it("returns workspace images as model-ready observations", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "autoagent-tool-v2-image-"));
    const image = Buffer.from("89504e470d0a1a0a00000000", "hex");
    await writeFile(path.join(root, "screen.png"), image);
    const runtime = new AgentToolRuntime({
      profile: "development",
      workspaceRoot: root,
      canReadWorkspace: true,
      canWriteWorkspace: false,
      canExecuteCommands: false,
    }, ["readImage"]);

    await expect(runtime.execute({ tool: "readImage", path: "screen.png" })).resolves.toMatchObject({
      tool: "readImage",
      ok: true,
      mimeType: "image/png",
      data: image.toString("base64"),
      size: image.length,
    });
  });

  it("settles parallel shell calls even when one command remains running", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "autoagent-tool-v2-parallel-"));
    const runtime = new AgentToolRuntime({
      profile: "development",
      workspaceRoot: root,
      canReadWorkspace: true,
      canWriteWorkspace: true,
      canExecuteCommands: true,
    }, ["shell", "pollProcess"], { shellYieldMs: 200 });

    const [short, long] = await Promise.all([
      runtime.execute({ tool: "shell", command: "node -e \"console.log('short')\"" }),
      runtime.execute({ tool: "shell", command: "node -e \"setTimeout(() => {}, 3000)\"" }),
    ]);
    let settledShort = short;
    const deadline = Date.now() + 2_000;
    while (settledShort.running && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      settledShort = await runtime.execute({ tool: "pollProcess", serviceId: String(short.serviceId) });
    }
    expect(settledShort).toMatchObject({ ok: true, running: false, exitCode: 0 });
    expect(settledShort.stdout).toContain("short");
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
