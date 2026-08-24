import { execFile } from "node:child_process";
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { AgentEngine } from "../dist/server/server/agent-engine/agent-engine.js";
import { AgentStore } from "../dist/server/server/agent-engine/agent-store.js";
import { TrialWorkspaceIsolationManager } from "../dist/server/server/evolution-adapters/trial-workspace-isolation.js";
import { MissionGoalResolutionPort } from "../dist/server/server/mission-process/mission-goal-resolution-port.js";
import { MissionProcessManager } from "../dist/server/server/mission-process/mission-process-manager.js";
import { MissionStore } from "../dist/server/server/mission-process/mission-store.js";
import { RuntimeHostStore } from "../dist/server/server/runtime/runtime-host-store.js";
import { TicketEngine } from "../dist/server/server/tickets/ticket-engine.js";
import { PlanPolicyStore } from "../dist/server/server/tickets/plan-policy-store.js";
import { TicketStore } from "../dist/server/server/tickets/ticket-store.js";

const execFileAsync = promisify(execFile);
const fixtureRoot = process.argv[2] ? path.resolve(process.argv[2]) : undefined;
if (!fixtureRoot) {
  throw new Error("Usage: npm run verify:autonomous-closure -- <retained-failed-workspace>");
}

const scratch = await mkdtemp(path.join(os.tmpdir(), "autoagent-autonomous-closure-"));
try {
  const settlement = await verifyRetainedSettlement(path.join(scratch, "settlement"));
  const git = await verifyGitBoundary(path.join(scratch, "git-boundary"));
  process.stdout.write(`${JSON.stringify({ ok: true, settlement, git }, null, 2)}\n`);
} finally {
  await rm(scratch, { recursive: true, force: true });
}

async function verifyRetainedSettlement(copyRoot) {
  await cp(fixtureRoot, copyRoot, { recursive: true, force: false, errorOnExist: true });
  const runtimeStore = new RuntimeHostStore(copyRoot);
  const tasks = await runtimeStore.list();
  assert(tasks.length === 1, `Expected one retained Runtime task, found ${tasks.length}`);
  const task = tasks[0];
  const missionStore = new MissionStore(copyRoot, task.missionId);
  const before = await missionStore.read();
  assert(before, "Retained Mission is missing");
  const resolving = before.links.filter((link) => link.status === "resolving" && link.lastProposalId);
  assert(resolving.length === 1, `Expected one resolving proposal, found ${resolving.length}`);
  const link = resolving[0];
  const partition = `agent:${link.agentId}`;
  const cursorBefore = before.cursors.find((item) => item.partition === partition)?.cursor.position;
  const fixedNow = () => new Date("2026-08-24T04:42:04.000Z");

  const first = createManager(copyRoot, task, before.record.teamBinding, fixedNow);
  const recovered = await first.manager.recover();
  const recoveredLink = recovered.links.find((item) => item.dispatchId === link.dispatchId);
  const recoveredGoal = await first.engines.get(link.agentId).getGoal(link.agentGoalId);
  const recoveredAgent = await new AgentStore(copyRoot, link.agentId).read();
  const decision = recoveredAgent.decisions.find((item) => item.proposalId === link.lastProposalId);
  const cursorAfter = recovered.cursors.find((item) => item.partition === partition)?.cursor.position;

  assert(recoveredLink?.status === "running", `Expected resolving link to return to running, got ${recoveredLink?.status}`);
  assert(recoveredGoal?.status === "active", `Expected Goal to return to active, got ${recoveredGoal?.status}`);
  assert(decision?.result.applied === true, "Expected a durable applied decision for the retained proposal");
  assert(decision.decisionId.startsWith("invalid_goal_decision_"), "Expected a correctable contract-rejection decision");
  assert(cursorAfter && cursorAfter !== cursorBefore, "Expected the Agent event cursor to advance");

  const second = createManager(copyRoot, task, recovered.record.teamBinding, fixedNow);
  const restarted = await second.manager.recover();
  const restartedLink = restarted.links.find((item) => item.dispatchId === link.dispatchId);
  const restartedGoal = await second.engines.get(link.agentId).getGoal(link.agentGoalId);
  const restartedAgent = await new AgentStore(copyRoot, link.agentId).read();
  assert(restartedLink?.status === "running", "Restart changed the recovered Mission link");
  assert(restartedGoal?.status === "active", "Restart changed the recovered Agent Goal");
  assert(restartedAgent.decisions.filter((item) => item.proposalId === link.lastProposalId).length === 1,
    "Restart duplicated the proposal decision");

  return {
    taskId: task.taskId,
    proposalId: link.lastProposalId,
    before: { link: link.status, cursor: cursorBefore },
    after: { link: recoveredLink.status, goal: recoveredGoal.status, decision: "correctable", cursor: cursorAfter },
    restart: { link: restartedLink.status, goal: restartedGoal.status, decisionCount: 1 },
  };
}

function createManager(root, task, team, now) {
  const policyStore = new PlanPolicyStore(root);
  const tickets = new TicketEngine(
    new TicketStore(root, task.taskId, task.runId),
    policyStore,
    { teamBindingIds: [team.teamBindingId], now },
  );
  const engines = new Map();
  for (const member of team.members) {
    const port = new MissionGoalResolutionPort(() => undefined, member.agentId, now, root);
    engines.set(member.agentId, new AgentEngine(new AgentStore(root, member.agentId), port, { now }));
  }
  return {
    engines,
    manager: new MissionProcessManager(
      new MissionStore(root, task.missionId),
      tickets,
      { get: (agentId) => engines.get(agentId) },
      team,
      "minimal-team-planner",
      now,
    ),
  };
}

async function verifyGitBoundary(root) {
  const source = path.join(root, "source");
  await mkdir(source, { recursive: true });
  await writeFile(path.join(source, "project.txt"), "frozen source\n", "utf8");
  await runGit(root, "init", "--quiet", "--initial-branch=main");
  const isolation = new TrialWorkspaceIsolationManager(source);
  const pair = (await isolation.prepare("closure-git-boundary", 1, [{ caseId: "target" }])).get("target");
  assert(pair, "Trial isolation did not prepare the target pair");
  const top = (await runGit(pair.candidate.rootPath, "rev-parse", "--show-toplevel")).stdout.trim();
  const clean = (await runGit(pair.candidate.rootPath, "status", "--short")).stdout;
  assert(path.resolve(top) === path.resolve(pair.candidate.rootPath), "Trial Git resolved to its parent source repository");
  assert(clean === "", `Trial Git baseline is not clean: ${clean}`);
  await writeFile(path.join(pair.candidate.rootPath, "project.txt"), "candidate change\n", "utf8");
  const changed = (await runGit(pair.candidate.rootPath, "status", "--short")).stdout.trim().split(/\r?\n/).filter(Boolean);
  assert(changed.length === 1 && changed[0].endsWith("project.txt"), `Trial Git reported unexpected changes: ${changed.join(", ")}`);
  return { sourceRepository: path.resolve(root), trialRepository: path.resolve(top), cleanBaseline: true, isolatedChangeCount: 1 };
}

function runGit(cwd, ...args) {
  return execFileAsync("git", args, { cwd, windowsHide: true, encoding: "utf8", maxBuffer: 10 * 1024 * 1024 });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
