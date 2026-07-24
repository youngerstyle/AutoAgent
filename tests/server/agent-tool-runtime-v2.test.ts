import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { EvidenceLedger } from "../../src/server/agent-engine/evidence-ledger.js";
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

  it("pages large text files instead of injecting the whole file into one tool result", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "autoagent-tool-v2-read-page-"));
    const runtime = new AgentToolRuntime({
      profile: "development",
      workspaceRoot: root,
      canReadWorkspace: true,
      canWriteWorkspace: false,
      canExecuteCommands: false,
    }, ["readFile"]);
    await writeFile(path.join(root, "large.log"), "a".repeat(80_000), "utf8");

    const first = await runtime.execute({ tool: "readFile", path: "large.log" });
    expect(first).toMatchObject({
      ok: true,
      offset: 0,
      totalChars: 80_000,
      truncated: true,
      nextOffset: 32_000,
    });
    expect(String(first.content)).toHaveLength(32_000);

    const second = await runtime.execute({ tool: "readFile", path: "large.log", offset: 32_000, limit: 10_000 });
    expect(second).toMatchObject({
      ok: true,
      offset: 32_000,
      totalChars: 80_000,
      truncated: true,
      nextOffset: 42_000,
    });
    expect(String(second.content)).toHaveLength(10_000);
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
    }, ["shell"], { shellYieldMs: 10_000 });

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

  it("keeps a real browser session inside one ticket attempt and records auditable evidence", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "autoagent-tool-v2-browser-"));
    const page = path.join(root, "index.html");
    await writeFile(page, "<!doctype html><title>AutoAgent browser proof</title><button id=\"start\">开始</button>", "utf8");
    const runtime = new AgentToolRuntime({
      profile: "development",
      workspaceRoot: root,
      canReadWorkspace: true,
      canWriteWorkspace: false,
      canExecuteCommands: true,
    }, ["browser"]);
    const baseContext = {
      agentId: "wa_qa",
      threadId: "thread-browser",
      goalId: "goal-browser",
      attemptId: "attempt-browser",
      turnId: "turn-browser",
    };

    const opened = await runtime.execute({
      tool: "browser",
      browserArgs: ["--allow-file-access", "open", pathToFileURL(page).href],
    }, { ...baseContext, toolCallId: "tool-open" });
    const title = await runtime.execute({
      tool: "browser",
      browserArgs: ["get", "title"],
    }, { ...baseContext, toolCallId: "tool-title" });
    await runtime.execute({
      tool: "browser",
      browserArgs: ["close"],
    }, { ...baseContext, toolCallId: "tool-close" });

    expect(opened).toMatchObject({ ok: true, tool: "browser", evidenceId: expect.any(String) });
    expect(title).toMatchObject({ ok: true, tool: "browser", evidenceId: expect.any(String) });
    expect(title.stdout).toContain("AutoAgent browser proof");
    expect(title.session).toBe(opened.session);

    const facts = await new EvidenceLedger(root).getMany([
      String(opened.evidenceId),
      String(title.evidenceId),
    ]);
    expect(facts.get(String(opened.evidenceId))).toMatchObject({
      agentId: "wa_qa",
      goalId: "goal-browser",
      attemptId: "attempt-browser",
      toolName: "browser",
      kind: "browser",
      status: "succeeded",
    });
    expect(facts.get(String(title.evidenceId))?.result).toMatchObject({
      stdout: expect.stringContaining("AutoAgent browser proof"),
    });
  }, 30_000);

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

  it("keeps platform state hidden from agent workspace tools", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "autoagent-tool-v2-platform-state-"));
    await mkdir(path.join(root, ".autoagent"), { recursive: true });
    await mkdir(path.join(root, "src"), { recursive: true });
    await writeFile(path.join(root, ".autoagent", "internal.json"), "{\"secret\":true}", "utf8");
    await writeFile(path.join(root, "src", "app.js"), "console.log('visible')", "utf8");
    const runtime = new AgentToolRuntime({
      profile: "development",
      workspaceRoot: root,
      canReadWorkspace: true,
      canWriteWorkspace: true,
      canExecuteCommands: true,
    }, ["listFiles", "readFile", "writeFile", "shell", "startService"]);

    const rootListing = await runtime.execute({ tool: "listFiles", path: "." });
    expect(rootListing).toMatchObject({ ok: true });
    expect(rootListing.files).toContain("src");
    expect(rootListing.files).not.toContain(".autoagent");

    await expect(runtime.execute({ tool: "readFile", path: ".autoagent/internal.json" })).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining("平台内部状态目录"),
    });
    await expect(runtime.execute({
      tool: "writeFile",
      path: ".autoagent/new.json",
      content: "{}",
    })).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining("平台内部状态目录"),
    });
    await expect(runtime.execute({
      tool: "shell",
      command: process.platform === "win32"
        ? "type .autoagent\\internal.json"
        : "cat .autoagent/internal.json",
    })).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining("平台内部状态目录"),
    });
    await expect(runtime.execute({
      tool: "startService",
      command: process.platform === "win32"
        ? "type .autoagent\\internal.json"
        : "cat .autoagent/internal.json",
    })).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining("平台内部状态目录"),
    });
    await expect(runtime.execute({ tool: "readFile", path: "src/app.js" })).resolves.toMatchObject({
      ok: true,
      content: "console.log('visible')",
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
