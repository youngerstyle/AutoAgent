import type { Assignment, Workspace, WorkspaceAgent } from "../../shared/types.js";
import type { AgentSession } from "../storage/session-store.js";
import { profileForRole } from "./roster.js";

export function buildAgentPrompt(input: {
  workspace: Workspace;
  agent: WorkspaceAgent;
  assignment: Assignment;
  goal: string;
  context?: Record<string, unknown>;
  session?: AgentSession;
}): string {
  const profile = profileForRole(input.agent.roleInWorkspace);
  const recent = input.session?.messages.slice(-6).map((message) => `${message.role}: ${message.content}`).join("\n") ?? "";
  return [
    `You are ${profile.name}, role=${profile.role}.`,
    `Workspace: ${input.workspace.name} at ${input.workspace.rootPath}.`,
    `Goal: ${input.goal}`,
    `Assignment: ${input.assignment.type}`,
    `Brief: ${input.assignment.brief}`,
    `Expected artifact: ${input.assignment.expectedArtifact}`,
    `Capabilities: ${profile.capabilities.join(", ")}`,
    recent ? `Recent session:\n${recent}` : "Recent session: none",
    input.context ? `Context: ${JSON.stringify(input.context)}` : "Context: {}",
    "Return concise structured output. Tool intents may use writeFile, readFile, listFiles, or shell."
  ].join("\n");
}
