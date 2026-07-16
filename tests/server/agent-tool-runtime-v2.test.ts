import { mkdtemp, readFile } from "node:fs/promises";
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
