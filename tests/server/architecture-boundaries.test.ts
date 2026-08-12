import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const serverRoot = resolve(process.cwd(), "src/server");

function sourceFiles(relativeDirectory: string): string[] {
  const root = resolve(serverRoot, relativeDirectory);
  if (!existsSync(root)) return [];

  const files: string[] = [];
  const visit = (path: string): void => {
    for (const name of readdirSync(path)) {
      const child = resolve(path, name);
      if (statSync(child).isDirectory()) {
        visit(child);
      } else if (name.endsWith(".ts") || name.endsWith(".tsx")) {
        files.push(child);
      }
    }
  };
  visit(root);
  return files;
}

function violations(relativeDirectory: string, forbidden: RegExp[]): string[] {
  return sourceFiles(relativeDirectory).flatMap((file) => {
    const source = readFileSync(file, "utf8");
    return forbidden
      .filter((pattern) => pattern.test(source))
      .map((pattern) => `${file.replace(`${serverRoot}\\`, "")}: ${pattern.source}`);
  });
}

function violationsInFiles(relativeFiles: string[], forbidden: RegExp[]): string[] {
  return relativeFiles.flatMap((relativeFile) => {
    const file = resolve(serverRoot, relativeFile);
    const source = readFileSync(file, "utf8");
    return forbidden
      .filter((pattern) => pattern.test(source))
      .map((pattern) => `${relativeFile}: ${pattern.source}`);
  });
}

describe("runtime architecture boundaries", () => {
  it("keeps Agent Engine independent from Ticket, Mission, and legacy routing types", () => {
    expect(violations("agent-engine", [
      /from\s+["'][^"']*\/tickets(?:\/|["'])/,
      /from\s+["'][^"']*\/mission(?:\/|["'])/,
      /\b(?:Assignment|MissionPhase|AgentRole)\b/,
      /from\s+["'][^"']*shared\/contracts\/(?:ticket-engine|mission-control)/
    ])).toEqual([]);
  });

  it("keeps Ticket Engine independent from agents, providers, context, tools, and Mission", () => {
    expect(violations("tickets", [
      /from\s+["'][^"']*\/(?:agents|providers|context|tools)(?:\/|["'])/,
      /\b(?:SessionStore|AgentRole)\b/,
      /from\s+["'][^"']*shared\/contracts\/(?:agent-engine|mission-control)/,
      /\b(?:boss-intake-v1|plan-intent-v1|delivery-v1|qa-report-v1|acceptance-v1)\b/
    ])).toEqual([]);
  });

  it("keeps Mission Process free of phase routing and business classification rules", () => {
    expect(violationsInFiles([
      "mission-process/mission-process-manager.ts",
      "mission-process/ticket-agent-adapter.ts",
    ], [
      /\bnextPhase\b/,
      /\bphaseAfter\w*\b/,
      /\brole\s*===/,
      /\bboss_acceptance\b/,
      /\bhuman_action\b/,
      /\b(?:qa-report-v1|acceptance-v1)\b/,
      /\.(?:match|test|search)\s*\(/,
      /new\s+RegExp\s*\(/,
      /from\s+["'][^"']*\/agent-engine\/agent-engine/,
      /selectMemberOrPlanner/,
    ])).toEqual([]);
  });

  it("keeps runtime control paths free of role-name routing and product capability injection", () => {
    expect(violationsInFiles([
      "runtime/runtime-host-registry.ts",
      "product/team-binding.ts",
    ], [
      /roleInWorkspace\s*===/,
      /PRODUCT_CAPABILITIES/,
      /selectMemberOrPlanner/,
    ])).toEqual([]);
  });
});
