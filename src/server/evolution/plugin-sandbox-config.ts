import { existsSync } from "node:fs";
import path from "node:path";

export const PLUGIN_SANDBOX_PROGRAM_ENV = "AUTOAGENT_EVOLUTION_PLUGIN_SANDBOX_PROGRAM";

export function configuredPluginSandboxProgram(environment: NodeJS.ProcessEnv = process.env): string | undefined {
  const value = environment[PLUGIN_SANDBOX_PROGRAM_ENV]?.trim();
  if (!value || !path.isAbsolute(value) || !existsSync(value)) return undefined;
  return path.resolve(value);
}
