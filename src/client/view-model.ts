import type { WorkspaceSnapshot } from "../shared/types";
import { displayText, roleLabel } from "../shared/labels";

export interface AgentNodeView {
  id: string;
  label: string;
  role: string;
  status: string;
  currentStep?: string;
  x: number;
  y: number;
  active: boolean;
}

const ROLE_ORDER = ["boss", "pm", "architect", "dev", "specialist", "qa"];
const ROLE_POSITIONS: Record<string, { x: number; y: number }> = {
  boss: { x: 50, y: 12 },
  pm: { x: 28, y: 36 },
  architect: { x: 72, y: 36 },
  dev: { x: 20, y: 68 },
  specialist: { x: 50, y: 68 },
  qa: { x: 80, y: 68 }
};

export function buildAgentNodes(snapshot?: WorkspaceSnapshot): AgentNodeView[] {
  if (!snapshot) return [];
  return snapshot.agents
    .slice()
    .sort((a, b) => ROLE_ORDER.indexOf(a.roleInWorkspace) - ROLE_ORDER.indexOf(b.roleInWorkspace))
    .map((agent, index) => {
      const base = ROLE_POSITIONS[agent.roleInWorkspace] ?? { x: 18 + index * 14, y: 52 };
      const specialistOffset = agent.roleInWorkspace === "specialist" ? Math.max(0, index - ROLE_ORDER.indexOf("specialist")) * 4 : 0;
      return {
        id: agent.id,
        label: roleLabel(agent.roleInWorkspace),
        role: agent.roleInWorkspace,
        status: agent.status,
        currentStep: displayText(agent.currentStep),
        x: Math.min(base.x + specialistOffset, 88),
        y: base.y,
        active: agent.status === "running" || Boolean(agent.currentStep)
      };
    });
}

export function taskControlMode(snapshot?: WorkspaceSnapshot): "empty" | "running" | "paused" | "terminal" {
  if (!snapshot?.activeTask) return "empty";
  if (snapshot.status === "paused") return "paused";
  if (snapshot.status === "completed" || snapshot.status === "failed" || snapshot.status === "interrupted") return "terminal";
  return "running";
}
