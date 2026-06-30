import { HttpError } from "../errors.js";
import type { EffectivePolicy } from "./policy.js";

export function assertCommandAllowed(policy: EffectivePolicy, command: string): void {
  if (!policy.canExecuteCommands) {
    throw new HttpError(403, "Agent is not allowed to execute commands", "TOOL_DENIED");
  }
  if (policy.commandAllowlist && policy.commandAllowlist.length > 0) {
    const executable = command.trim().split(/\s+/)[0]?.toLowerCase();
    const allowed = policy.commandAllowlist.some((item) => item.toLowerCase() === executable);
    if (!allowed) throw new HttpError(403, `Command is not allowlisted: ${executable}`, "TOOL_DENIED");
  }
}
