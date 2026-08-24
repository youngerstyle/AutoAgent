import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { createConnection, createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { EvidenceLedger } from "../../src/server/agent-engine/evidence-ledger.js";
import {
  AgentToolRuntime,
  agentCommandEnvironment,
  normalizeBrowserArgs,
  requiredBrowserArgs,
} from "../../src/server/agent-engine/tool-runtime.js";

describe("AgentToolRuntime", () => {
  it("normalizes shell-style Skill commands at the browser tool boundary", () => {
    expect(normalizeBrowserArgs(["set viewport 1264 900"]))
      .toEqual(["set", "viewport", "1264", "900"]);
    expect(normalizeBrowserArgs(["fill @e1 \"hello world\""]))
      .toEqual(["fill", "@e1", "hello world"]);
    expect(normalizeBrowserArgs(["set", "viewport", "1264", "900"]))
      .toEqual(["set", "viewport", "1264", "900"]);
    expect(requiredBrowserArgs(["set viewport 1264 900"]))
      .toEqual(["set", "viewport", "1264", "900"]);
  });

  it("rejects an unclosed quoted Skill command instead of executing a partial command", () => {
    expect(() => normalizeBrowserArgs(["fill @e1 \"unfinished"]))
      .toThrow("未闭合的引号");
  });

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

  it("scopes Ticket tools to an isolated root while retaining canonical evidence ownership", async () => {
    const canonical = await mkdtemp(path.join(os.tmpdir(), "autoagent-tool-v2-canonical-"));
    const isolated = await mkdtemp(path.join(os.tmpdir(), "autoagent-tool-v2-isolated-"));
    const runtime = new AgentToolRuntime({
      profile: "development",
      workspaceRoot: canonical,
      canReadWorkspace: true,
      canWriteWorkspace: true,
      canExecuteCommands: false,
    }, ["writeFile"]);
    const scoped = runtime.scoped(isolated);

    const result = await scoped.execute({ tool: "writeFile", path: "delivery.txt", content: "isolated" }, {
      agentId: "dev",
      threadId: "thread",
      goalId: "goal",
      attemptId: "attempt",
      turnId: "turn",
      toolCallId: "write-isolated",
    });

    expect(await readFile(path.join(isolated, "delivery.txt"), "utf8")).toBe("isolated");
    await expect(readFile(path.join(canonical, "delivery.txt"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(await new EvidenceLedger(canonical).get(String(result.evidenceId))).toMatchObject({
      workspaceRoot: canonical,
      artifact: { path: "delivery.txt" },
      attemptId: "attempt",
    });
    await scoped.dispose();
    await runtime.dispose();
  });

  it("edits one unique text occurrence without rewriting the whole file", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "autoagent-tool-v2-edit-"));
    const target = path.join(root, "game.js");
    await writeFile(target, "const lives = 3;\nconst stages = 1;\n", "utf8");
    const runtime = new AgentToolRuntime({
      profile: "development",
      workspaceRoot: root,
      canReadWorkspace: true,
      canWriteWorkspace: true,
      canExecuteCommands: false,
    }, ["editFile"]);

    const result = await runtime.execute({
      tool: "editFile",
      path: "game.js",
      oldText: "const stages = 1;",
      newText: "const stages = 3;",
    });

    expect(result).toMatchObject({ ok: true, replacements: 1 });
    expect(await readFile(target, "utf8")).toBe("const lives = 3;\nconst stages = 3;\n");
  });

  it("rejects missing or ambiguous edit targets without modifying the file", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "autoagent-tool-v2-edit-reject-"));
    const target = path.join(root, "game.js");
    const original = "const value = 1;\nconst value = 1;\n";
    await writeFile(target, original, "utf8");
    const runtime = new AgentToolRuntime({
      profile: "development",
      workspaceRoot: root,
      canReadWorkspace: true,
      canWriteWorkspace: true,
      canExecuteCommands: false,
    }, ["editFile"]);

    await expect(runtime.execute({
      tool: "editFile",
      path: "game.js",
      oldText: "const missing = true;",
      newText: "const missing = false;",
    })).resolves.toMatchObject({ ok: false });
    expect(await readFile(target, "utf8")).toBe(original);

    await expect(runtime.execute({
      tool: "editFile",
      path: "game.js",
      oldText: "const value = 1;",
      newText: "const value = 2;",
    })).resolves.toMatchObject({ ok: false });
    expect(await readFile(target, "utf8")).toBe(original);
  });

  it("serializes concurrent file edits so one successful edit cannot overwrite another", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "autoagent-tool-v2-edit-serial-"));
    const target = path.join(root, "game.js");
    await writeFile(target, "const lives = 1;\nconst stages = 1;\n", "utf8");
    const runtime = new AgentToolRuntime({
      profile: "development",
      workspaceRoot: root,
      canReadWorkspace: true,
      canWriteWorkspace: true,
      canExecuteCommands: false,
    }, ["editFile"]);

    const [lives, stages] = await Promise.all([
      runtime.execute({
        tool: "editFile",
        path: "game.js",
        oldText: "const lives = 1;",
        newText: "const lives = 3;",
      }),
      runtime.execute({
        tool: "editFile",
        path: "game.js",
        oldText: "const stages = 1;",
        newText: "const stages = 3;",
      }),
    ]);

    expect(lives).toMatchObject({ ok: true, replacements: 1 });
    expect(stages).toMatchObject({ ok: true, replacements: 1 });
    expect(await readFile(target, "utf8")).toBe("const lives = 3;\nconst stages = 3;\n");
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
    }, ["shell"], { shellYieldMs: 10_000 });

    const result = await runtime.execute(
      { tool: "shell", command: "node -e \"process.exit(3)\"" },
      {
        agentId: "wa_qa",
        threadId: "thread-negative-command",
        goalId: "goal-negative-command",
        attemptId: "attempt-negative-command",
        turnId: "turn-negative-command",
        toolCallId: "tool-negative-command",
      },
    );
    expect(result).toMatchObject({
      tool: "shell",
      ok: false,
      exitCode: 3,
      evidenceId: expect.any(String),
    });
    expect(await new EvidenceLedger(root).get(String(result.evidenceId))).toMatchObject({
      capture: { status: "recorded" },
      observation: {
        status: "observed",
        result: expect.objectContaining({ ok: false, exitCode: 3 }),
      },
    });
  });

  it("exposes platform-installed Skill CLIs inside workspace shell commands", async () => {
    const environment = agentCommandEnvironment({
      PATH: "host-bin",
      PORT: "13748",
      AUTOAGENT_HOME: "C:\\platform-state",
      OPENAI_API_KEY: "provider-secret",
    }, "C:\\platform");
    expect(environment.PATH).toBe(["C:\\platform", "node_modules", ".bin"].join(path.sep) + path.delimiter + "host-bin");
    expect(environment.PORT).toBeUndefined();
    expect(environment.AUTOAGENT_HOME).toBeUndefined();
    expect(environment.OPENAI_API_KEY).toBe("provider-secret");

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

  it("prevents shell from bypassing enabled browser and service tools", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "autoagent-tool-v2-dedicated-"));
    const runtime = new AgentToolRuntime({
      profile: "development",
      workspaceRoot: root,
      canReadWorkspace: true,
      canWriteWorkspace: true,
      canExecuteCommands: true,
    }, ["shell", "browser", "startService"]);

    await expect(runtime.execute({
      tool: "shell",
      command: "agent-browser open http://127.0.0.1:4173",
    })).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining("browser"),
    });
    await expect(runtime.execute({
      tool: "shell",
      command: "python -m http.server 4173",
    })).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining("startService"),
    });
  });

  it("rejects an occupied service port before spawning the command", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "autoagent-tool-v2-port-conflict-"));
    const occupied = createServer();
    await new Promise<void>((resolve, reject) => {
      occupied.once("error", reject);
      occupied.listen(0, "127.0.0.1", resolve);
    });
    const address = occupied.address();
    if (!address || typeof address === "string") throw new Error("test server did not expose a port");

    try {
      const runtime = new AgentToolRuntime({
        profile: "development",
        workspaceRoot: root,
        canReadWorkspace: true,
        canWriteWorkspace: true,
        canExecuteCommands: true,
      }, ["startService"]);
      await expect(runtime.execute({
        tool: "startService",
        command: "node -e \"setInterval(() => {}, 1000)\"",
        port: address.port,
      })).resolves.toMatchObject({
        ok: false,
        error: expect.stringContaining(`端口 ${address.port}`),
      });
    } finally {
      await new Promise<void>((resolve, reject) => occupied.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("allocates an available service port when the command uses the port placeholder", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "autoagent-tool-v2-auto-port-"));
    const runtime = new AgentToolRuntime({
      profile: "development",
      workspaceRoot: root,
      canReadWorkspace: true,
      canWriteWorkspace: true,
      canExecuteCommands: true,
    }, ["startService"], { serviceStartupTimeoutMs: 10_000 });

    try {
      const result = await runtime.execute({
        tool: "startService",
        command: "node -e \"const s=require('node:http').createServer((_q,r)=>r.end('auto'));s.listen({port:{port},host:'127.0.0.1'});setTimeout(()=>s.close(),5000)\"",
        port: 0,
      });

      expect(result, JSON.stringify(result)).toMatchObject({
        tool: "startService",
        ok: true,
        running: true,
        port: expect.any(Number),
      });
      expect(result.command).not.toContain("{port}");
    } finally {
      await runtime.dispose();
    }
  });

  it("requires the port placeholder when automatic service port allocation is requested", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "autoagent-tool-v2-auto-port-contract-"));
    const runtime = new AgentToolRuntime({
      profile: "development",
      workspaceRoot: root,
      canReadWorkspace: true,
      canWriteWorkspace: true,
      canExecuteCommands: true,
    }, ["startService"]);

    await expect(runtime.execute({
      tool: "startService",
      command: "node -e \"setInterval(() => {}, 1000)\"",
    })).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining("{port}"),
    });
  });

  it("allows only one concurrent managed service to claim a port", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "autoagent-tool-v2-port-race-"));
    const probe = createServer();
    await new Promise<void>((resolve, reject) => {
      probe.once("error", reject);
      probe.listen(0, "127.0.0.1", resolve);
    });
    const address = probe.address();
    if (!address || typeof address === "string") throw new Error("test probe did not expose a port");
    await new Promise<void>((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));

    const runtimeA = new AgentToolRuntime({
      profile: "development",
      workspaceRoot: root,
      canReadWorkspace: true,
      canWriteWorkspace: true,
      canExecuteCommands: true,
    }, ["startService"], { serviceStartupTimeoutMs: 10_000 });
    const runtimeB = new AgentToolRuntime({
      profile: "development",
      workspaceRoot: root,
      canReadWorkspace: true,
      canWriteWorkspace: true,
      canExecuteCommands: true,
    }, ["startService"], { serviceStartupTimeoutMs: 10_000 });
    const command = `node -e "require('node:http').createServer((_q,r)=>r.end('owned')).listen(${address.port},'127.0.0.1');setTimeout(()=>process.exit(0),5000)"`;

    const results = await Promise.all([
      runtimeA.execute({ tool: "startService", command, port: address.port }),
      runtimeB.execute({ tool: "startService", command, port: address.port }),
    ]);

    expect(results.filter((result) => result.ok), JSON.stringify(results)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toEqual([
      expect.objectContaining({ error: expect.stringContaining(String(address.port)) }),
    ]);
  });

  it("returns the real failure when a service exits during startup", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "autoagent-tool-v2-start-failure-"));
    const probe = createServer();
    await new Promise<void>((resolve, reject) => {
      probe.once("error", reject);
      probe.listen(0, "127.0.0.1", resolve);
    });
    const address = probe.address();
    if (!address || typeof address === "string") throw new Error("test probe did not expose a port");
    await new Promise<void>((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));

    const runtime = new AgentToolRuntime({
      profile: "development",
      workspaceRoot: root,
      canReadWorkspace: true,
      canWriteWorkspace: true,
      canExecuteCommands: true,
    }, ["startService"], { shellYieldMs: 250 });
    const result = await runtime.execute({
      tool: "startService",
      command: "node -e \"console.error('startup failed'); process.exit(7)\"",
      port: address.port,
    });
    expect(result).toMatchObject({
      tool: "startService",
      ok: false,
      running: false,
      exitCode: 7,
      port: address.port,
    });
    expect(result.stderr).toContain("startup failed");
  });

  it("records a successfully started service as completed evidence while its process remains running", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "autoagent-tool-v2-service-evidence-"));
    const probe = createServer();
    await new Promise<void>((resolve, reject) => {
      probe.once("error", reject);
      probe.listen(0, "127.0.0.1", resolve);
    });
    const address = probe.address();
    if (!address || typeof address === "string") throw new Error("test probe did not expose a port");
    await new Promise<void>((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
    const runtime = new AgentToolRuntime({
      profile: "development",
      workspaceRoot: root,
      canReadWorkspace: true,
      canWriteWorkspace: true,
      canExecuteCommands: true,
    }, ["startService", "pollProcess"], { shellYieldMs: 30, serviceStartupTimeoutMs: 10_000 });
    const context = {
      agentId: "wa_dev",
      threadId: "thread-service",
      goalId: "goal-service",
      attemptId: "attempt-service",
      turnId: "turn-service",
      toolCallId: "tool-start-service",
    };

    const started = await runtime.execute({
      tool: "startService",
      command: `node -e "const s=require('node:http').createServer((q,r)=>r.end('ok'));s.listen(${address.port},'127.0.0.1');setTimeout(()=>s.close(),1500)"`,
      port: address.port,
    }, context);
    expect(started, JSON.stringify(started)).toMatchObject({
      ok: true,
      running: true,
      evidenceId: expect.any(String),
    });

    const fact = await new EvidenceLedger(root).get(String(started.evidenceId));
    expect(fact).toMatchObject({
      kind: "service",
      capture: { status: "recorded" },
      observation: {
        status: "observed",
        result: expect.objectContaining({ running: true }),
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 1_600));
    await runtime.execute({ tool: "pollProcess", serviceId: String(started.serviceId) });
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
    const deadline = Date.now() + 10_000;
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
      capture: { status: "recorded" },
      observation: { status: "observed" },
    });
    expect(facts.get(String(title.evidenceId))?.observation.result).toMatchObject({
      stdout: expect.stringContaining("AutoAgent browser proof"),
    });
  }, 90_000);

  it("serializes concurrent browser calls that share one ticket-attempt session", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "autoagent-tool-v2-browser-queue-"));
    let activeCommands = 0;
    let maxActiveCommands = 0;
    let currentUrl = "https://example.com/initial";
    const commandOrder: string[] = [];
    const runtime = new AgentToolRuntime({
      profile: "development",
      workspaceRoot: root,
      canReadWorkspace: true,
      canWriteWorkspace: false,
      canExecuteCommands: true,
    }, ["browser"], {
      browserCommandRunner: async (_executable, args) => {
        const command = args.includes("open")
          ? `open:${args[args.indexOf("open") + 1]}`
          : args.includes("url") ? "get:url" : "other";
        activeCommands += 1;
        maxActiveCommands = Math.max(maxActiveCommands, activeCommands);
        commandOrder.push(`start:${command}`);
        await new Promise((resolve) => setTimeout(resolve, command.startsWith("open:") ? 20 : 5));
        if (command.startsWith("open:")) currentUrl = command.slice("open:".length);
        commandOrder.push(`end:${command}`);
        activeCommands -= 1;
        return {
          stdout: command === "get:url" ? currentUrl : "",
          stderr: "",
          exitCode: 0,
        };
      },
    });
    const context = {
      agentId: "wa_qa",
      threadId: "thread-browser-queue",
      goalId: "goal-browser-queue",
      attemptId: "attempt-browser-queue",
      turnId: "turn-browser-queue",
    };

    const [first, second] = await Promise.all([
      runtime.execute({
        tool: "browser",
        browserArgs: ["open", "https://example.com/first"],
      }, { ...context, toolCallId: "tool-first" }),
      runtime.execute({
        tool: "browser",
        browserArgs: ["open", "https://example.com/second"],
      }, { ...context, toolCallId: "tool-second" }),
    ]);

    expect(maxActiveCommands).toBe(1);
    expect(first).toMatchObject({ ok: true, pageUrl: "https://example.com/first" });
    expect(second).toMatchObject({ ok: true, pageUrl: "https://example.com/second" });
    expect(commandOrder).toEqual([
      "start:open:https://example.com/first",
      "end:open:https://example.com/first",
      "start:get:url",
      "end:get:url",
      "start:open:https://example.com/second",
      "end:open:https://example.com/second",
      "start:get:url",
      "end:get:url",
    ]);
    await runtime.dispose();
    await rm(root, { recursive: true, force: true });
  });

  it("replaces a stale browser session and replays only a safe observation command", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "autoagent-tool-v2-browser-recover-"));
    const pageUrl = pathToFileURL(path.join(root, "index.html")).href;
    const calls: string[][] = [];
    let openAttempts = 0;
    const runtime = new AgentToolRuntime({
      profile: "development",
      workspaceRoot: root,
      canReadWorkspace: true,
      canWriteWorkspace: false,
      canExecuteCommands: true,
    }, ["browser"], {
      browserCommandRunner: async (_executable, args) => {
        calls.push(args);
        if (args.includes("close")) return { stdout: "", stderr: "", exitCode: 0 };
        if (args.includes("open") && openAttempts++ === 0) {
          return { stdout: "", stderr: "Failed to read: connection timed out (os error 10060)", exitCode: 1 };
        }
        if (args.includes("open")) return { stdout: "opened", stderr: "", exitCode: 0 };
        if (args.includes("url")) return { stdout: pageUrl, stderr: "", exitCode: 0 };
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    });
    const context = {
      agentId: "wa_qa",
      threadId: "thread-recover",
      goalId: "goal-recover",
      attemptId: "attempt-recover",
      turnId: "turn-recover",
      toolCallId: "tool-open",
    };

    const result = await runtime.execute({
      tool: "browser",
      browserArgs: ["--allow-file-access", "open", pageUrl],
    }, context);

    expect(result).toMatchObject({
      ok: true,
      sessionRecovered: true,
      pageUrl,
    });
    const openedSessions = calls
      .filter((args) => args.includes("open"))
      .map((args) => args[args.indexOf("--session") + 1]);
    expect(openedSessions).toHaveLength(2);
    expect(openedSessions[1]).not.toBe(openedSessions[0]);
    await runtime.dispose();
  });

  it("closes the ticket browser session when its execution resources are released", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "autoagent-tool-v2-browser-release-"));
    const page = path.join(root, "index.html");
    await writeFile(page, "<!doctype html><title>Goal browser resource</title>", "utf8");
    const runtime = new AgentToolRuntime({
      profile: "development",
      workspaceRoot: root,
      canReadWorkspace: true,
      canWriteWorkspace: false,
      canExecuteCommands: true,
    }, ["browser"]);
    const context = {
      agentId: "wa_qa",
      threadId: "thread-release",
      goalId: "goal-release",
      attemptId: "attempt-release",
      turnId: "turn-release",
    };

    const opened = await runtime.execute({
      tool: "browser",
      browserArgs: ["--allow-file-access", "open", pathToFileURL(page).href],
    }, { ...context, toolCallId: "tool-open" });
    expect(opened).toMatchObject({ ok: true, tool: "browser" });

    await runtime.releaseExecutionResources(context);

    const afterRelease = await runtime.execute({
      tool: "browser",
      browserArgs: ["get", "title"],
    }, { ...context, toolCallId: "tool-after-release" });
    expect(afterRelease).toMatchObject({ ok: true, tool: "browser" });
    expect(String(afterRelease.stdout)).not.toContain("Goal browser resource");
    await runtime.dispose();
  }, 90_000);

  it("rejects browser evidence from an unregistered local service", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "autoagent-tool-v2-browser-provenance-"));
    const foreign = createHttpServer((_request, response) => response.end("foreign workspace"));
    await new Promise<void>((resolve, reject) => {
      foreign.once("error", reject);
      foreign.listen(0, "127.0.0.1", resolve);
    });
    const address = foreign.address();
    if (!address || typeof address === "string") throw new Error("test server did not expose a port");
    const runtime = new AgentToolRuntime({
      profile: "development",
      workspaceRoot: root,
      canReadWorkspace: true,
      canWriteWorkspace: false,
      canExecuteCommands: true,
    }, ["browser"]);

    try {
      await expect(runtime.execute({
        tool: "browser",
        browserArgs: ["open", `http://127.0.0.1:${address.port}`],
      })).resolves.toMatchObject({
        ok: false,
        error: expect.stringContaining("不属于当前工作区正在运行的受管服务"),
      });
    } finally {
      await new Promise<void>((resolve, reject) => foreign.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("binds local browser evidence to the current workspace managed service", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "autoagent-tool-v2-browser-service-"));
    await writeFile(path.join(root, "server.js"), [
      "const http = require('http');",
      "http.createServer((_req,res)=>res.end('<title>managed proof</title>')).listen(Number(process.env.PORT));",
    ].join("\n"), "utf8");
    const probe = createServer();
    await new Promise<void>((resolve, reject) => {
      probe.once("error", reject);
      probe.listen(0, "127.0.0.1", resolve);
    });
    const address = probe.address();
    if (!address || typeof address === "string") throw new Error("test probe did not expose a port");
    await new Promise<void>((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));

    const runtime = new AgentToolRuntime({
      profile: "development",
      workspaceRoot: root,
      canReadWorkspace: true,
      canWriteWorkspace: true,
      canExecuteCommands: true,
    }, ["startService", "browser"], { shellYieldMs: 100 });
    const command = process.platform === "win32"
      ? `set PORT=${address.port}&& node server.js`
      : `PORT=${address.port} node server.js`;
    const executionContext = {
      agentId: "wa_qa",
      threadId: "thread-managed-browser",
      goalId: "goal-managed-browser",
      attemptId: "attempt-managed-browser",
      turnId: "turn-managed-browser",
      toolCallId: "tool-managed-browser",
    };
    const started = await runtime.execute({
      tool: "startService",
      command,
      port: address.port,
    }, { ...executionContext, toolCallId: "tool-start-managed-browser" });
    expect(started).toMatchObject({ ok: true, running: true });

    const opened = await runtime.execute({
      tool: "browser",
      browserArgs: ["open", `http://127.0.0.1:${address.port}`],
    }, executionContext);
    expect(opened).toMatchObject({
      ok: true,
      pageUrl: `http://127.0.0.1:${address.port}/`,
      localService: {
        serviceId: started.serviceId,
        port: address.port,
      },
      evidenceId: expect.any(String),
    });
    await runtime.dispose();
  }, 90_000);

  it("does not let another Ticket Attempt poll or browse a managed service", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "autoagent-tool-v2-service-owner-"));
    const probe = createServer();
    await new Promise<void>((resolve, reject) => {
      probe.once("error", reject);
      probe.listen(0, "127.0.0.1", resolve);
    });
    const address = probe.address();
    if (!address || typeof address === "string") throw new Error("test probe did not expose a port");
    await new Promise<void>((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));

    const runtime = new AgentToolRuntime({
      profile: "development",
      workspaceRoot: root,
      canReadWorkspace: true,
      canWriteWorkspace: true,
      canExecuteCommands: true,
    }, ["startService", "pollProcess", "browser"], { serviceStartupTimeoutMs: 10_000 });
    const owner = {
      agentId: "wa_dev",
      threadId: "thread-dev",
      goalId: "goal-dev",
      attemptId: "attempt-dev",
      turnId: "turn-dev",
      toolCallId: "start",
    };
    const otherAttempt = {
      agentId: "wa_qa",
      threadId: "thread-qa",
      goalId: "goal-qa",
      attemptId: "attempt-qa",
      turnId: "turn-qa",
      toolCallId: "observe",
    };
    const started = await runtime.execute({
      tool: "startService",
      command: `node -e "require('node:http').createServer((_q,r)=>r.end('owned')).listen(${address.port},'127.0.0.1');setTimeout(()=>process.exit(0),5000)"`,
      port: address.port,
    }, owner);
    expect(started).toMatchObject({ ok: true, running: true });

    await expect(runtime.execute({
      tool: "pollProcess",
      serviceId: String(started.serviceId),
    }, otherAttempt)).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining("不属于当前 Agent Ticket Attempt"),
    });
    await expect(runtime.execute({
      tool: "browser",
      browserArgs: ["open", `http://127.0.0.1:${address.port}`],
    }, otherAttempt)).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining("不属于当前工作区正在运行的受管服务"),
    });
    await runtime.dispose();
  });

  it("terminates owned managed services when the Agent runtime is disposed", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "autoagent-tool-v2-dispose-"));
    const probe = createServer();
    await new Promise<void>((resolve, reject) => {
      probe.once("error", reject);
      probe.listen(0, "127.0.0.1", resolve);
    });
    const address = probe.address();
    if (!address || typeof address === "string") throw new Error("test probe did not expose a port");
    await new Promise<void>((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
    const runtime = new AgentToolRuntime({
      profile: "development",
      workspaceRoot: root,
      canReadWorkspace: true,
      canWriteWorkspace: true,
      canExecuteCommands: true,
    }, ["startService"], { serviceStartupTimeoutMs: 10_000 });
    const started = await runtime.execute({
      tool: "startService",
      command: `node -e "require('node:http').createServer((_q,r)=>r.end('owned')).listen(${address.port},'127.0.0.1')"`,
      port: address.port,
    });
    expect(started).toMatchObject({ ok: true, running: true });

    await runtime.dispose();

    const listening = await new Promise<boolean>((resolve) => {
      const socket = createConnection({ host: "127.0.0.1", port: address.port });
      socket.once("connect", () => {
        socket.destroy();
        resolve(true);
      });
      socket.once("error", () => resolve(false));
    });
    expect(listening).toBe(false);
  }, 30_000);

  it("rejects browser file targets outside the current workspace", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "autoagent-tool-v2-browser-file-boundary-"));
    const outside = path.join(path.dirname(root), "outside-browser-proof.html");
    await writeFile(outside, "<title>outside</title>", "utf8");
    const runtime = new AgentToolRuntime({
      profile: "development",
      workspaceRoot: root,
      canReadWorkspace: true,
      canWriteWorkspace: false,
      canExecuteCommands: true,
    }, ["browser"]);

    await expect(runtime.execute({
      tool: "browser",
      browserArgs: ["--allow-file-access", "open", pathToFileURL(outside).href],
    })).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining("当前工作区之外"),
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
    expect(shell?.description).toContain("验证不同退出码时分别调用 shell");
    expect(shell?.description).toContain("只能依据 stdout、stderr 和 exitCode");
    if (process.platform === "win32") {
      expect(shell?.description).toContain("Windows cmd.exe");
      expect(shell?.description).toContain("不要使用 Bash heredoc");
      expect(shell?.description).toContain("setlocal EnableDelayedExpansion");
      expect(shell?.description).toContain("!VAR!");
      expect(startService?.description).toContain("Windows cmd.exe");
    } else {
      expect(shell?.description).toContain("POSIX shell");
      expect(startService?.description).toContain("POSIX shell");
    }
  });

  it("describes public browser navigation separately from managed local services", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "autoagent-tool-v2-browser-description-"));
    const runtime = new AgentToolRuntime({
      profile: "development",
      workspaceRoot: root,
      canReadWorkspace: true,
      canWriteWorkspace: false,
      canExecuteCommands: true,
      allowHostAccess: false,
    }, ["browser"]);

    const browser = runtime.definitions().find((item) => item.name === "browser");
    expect(browser?.description).toContain("公网 HTTP/HTTPS 页面可以直接打开");
    expect(browser?.description).toContain("本地页面只能打开当前工作区");
    await runtime.dispose();
    await rm(root, { recursive: true, force: true });
  });

  it("rejects Agent-supplied browser session ownership arguments", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "autoagent-tool-v2-browser-session-boundary-"));
    let commands = 0;
    const runtime = new AgentToolRuntime({
      profile: "development",
      workspaceRoot: root,
      canReadWorkspace: true,
      canWriteWorkspace: false,
      canExecuteCommands: true,
      allowHostAccess: false,
    }, ["browser"], {
      browserCommandRunner: async () => {
        commands += 1;
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    });

    await expect(runtime.execute({
      tool: "browser",
      browserArgs: ["--session", "agent-chosen", "snapshot", "-i"],
    })).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining("不能覆盖平台管理的浏览器会话参数"),
    });
    expect(commands).toBe(0);
    await runtime.dispose();
    await rm(root, { recursive: true, force: true });
  });
});
