# AutoAgent Production Platform P0 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build AutoAgent P0 into a production-ready local autonomous team platform with Agent Studio, Workspace Team, Runtime Ops, provider readiness, and auditable runs.

**Architecture:** Keep the current working Mission Control loop alive while replacing the product model underneath it. Introduce reusable `AgentDefinition` records globally, bind them into workspaces as `WorkspaceAgent` team instances, feed identity/soul/loop/capabilities into runtime prompts, and expose history/audit surfaces from durable backend facts.

**Tech Stack:** TypeScript, Express, React, Vite, Vitest, Supertest, SSE, JSON/JSONL filesystem storage, Playwright for browser QA.

---

## Source Spec

Implement from:

- `docs/superpowers/specs/2026-06-30-autoagent-production-platform-design.md`

Keep these P0 product promises true throughout implementation:

- A reusable Agent is not the same as a workspace team member.
- Identity, soul, loop definition, capabilities, and runtime defaults are first-class Agent Studio concepts.
- Workspace overrides do not mutate reusable agent definitions.
- Runtime assignments record the exact agent definition, agent version, loop id, loop version, provider, and model used.
- The current runnable mock team loop must keep passing after each slice.

## Scope Check

The spec covers Agent Studio, Workspace Team, and Runtime Ops, but these are sequentially dependent layers rather than independent products:

1. Agent Studio creates reusable definitions.
2. Workspace Team binds those definitions into projects.
3. Runtime Ops executes and audits those bindings.

Use one P0 plan with delivery slices. Do not split into separate implementation plans unless the implementation is paused between slices.

## File Structure

### Shared Types

- Modify: `src/shared/types.ts`
  - Add `AgentDefinition`, `AgentIdentity`, `AgentSoul`, `LoopDefinition`, `CapabilitySet`, `AgentRuntimeDefaults`, `AgentLifecycle`, `WorkspaceAgentMemory`, and expanded `AssignmentRun` fields.
  - Keep existing exported names compatible while implementation migrates.

### Server Agent Domain

- Create: `src/server/agents/agent-definitions.ts`
  - Own system agent definitions, defaults, definition validation, and conversion from current core roles.
- Create: `src/server/storage/agent-definition-store.ts`
  - Persist global reusable agent definitions under `AUTOAGENT_HOME/agents`.
- Create: `src/server/storage/team-store.ts`
  - Persist workspace team bindings under workspace-local storage.
- Modify: `src/server/agents/roster.ts`
  - Replace implicit profile-only seeding with definition-backed team seeding.
- Modify: `src/server/agents/recruitment.ts`
  - Create recruited specialists as real `AgentDefinition` records and bind them to the workspace team.

### Storage Paths

- Modify: `src/server/storage/paths.ts`
  - Add global agent definition paths.
  - Add workspace team paths.
  - Keep current `.autoagent/agents` paths available during migration if needed.

### Server Routes

- Create: `src/server/routes/agent-definitions.ts`
  - API for Agent Studio.
- Create or replace: `src/server/routes/team.ts`
  - API for Workspace Team.
- Modify: `src/server/routes/agents.ts`
  - Either deprecate to a thin compatibility wrapper or rename behavior to team routes.
- Modify: `src/server/routes/providers.ts`
  - Add provider connection test route.
- Modify: `src/server/routes/tasks.ts`
  - Add task/run history and audit endpoints if not placed in a separate history route.
- Create: `src/server/routes/history.ts`
  - Prefer this if history endpoints become more than two route handlers.
- Modify: `src/server/app.ts`
  - Mount new routes.

### Runtime

- Modify: `src/server/agents/prompts.ts`
  - Build prompts from assignment contract plus identity, soul, loop definition, capabilities, memory, and session.
- Modify: `src/server/agents/agent-runtime.ts`
  - Load effective agent definition and workspace binding.
  - Emit assignment metadata with definition id/version and loop id/version.
- Modify: `src/server/mission/mission-control.ts`
  - Route using workspace team members and capabilities.
  - Preserve current fixed team phases for P0.
- Modify: `src/server/storage/state-projector.ts`
  - Project new agent/team/runtime metadata for UI.
- Modify: `src/server/storage/session-store.ts`
  - Keep sessions workspace-agent scoped.

### Client

Refactor `src/client/App.tsx` only as much as needed. Prefer creating focused components instead of growing it further.

- Modify: `src/client/api.ts`
  - Add Agent Studio, Team, Provider test, and History API helpers.
- Create: `src/client/components/RunConsole.tsx`
  - Current task console, canvas, and events.
- Create: `src/client/components/AgentStudio.tsx`
  - Reusable agent definition list/editor.
- Create: `src/client/components/WorkspaceTeam.tsx`
  - Workspace team bindings and overrides.
- Create: `src/client/components/ProviderSettings.tsx`
  - Existing provider form plus connection test.
- Create: `src/client/components/RuntimeHistory.tsx`
  - Task/run/assignment/artifact/failure audit.
- Create: `src/client/components/shared.tsx`
  - Small shared controls only if duplication appears.
- Modify: `src/client/view-model.ts`
  - Add projection helpers for new runtime/team metadata.
- Modify: `src/client/styles.css`
  - Add restrained, operational layout for the new product surfaces.

### Tests

- Create: `tests/server/agent-definition-store.test.ts`
- Create: `tests/server/team-store.test.ts`
- Create: `tests/server/agent-definitions-route.test.ts`
- Create: `tests/server/team-route.test.ts`
- Modify: `tests/server/agents-route.test.ts`
- Modify: `tests/server/agent-runtime.test.ts`
- Modify: `tests/server/mission-control.test.ts`
- Modify: `tests/server/provider-registry.test.ts`
- Create: `tests/server/history-route.test.ts`
- Modify: `tests/e2e/mock-loop.test.ts`
- Create: `tests/client/agent-studio-view-model.test.ts`
- Create: `tests/client/team-view-model.test.ts`

### Docs

- Modify: `README.md`
  - Update concepts and startup flow after implementation.
- Keep: `docs/superpowers/specs/2026-06-30-autoagent-production-platform-design.md`
  - Only update if implementation reveals a real design correction.

---

## Task 1: Agent Domain Model

**Files:**
- Modify: `src/shared/types.ts`
- Create: `src/server/agents/agent-definitions.ts`
- Test: `tests/server/agent-definition-store.test.ts` later uses these types, but this task can start with typecheck-only verification.

- [ ] **Step 1: Add shared domain types**

Add types matching the spec:

```ts
export interface AgentDefinition {
  id: string;
  identity: AgentIdentity;
  soul: AgentSoul;
  loop: LoopDefinition;
  capabilities: CapabilitySet;
  runtimeDefaults: AgentRuntimeDefaults;
  lifecycle: AgentLifecycle;
  createdAt: string;
  updatedAt: string;
}
```

Also add `AgentIdentity`, `AgentSoul`, `LoopDefinition`, `CapabilitySet`, `AgentRuntimeDefaults`, `AgentLifecycle`, and `WorkspaceAgentMemory`.

- [ ] **Step 2: Expand WorkspaceAgent without breaking current fields**

Add optional fields first:

```ts
agentDefinitionId?: string;
agentVersion?: string;
instanceName?: string;
runtimeOverride?: Partial<AgentRuntimeDefaults>;
workspaceMemory?: WorkspaceAgentMemory;
joinedAt?: string;
```

Keep `profileId`, `provider`, and `model` until later tasks migrate existing behavior.

- [ ] **Step 3: Add system agent definitions helper**

Create `src/server/agents/agent-definitions.ts` with:

```ts
export const SYSTEM_AGENT_DEFINITIONS: AgentDefinition[] = [...]
export function systemAgentForRole(role: AgentRole): AgentDefinition
export function agentDefinitionMetadata(definition: AgentDefinition): Pick<AgentDefinition, "id" | "identity" | "capabilities">
```

Use conservative default soul and loop text for Boss, PM, Architect, Dev, and QA.

- [ ] **Step 4: Run typecheck**

Run: `npm.cmd run typecheck`

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add src/shared/types.ts src/server/agents/agent-definitions.ts
git commit -m "feat: define agent domain model"
```

---

## Task 2: Agent Definition Storage

**Files:**
- Modify: `src/server/storage/paths.ts`
- Create: `src/server/storage/agent-definition-store.ts`
- Test: `tests/server/agent-definition-store.test.ts`

- [ ] **Step 1: Write failing store tests**

Test cases:

```ts
it("seeds system agent definitions idempotently")
it("creates, reads, updates, duplicates, and versions user agent definitions")
it("does not persist provider secrets in agent definitions")
```

Run: `npm.cmd run test:run -- tests/server/agent-definition-store.test.ts`

Expected: FAIL because store does not exist.

- [ ] **Step 2: Add storage paths**

Add:

```ts
export function globalAgentDefinitionsDir(home: string): string
export function globalAgentDefinitionDir(home: string, agentDefinitionId: string): string
export function globalAgentDefinitionFile(home: string, agentDefinitionId: string): string
export function globalAgentDefinitionVersionFile(home: string, agentDefinitionId: string, version: string): string
```

- [ ] **Step 3: Implement AgentDefinitionStore**

Required methods:

```ts
list(): Promise<AgentDefinition[]>
get(id: string): Promise<AgentDefinition>
seedSystemAgents(): Promise<AgentDefinition[]>
create(input: AgentDefinitionInput): Promise<AgentDefinition>
update(id: string, patch: AgentDefinitionPatch): Promise<AgentDefinition>
duplicate(id: string): Promise<AgentDefinition>
version(id: string, patch: AgentDefinitionPatch): Promise<AgentDefinition>
```

Use `writeJson` and `readJson`. Keep generated ids stable enough for system agents, for example `ad_boss`.

- [ ] **Step 4: Run store tests**

Run: `npm.cmd run test:run -- tests/server/agent-definition-store.test.ts`

Expected: PASS.

- [ ] **Step 5: Run full server tests**

Run: `npm.cmd run test:run -- tests/server`

Expected: PASS.

- [ ] **Step 6: Commit**

```powershell
git add src/server/storage/paths.ts src/server/storage/agent-definition-store.ts tests/server/agent-definition-store.test.ts
git commit -m "feat: persist agent definitions"
```

---

## Task 3: Workspace Team Store

**Files:**
- Modify: `src/server/storage/paths.ts`
- Create: `src/server/storage/team-store.ts`
- Modify: `src/server/agents/roster.ts`
- Test: `tests/server/team-store.test.ts`

- [ ] **Step 1: Write failing team store tests**

Test cases:

```ts
it("binds a reusable agent definition into a workspace team")
it("keeps the same agent definition isolated across two workspaces")
it("updates provider model and policy overrides without mutating the agent definition")
it("seeds Boss PM Architect Dev QA from system definitions")
```

Run: `npm.cmd run test:run -- tests/server/team-store.test.ts`

Expected: FAIL because team store does not exist.

- [ ] **Step 2: Add team storage paths**

Add:

```ts
export function workspaceTeamDir(workspaceRoot: string, workspaceAgentId?: string): string
export function workspaceTeamAgentFile(workspaceRoot: string, workspaceAgentId: string): string
export function workspaceTeamAgentSessionsDir(workspaceRoot: string, workspaceAgentId: string): string
```

Decision: keep existing `.autoagent/agents` as the physical path for this slice if migration risk is high, but expose it through team-named path helpers. Do not force a storage migration until tests cover it.

- [ ] **Step 3: Implement TeamStore**

Required methods:

```ts
list(workspace: Workspace): Promise<WorkspaceAgent[]>
bind(workspace: Workspace, definition: AgentDefinition, input?: TeamBindInput): Promise<WorkspaceAgent>
update(workspace: Workspace, workspaceAgentId: string, patch: TeamAgentPatch): Promise<WorkspaceAgent>
removeOrDisable(workspace: Workspace, workspaceAgentId: string): Promise<WorkspaceAgent>
seedCoreTeam(workspace: Workspace): Promise<WorkspaceAgent[]>
```

- [ ] **Step 4: Update roster compatibility**

Modify `ensureCoreTeam`, `listWorkspaceAgents`, `ensureWorkspaceAgent`, `updateWorkspaceAgent` to delegate to `TeamStore` or share implementation without changing public callers yet.

- [ ] **Step 5: Run team tests**

Run: `npm.cmd run test:run -- tests/server/team-store.test.ts tests/server/agents-route.test.ts`

Expected: PASS.

- [ ] **Step 6: Run E2E**

Run: `npm.cmd run test:e2e`

Expected: PASS; fixed mock team still runs.

- [ ] **Step 7: Commit**

```powershell
git add src/server/storage/paths.ts src/server/storage/team-store.ts src/server/agents/roster.ts tests/server/team-store.test.ts
git commit -m "feat: bind agent definitions into workspace teams"
```

---

## Task 4: Agent Studio API

**Files:**
- Create: `src/server/routes/agent-definitions.ts`
- Modify: `src/server/app.ts`
- Modify: `src/client/api.ts`
- Test: `tests/server/agent-definitions-route.test.ts`

- [ ] **Step 1: Write failing route tests**

Test:

```ts
it("lists seeded system agent definitions")
it("creates and updates a user agent definition")
it("duplicates and versions an agent definition")
it("rejects provider secrets inside agent definition payloads")
```

Run: `npm.cmd run test:run -- tests/server/agent-definitions-route.test.ts`

Expected: FAIL.

- [ ] **Step 2: Implement routes**

Routes:

```text
GET /api/agent-definitions
POST /api/agent-definitions
GET /api/agent-definitions/:agentDefinitionId
PATCH /api/agent-definitions/:agentDefinitionId
POST /api/agent-definitions/:agentDefinitionId/duplicate
POST /api/agent-definitions/:agentDefinitionId/version
```

- [ ] **Step 3: Mount routes**

Modify `src/server/app.ts`:

```ts
app.use("/api/agent-definitions", createAgentDefinitionRouter(agentDefinitionStore));
```

Create and share the store instance with TeamStore in later tasks.

- [ ] **Step 4: Add client API helpers**

Add to `src/client/api.ts`:

```ts
listAgentDefinitions()
createAgentDefinition()
updateAgentDefinition()
duplicateAgentDefinition()
versionAgentDefinition()
```

- [ ] **Step 5: Run route tests**

Run: `npm.cmd run test:run -- tests/server/agent-definitions-route.test.ts`

Expected: PASS.

- [ ] **Step 6: Run typecheck**

Run: `npm.cmd run typecheck`

Expected: PASS.

- [ ] **Step 7: Commit**

```powershell
git add src/server/routes/agent-definitions.ts src/server/app.ts src/client/api.ts tests/server/agent-definitions-route.test.ts
git commit -m "feat: add agent studio api"
```

---

## Task 5: Workspace Team API

**Files:**
- Create: `src/server/routes/team.ts`
- Modify: `src/server/routes/agents.ts`
- Modify: `src/server/app.ts`
- Modify: `src/client/api.ts`
- Test: `tests/server/team-route.test.ts`
- Modify: `tests/server/agents-route.test.ts`

- [ ] **Step 1: Write failing team route tests**

Test:

```ts
it("lists seeded workspace team members with source agent definitions")
it("adds an existing agent definition to a workspace")
it("updates runtime and policy overrides")
it("can disable a workspace team member")
```

Run: `npm.cmd run test:run -- tests/server/team-route.test.ts`

Expected: FAIL.

- [ ] **Step 2: Implement team routes**

Routes:

```text
GET /api/workspaces/:workspaceId/team
POST /api/workspaces/:workspaceId/team
PATCH /api/workspaces/:workspaceId/team/:workspaceAgentId
POST /api/workspaces/:workspaceId/team/:workspaceAgentId/disable
```

- [ ] **Step 3: Keep compatibility route temporarily**

Make `/api/workspaces/:workspaceId/agents` call the team route behavior or return the same enriched team payload. Do this only as an implementation bridge; the UI should move to `team`.

- [ ] **Step 4: Add client API helpers**

Add:

```ts
listWorkspaceTeam()
addWorkspaceTeamAgent()
updateWorkspaceTeamAgent()
disableWorkspaceTeamAgent()
```

- [ ] **Step 5: Run route tests**

Run: `npm.cmd run test:run -- tests/server/team-route.test.ts tests/server/agents-route.test.ts`

Expected: PASS.

- [ ] **Step 6: Run E2E**

Run: `npm.cmd run test:e2e`

Expected: PASS.

- [ ] **Step 7: Commit**

```powershell
git add src/server/routes/team.ts src/server/routes/agents.ts src/server/app.ts src/client/api.ts tests/server/team-route.test.ts tests/server/agents-route.test.ts
git commit -m "feat: add workspace team api"
```

---

## Task 6: Runtime Uses Agent Soul and Loop

**Files:**
- Modify: `src/server/agents/prompts.ts`
- Modify: `src/server/agents/agent-runtime.ts`
- Modify: `src/server/mission/mission-control.ts`
- Modify: `src/server/storage/state-projector.ts`
- Modify: `tests/server/agent-runtime.test.ts`
- Modify: `tests/server/mission-control.test.ts`

- [ ] **Step 1: Write failing runtime tests**

Add tests:

```ts
it("includes agent identity soul loop and capabilities in the provider prompt")
it("records agent definition id version and loop version in assignment events")
it("keeps session history scoped to workspace agent after definition-backed execution")
```

Run: `npm.cmd run test:run -- tests/server/agent-runtime.test.ts`

Expected: FAIL.

- [ ] **Step 2: Update prompt builder input**

`buildAgentPrompt` should accept:

```ts
agentDefinition: AgentDefinition;
workspaceAgent: WorkspaceAgent;
assignment: Assignment;
session: AgentSession;
```

Prompt sections:

```text
Identity
Soul
Loop Definition
Capabilities
Workspace
Assignment Contract
Recent Session
Output Contract
```

- [ ] **Step 3: Update runtime metadata emission**

Emit `assignment.created` and `provider.started` payloads with:

```ts
agentDefinitionId
agentVersion
loopDefinitionId
loopVersion
workspaceAgentId
provider
model
```

- [ ] **Step 4: Preserve current mock provider behavior**

Mock provider can still branch by role and assignment type. Do not require real LLM behavior for tests.

- [ ] **Step 5: Run runtime and mission tests**

Run:

```powershell
npm.cmd run test:run -- tests/server/agent-runtime.test.ts tests/server/mission-control.test.ts tests/server/state-projector.test.ts
```

Expected: PASS.

- [ ] **Step 6: Run E2E**

Run: `npm.cmd run test:e2e`

Expected: PASS.

- [ ] **Step 7: Commit**

```powershell
git add src/server/agents/prompts.ts src/server/agents/agent-runtime.ts src/server/mission/mission-control.ts src/server/storage/state-projector.ts tests/server/agent-runtime.test.ts tests/server/mission-control.test.ts
git commit -m "feat: run agents with soul and loop definitions"
```

---

## Task 7: Recruitment Creates Real Agents

**Files:**
- Modify: `src/server/agents/recruitment.ts`
- Modify: `src/server/mission/mission-control.ts`
- Modify: `tests/server/mission-control.test.ts`
- Modify: `tests/e2e/mock-loop.test.ts`

- [ ] **Step 1: Write failing recruitment tests**

Test:

```ts
it("creates a recruited specialist as an AgentDefinition")
it("binds the recruited specialist into the current workspace team")
it("records recruitment definition and workspace agent ids in events")
```

Run: `npm.cmd run test:run -- tests/server/mission-control.test.ts`

Expected: FAIL.

- [ ] **Step 2: Update recruitment flow**

When Boss approves a capability gap:

1. Create `AgentDefinition` with origin `recruited`.
2. Fill conservative soul and loop defaults from capability gap.
3. Bind it into workspace team.
4. Emit `agent.created` and `agent.joined_workspace` with both ids.

- [ ] **Step 3: Run mission and E2E tests**

Run:

```powershell
npm.cmd run test:run -- tests/server/mission-control.test.ts
npm.cmd run test:e2e
```

Expected: PASS.

- [ ] **Step 4: Commit**

```powershell
git add src/server/agents/recruitment.ts src/server/mission/mission-control.ts tests/server/mission-control.test.ts tests/e2e/mock-loop.test.ts
git commit -m "feat: recruit specialists as reusable agents"
```

---

## Task 8: Agent Studio UI

**Files:**
- Modify: `src/client/App.tsx`
- Modify: `src/client/api.ts`
- Create: `src/client/components/AgentStudio.tsx`
- Create: `src/client/components/shared.tsx` if needed
- Modify: `src/client/styles.css`
- Test: `tests/client/agent-studio-view-model.test.ts`

- [ ] **Step 1: Write UI view-model tests**

Keep tests focused on data mapping, not DOM rendering:

```ts
it("shows identity soul loop capabilities and defaults for an agent definition")
it("marks system agents as reusable definitions")
it("distinguishes editable user agents from system agents")
```

Run: `npm.cmd run test:run -- tests/client/agent-studio-view-model.test.ts`

Expected: FAIL.

- [ ] **Step 2: Add Agent Studio navigation**

Top nav should include:

```text
运行台
Agent Studio
团队
Provider
历史
```

- [ ] **Step 3: Implement AgentStudio component**

P0 fields:

- Identity: display name, role, summary, origin, version.
- Soul: mission, principles, personality, work style, decision rules, boundaries, communication style.
- Loop: input contract, planning, execution, reflection, handoff rules, stop conditions, failure policy.
- Capabilities: domains, skills, languages, frameworks, tools, limitations.
- Runtime defaults: provider, model, context strategy, policy defaults.

Use textareas for multi-line structured fields in P0.

- [ ] **Step 4: Wire create/update/duplicate/version actions**

Use API helpers from Task 4.

- [ ] **Step 5: Run client tests and typecheck**

Run:

```powershell
npm.cmd run test:run -- tests/client/agent-studio-view-model.test.ts
npm.cmd run typecheck
```

Expected: PASS.

- [ ] **Step 6: Browser QA**

Start or restart the app, then inspect with Playwright/Chrome:

- Agent Studio loads.
- System agents display.
- Soul and Loop sections are visible.
- No text overlaps at 1440x900.
- No console errors.

- [ ] **Step 7: Commit**

```powershell
git add src/client/App.tsx src/client/api.ts src/client/components/AgentStudio.tsx src/client/components/shared.tsx src/client/styles.css tests/client/agent-studio-view-model.test.ts
git commit -m "feat: add agent studio ui"
```

---

## Task 9: Workspace Team UI

**Files:**
- Modify: `src/client/App.tsx`
- Create: `src/client/components/WorkspaceTeam.tsx`
- Modify: `src/client/api.ts`
- Modify: `src/client/styles.css`
- Test: `tests/client/team-view-model.test.ts`

- [ ] **Step 1: Write team view-model tests**

Test:

```ts
it("shows workspace team bindings separately from source definitions")
it("shows effective provider model and policy override")
it("can prepare an add-agent payload from an existing definition")
```

Run: `npm.cmd run test:run -- tests/client/team-view-model.test.ts`

Expected: FAIL.

- [ ] **Step 2: Rename current Agent 配置 surface**

Change current `Agent 配置` nav/page to `团队`.

Keep existing provider/model/policy override behavior, but label it as workspace-specific.

- [ ] **Step 3: Implement add existing agent flow**

P0 can use a select menu of existing agent definitions and an `加入团队` button.

- [ ] **Step 4: Show effective config**

Each team card shows:

- source agent name/version
- workspace role
- provider/model effective value
- policy override
- session/memory status placeholder
- current runtime status

- [ ] **Step 5: Run tests**

Run:

```powershell
npm.cmd run test:run -- tests/client/team-view-model.test.ts tests/client/view-model.test.ts
npm.cmd run typecheck
```

Expected: PASS.

- [ ] **Step 6: Browser QA**

Verify:

- Team page no longer pretends to edit Agent soul.
- Add-agent flow works.
- Existing workspace team still displays Boss/PM/Architect/Dev/QA.
- No console errors.

- [ ] **Step 7: Commit**

```powershell
git add src/client/App.tsx src/client/components/WorkspaceTeam.tsx src/client/api.ts src/client/styles.css tests/client/team-view-model.test.ts
git commit -m "feat: add workspace team ui"
```

---

## Task 10: Provider Connection Test and Safety Surface

**Files:**
- Modify: `src/server/providers/provider-registry.ts`
- Modify: `src/server/routes/providers.ts`
- Modify: `src/server/policy/policy.ts`
- Create: `src/server/routes/policy.ts` if needed
- Modify: `src/server/app.ts`
- Modify: `src/client/components/ProviderSettings.tsx`
- Modify: `src/client/components/WorkspaceTeam.tsx`
- Modify: `src/client/api.ts`
- Modify: `tests/server/provider-registry.test.ts`
- Create: `tests/server/policy-route.test.ts` if route is added

- [ ] **Step 1: Write failing provider tests**

Test:

```ts
it("reports missing key from provider test without leaking secrets")
it("reports configured mock provider as testable")
it("normalizes terminal provider test failures")
```

Run: `npm.cmd run test:run -- tests/server/provider-registry.test.ts`

Expected: FAIL.

- [ ] **Step 2: Add provider test method**

Add:

```ts
testProvider(provider: Exclude<ProviderName, "mock">): Promise<ProviderTestResult>
```

Do not run an expensive task. Use a minimal model call where possible; if SDK support is awkward, validate credentials/config and document limitations. Mock tests should not require network.

- [ ] **Step 3: Add route**

Route:

```text
POST /api/providers/:provider/test
```

- [ ] **Step 4: Expose effective policy**

Either include effective policy in team API responses or add:

```text
GET /api/workspaces/:workspaceId/team/:workspaceAgentId/policy
```

P0 preference: include effective policy in team responses to avoid extra UI fetches.

- [ ] **Step 5: Update UI**

Provider page:

- Add `测试连接`.
- Show success/failure state.
- Show redacted key state.

Team page:

- Show effective permissions.
- Highlight command execution and host access.
- Show development vs production explanation near policy controls.

- [ ] **Step 6: Run tests and browser QA**

Run:

```powershell
npm.cmd run test:run -- tests/server/provider-registry.test.ts
npm.cmd run typecheck
```

Browser QA:

- Provider test button visible.
- Missing key shows readable error.
- Dangerous permissions visually obvious.

- [ ] **Step 7: Commit**

```powershell
git add src/server/providers/provider-registry.ts src/server/routes/providers.ts src/server/policy src/server/app.ts src/client/components/ProviderSettings.tsx src/client/components/WorkspaceTeam.tsx src/client/api.ts tests/server/provider-registry.test.ts
git commit -m "feat: add provider tests and policy visibility"
```

---

## Task 11: Runtime Ops History

**Files:**
- Create: `src/server/storage/history-projector.ts`
- Create: `src/server/routes/history.ts`
- Modify: `src/server/app.ts`
- Create: `src/client/components/RuntimeHistory.tsx`
- Modify: `src/client/App.tsx`
- Modify: `src/client/api.ts`
- Modify: `src/client/styles.css`
- Test: `tests/server/history-route.test.ts`

- [ ] **Step 1: Write failing history route tests**

Test:

```ts
it("lists task runs for a workspace")
it("returns assignment chain provider events tool calls artifacts QA and acceptance")
it("categorizes failed runs by provider policy tool qa user interruption or unknown")
it("reconstructs history after app restart from events and state files")
```

Run: `npm.cmd run test:run -- tests/server/history-route.test.ts`

Expected: FAIL.

- [ ] **Step 2: Implement history projector**

Read from workspace `.autoagent/tasks/**/runs/**` and event ledgers.

Return:

```ts
WorkspaceRunSummary[]
RunAuditDetail
AssignmentAuditDetail[]
FailureCategory
```

- [ ] **Step 3: Implement history routes**

Routes:

```text
GET /api/workspaces/:workspaceId/history/runs
GET /api/workspaces/:workspaceId/history/runs/:taskRunId
```

- [ ] **Step 4: Implement RuntimeHistory UI**

P0 views:

- run list
- run detail
- assignment chain
- provider/tool events
- artifacts
- QA/Boss acceptance
- failure category

- [ ] **Step 5: Run tests**

Run:

```powershell
npm.cmd run test:run -- tests/server/history-route.test.ts tests/e2e/mock-loop.test.ts
npm.cmd run typecheck
```

Expected: PASS.

- [ ] **Step 6: Browser QA**

Verify:

- `历史` nav loads.
- Completed mock run appears.
- Run detail is readable.
- No console errors or layout overlap.

- [ ] **Step 7: Commit**

```powershell
git add src/server/storage/history-projector.ts src/server/routes/history.ts src/server/app.ts src/client/components/RuntimeHistory.tsx src/client/App.tsx src/client/api.ts src/client/styles.css tests/server/history-route.test.ts
git commit -m "feat: add runtime history audit"
```

---

## Task 12: Full UI Refactor Cleanup

**Files:**
- Modify: `src/client/App.tsx`
- Modify: `src/client/components/RunConsole.tsx`
- Modify: `src/client/components/AgentStudio.tsx`
- Modify: `src/client/components/WorkspaceTeam.tsx`
- Modify: `src/client/components/ProviderSettings.tsx`
- Modify: `src/client/components/RuntimeHistory.tsx`
- Modify: `src/client/styles.css`
- Modify: `tests/client/view-model.test.ts`

- [ ] **Step 1: Split oversized App responsibilities**

Move page-specific JSX out of `App.tsx`. Keep `App.tsx` responsible for:

- selected workspace
- top-level navigation
- loading initial shared state
- passing props to page components

- [ ] **Step 2: Ensure no card-in-card layout**

Review CSS against product UI guidance:

- operational, not marketing-like
- no nested cards
- stable dimensions for canvas and panels
- no text overlap at desktop/mobile

- [ ] **Step 3: Run client tests and typecheck**

Run:

```powershell
npm.cmd run test:run -- tests/client
npm.cmd run typecheck
```

Expected: PASS.

- [ ] **Step 4: Browser QA desktop and mobile**

Use Chrome/Playwright:

- 1440x900
- 390x844

Verify Run Console, Agent Studio, Team, Provider, and History.

- [ ] **Step 5: Commit**

```powershell
git add src/client/App.tsx src/client/components src/client/styles.css tests/client
git commit -m "refactor: split production platform ui surfaces"
```

---

## Task 13: E2E Production Journey Coverage

**Files:**
- Modify: `tests/e2e/mock-loop.test.ts`
- Create: `tests/e2e/production-platform.test.ts`
- Modify: `package.json` only if a new script is needed

- [ ] **Step 1: Add E2E for P0 journeys using mock provider**

Test should cover:

1. list seeded AgentDefinitions
2. create a user AgentDefinition
3. bind it to a workspace team
4. update team override
5. start a task
6. wait for completion
7. inspect history detail

- [ ] **Step 2: Add failure path E2E**

Use mock or controlled provider to verify:

- missing/invalid provider config error path
- tool denied path
- stop path
- QA retry path

- [ ] **Step 3: Run E2E**

Run:

```powershell
npm.cmd run test:e2e
```

Expected: PASS.

- [ ] **Step 4: Commit**

```powershell
git add tests/e2e package.json
git commit -m "test: cover production platform journeys"
```

---

## Task 14: Docs and Release Checklist

**Files:**
- Modify: `README.md`
- Create: `docs/release-checklist.md`
- Modify: `docs/superpowers/specs/2026-06-30-autoagent-production-platform-design.md` only if implementation changed design facts.

- [ ] **Step 1: Update README concepts**

README must explain:

- AgentDefinition vs WorkspaceAgent
- Agent Studio
- Workspace Team
- Runtime Ops / History
- Provider setup and test connection
- development vs production policy
- local startup flow

- [ ] **Step 2: Add release checklist**

`docs/release-checklist.md` must include:

```powershell
npm.cmd run test:run
npm.cmd run test:e2e
npm.cmd run typecheck
npm.cmd run build
```

Also include browser QA pages:

- Run Console
- Agent Studio
- Team
- Provider
- History

And failure path smoke:

- missing key
- tool denied
- stop
- resume
- QA retry

- [ ] **Step 3: Run documentation sanity search**

Run:

```powershell
rg -n "Agent 配置|AgentDefinition|WorkspaceAgent|Agent Studio|Workspace Team|Runtime Ops" README.md docs
```

Expected: old `Agent 配置` wording only appears when explaining migration/rename.

- [ ] **Step 4: Commit**

```powershell
git add README.md docs/release-checklist.md docs/superpowers/specs/2026-06-30-autoagent-production-platform-design.md
git commit -m "docs: document production platform release flow"
```

---

## Final Verification

Run commands sequentially, not in parallel:

```powershell
npm.cmd run test:run
npm.cmd run test:e2e
npm.cmd run typecheck
npm.cmd run build
```

Expected:

- All tests pass.
- Typecheck passes.
- Build succeeds.

Then start the production server:

```powershell
$env:AUTOAGENT_HOME="$HOME\.autoagent"
$env:PORT="13748"
npm.cmd start
```

Browser QA with Chrome/Playwright:

- `http://127.0.0.1:13748/`
- Run Console page loads and current task controls are usable.
- Agent Studio page displays identity/soul/loop/capabilities/defaults.
- Team page displays workspace bindings and overrides.
- Provider page can test connection and show missing key errors.
- History page displays completed/failed run audit detail.
- No console errors.
- No overlapping text or broken layout at desktop and mobile viewport.

## Execution Notes

- Use `rg` for file discovery and content checks.
- Use `npm.cmd` on Windows.
- Do not run `npm.cmd run build` in parallel with E2E tests because build deletes `dist`.
- Do not remove current compatibility routes until all UI and tests use the new Team routes.
- Keep commits small and aligned to the task boundaries above.
- Any storage migration must preserve existing `.autoagent` workspaces or provide a clear fallback.

