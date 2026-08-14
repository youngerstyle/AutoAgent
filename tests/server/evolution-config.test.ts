import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/server/config.js";

describe("Evolution worker configuration", () => {
  it("accepts only an existing server-owned JavaScript evaluator program", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "autoagent-evolution-config-"));
    const program = path.join(root, "evaluator.mjs");
    await writeFile(program, "", "utf8");
    expect(loadConfig({ AUTOAGENT_HOME: root, AUTOAGENT_EVOLUTION_EVALUATOR_PROGRAM: program })).toMatchObject({
      evolutionEvaluatorProgramPath: program,
      evolutionWorkerIntervalMs: 30_000,
    });
    expect(() => loadConfig({ AUTOAGENT_HOME: root, AUTOAGENT_EVOLUTION_EVALUATOR_PROGRAM: path.join(root, "missing.mjs") }))
      .toThrow("Invalid AUTOAGENT_EVOLUTION_EVALUATOR_PROGRAM");
    const textProgram = path.join(root, "evaluator.txt");
    await writeFile(textProgram, "", "utf8");
    expect(() => loadConfig({ AUTOAGENT_HOME: root, AUTOAGENT_EVOLUTION_EVALUATOR_PROGRAM: textProgram }))
      .toThrow("Invalid AUTOAGENT_EVOLUTION_EVALUATOR_PROGRAM");
  });

  it("rejects an unsafe busy-loop interval", () => {
    expect(() => loadConfig({ AUTOAGENT_EVOLUTION_WORKER_INTERVAL_MS: "999" }))
      .toThrow("Invalid AUTOAGENT_EVOLUTION_WORKER_INTERVAL_MS");
  });

  it("requires an existing absolute operator-owned Plugin sandbox launcher", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "autoagent-plugin-sandbox-config-"));
    const launcher = path.join(root, "sandbox-launcher.mjs");
    await writeFile(launcher, "", "utf8");
    expect(loadConfig({ AUTOAGENT_HOME: root, AUTOAGENT_EVOLUTION_PLUGIN_SANDBOX_PROGRAM: launcher }))
      .toMatchObject({ evolutionPluginSandboxProgramPath: launcher });
    expect(() => loadConfig({ AUTOAGENT_HOME: root, AUTOAGENT_EVOLUTION_PLUGIN_SANDBOX_PROGRAM: "relative-launcher" }))
      .toThrow("Invalid AUTOAGENT_EVOLUTION_PLUGIN_SANDBOX_PROGRAM");
    expect(() => loadConfig({ AUTOAGENT_HOME: root, AUTOAGENT_EVOLUTION_PLUGIN_SANDBOX_PROGRAM: path.join(root, "missing") }))
      .toThrow("Invalid AUTOAGENT_EVOLUTION_PLUGIN_SANDBOX_PROGRAM");
  });
});
