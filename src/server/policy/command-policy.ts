import { HttpError } from "../errors.js";
import type { EffectivePolicy } from "./policy.js";

export function assertCommandAllowed(policy: EffectivePolicy, command: string): void {
  if (!policy.canExecuteCommands) {
    throw new HttpError(403, "Agent is not allowed to execute commands", "TOOL_DENIED");
  }
  assertNoHostProcessControl(command);
  if (policy.commandAllowlist && policy.commandAllowlist.length > 0) {
    const executable = command.trim().split(/\s+/)[0]?.toLowerCase();
    const allowed = policy.commandAllowlist.some((item) => item.toLowerCase() === executable);
    if (!allowed) throw new HttpError(403, `Command is not allowlisted: ${executable}`, "TOOL_DENIED");
  }
}

function assertNoHostProcessControl(command: string): void {
  const processControlPatterns = [
    /\btaskkill(?:\.exe)?\b/i,
    /\bstop-process\b/i,
    /\b(?:pkill|killall)\b/i,
    /\bwmic(?:\.exe)?\b[\s\S]*?\bprocess\b[\s\S]*?\bdelete\b/i,
  ];
  if (processControlPatterns.some((pattern) => pattern.test(command))) {
    throw new HttpError(
      403,
      "Host process termination is not allowed; managed services are stopped by the platform",
      "TOOL_DENIED",
    );
  }
}
