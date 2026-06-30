# AutoAgent V1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build AutoAgent V1 as a shippable local web platform where a fixed autonomous team can run a task against local workspaces, emit a replayable event ledger, recruit specialists, and project live state onto a canvas UI.

**Architecture:** Implement one Node.js/TypeScript app with an Express Gateway that owns storage, policy, mission control, agent runtime, provider adapters, and SSE events. The React/Vite frontend consumes Gateway APIs and event projections; UI state is always derived from backend snapshots and events.

**Tech Stack:** Node.js, TypeScript, Express, Vite, React, Vitest, SSE, JSON/JSONL filesystem storage, OpenAI SDK, Anthropic SDK.

---

## Opportunity and Priority Breakdown

### P0: Runtime Fact Source

The first shippable value is a trustworthy local fact source: workspace registry, `.autoagent` storage, append-only task-run event ledger, snapshots, and SSE. Without this, the canvas would be decoration.

### P1: Autonomous Team Loop

The second value is a deterministic Mission Control loop: Boss, PM, Architect, Dev, QA, QA failure return, and Boss-controlled recruitment. V1 can use mock providers in tests and real providers at runtime.

### P2: Tool and Policy Boundary

The third value is local execution with real safety boundaries: development and production policy profiles, workspace-scoped path checks, command execution, and role-level tool restrictions.

### P3: Visual Operating Console

The fourth value is the local web UI: workspace list, task starter, live canvas, event stream, and agent detail drawer. It must reveal runtime truth rather than store UI-owned state.

### P4: Online-Ready Packaging

The final value is production readiness: build/start scripts, environment docs, tests, and a smoke flow that can be run locally.

## File Structure

```text
package.json
tsconfig.json
vite.config.ts
index.html
src/
  shared/
    types.ts
    events.ts
    ids.ts
  server/
    index.ts
    app.ts
    config.ts
    errors.ts
    storage/
      paths.ts
      json.ts
      workspace-store.ts
      event-ledger.ts
      state-projector.ts
      session-store.ts
    providers/
      types.ts
      mock-provider.ts
      openai-provider.ts
      anthropic-provider.ts
      provider-registry.ts
    policy/
      policy.ts
      path-policy.ts
      command-policy.ts
    tools/
      tool-runtime.ts
      file-tools.ts
      shell-tool.ts
    agents/
      roster.ts
      prompts.ts
      agent-runtime.ts
      recruitment.ts
    mission/
      mission-control.ts
      phases.ts
    routes/
      workspaces.ts
      tasks.ts
      events.ts
      providers.ts
  client/
    main.tsx
    App.tsx
    api.ts
    styles.css
    components/
      WorkspaceHome.tsx
      WorkspaceConsole.tsx
      TeamCanvas.tsx
      EventStream.tsx
      AgentDrawer.tsx
      StatusBadge.tsx
tests/
  server/
    event-ledger.test.ts
    state-projector.test.ts
    policy.test.ts
    mission-control.test.ts
    provider-registry.test.ts
    agent-runtime.test.ts
    events-route.test.ts
  client/
    projection.test.ts
  e2e/
    mock-loop.e2e.test.ts
README.md
.gitignore
```

## Task 1: Project Scaffold and Test Harness

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vite.config.ts`
- Create: `index.html`
- Create: `.gitignore`
- Create: `src/shared/types.ts`
- Create: `src/server/index.ts`
- Create: `src/server/app.ts`
- Create: `src/server/config.ts`
- Create: `src/server/errors.ts`
- Create: `src/client/main.tsx`
- Create: `src/client/App.tsx`
- Create: `src/client/styles.css`
- Create: `tests/server/smoke.test.ts`

- [ ] **Step 1: Create package and TypeScript/Vite config**

Add scripts: `dev`, `build`, `start`, `test`, `test:run`, and `typecheck`. Use ESM TypeScript.

- [ ] **Step 2: Create minimal Express app**

Expose `GET /api/health` returning `{ ok: true, name: "AutoAgent" }`. Add `config.ts` for port/home/workspace settings and `errors.ts` for typed HTTP errors. In production, serve Vite static output from `dist/client`.

- [ ] **Step 3: Create minimal React shell**

Render "AutoAgent" and the first-pass workspace layout shell with header, workspace region, and console region.

- [ ] **Step 4: Write smoke test**

Test that the Express app responds to `/api/health`.

- [ ] **Step 5: Run verification**

Run: `npm install`, then `npm run test:run`, `npm run typecheck`, and `npm run build`.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json tsconfig.json vite.config.ts index.html src tests .gitignore
git commit -m "chore: scaffold AutoAgent app"
```

## Task 2: Shared Domain Types and Event Ledger

**Files:**
- Create: `src/shared/events.ts`
- Create: `src/shared/ids.ts`
- Create: `src/server/storage/paths.ts`
- Create: `src/server/storage/json.ts`
- Create: `src/server/storage/event-ledger.ts`
- Create: `tests/server/event-ledger.test.ts`
- Modify: `src/shared/types.ts`

- [ ] **Step 1: Define canonical types**

Define `Workspace`, `AgentProfile`, `WorkspaceAgent`, `Task`, `TaskRun`, `Assignment`, `AssignmentRun`, `AutoAgentEvent`, `PolicyProfile`, and event type constants from the spec.

- [ ] **Step 2: Write failing event ledger tests**

Test append-only JSONL writes, ordered reads, `taskRunId` storage path, and structured event fields.

- [ ] **Step 3: Implement path and JSON helpers**

Centralize workspace `.autoagent` paths, global `~/.autoagent` paths, safe JSON reads/writes, and directory creation.

- [ ] **Step 4: Implement event ledger**

Append newline-delimited JSON events to `<workspace>/.autoagent/tasks/<taskId>/runs/<taskRunId>/events.jsonl`.

- [ ] **Step 5: Run tests**

Run: `npm run test:run -- tests/server/event-ledger.test.ts`.

- [ ] **Step 6: Commit**

```bash
git add src/shared src/server/storage tests/server/event-ledger.test.ts
git commit -m "feat: add event ledger"
```

## Task 3: Workspace Registry and State Projection

**Files:**
- Create: `src/server/storage/workspace-store.ts`
- Create: `src/server/storage/state-projector.ts`
- Create: `src/server/routes/workspaces.ts`
- Create: `tests/server/state-projector.test.ts`
- Modify: `src/server/app.ts`

- [ ] **Step 1: Write failing workspace/store tests**

Test creating a workspace from an empty directory, attaching an existing directory, ensuring `.autoagent/`, writing `workspace.json`, and adding `.autoagent/` to `.gitignore`.

- [ ] **Step 2: Write failing projector tests**

Given event sequences, verify the snapshot reconstructs task phase, agent statuses, current steps, assignments, recruitment, QA feedback, and completion.

- [ ] **Step 3: Implement workspace store**

Persist global registry under `~/.autoagent/workspaces.json`, but keep workspace facts inside project `.autoagent/`.

- [ ] **Step 4: Implement state projector**

Convert events into `WorkspaceSnapshot` for UI/API. Write `state.json` after meaningful event batches.

- [ ] **Step 5: Add workspace routes**

Expose `GET /api/workspaces`, `POST /api/workspaces`, and `GET /api/workspaces/:workspaceId/snapshot`.

- [ ] **Step 6: Run tests**

Run: `npm run test:run -- tests/server/state-projector.test.ts`.

- [ ] **Step 7: Commit**

```bash
git add src/server/storage src/server/routes src/server/app.ts tests/server/state-projector.test.ts
git commit -m "feat: add workspace storage and projection"
```

## Task 4: Provider Adapters

**Files:**
- Create: `src/server/providers/types.ts`
- Create: `src/server/providers/mock-provider.ts`
- Create: `src/server/providers/openai-provider.ts`
- Create: `src/server/providers/anthropic-provider.ts`
- Create: `src/server/providers/provider-registry.ts`
- Create: `src/server/routes/providers.ts`
- Create: `tests/server/provider-registry.test.ts`
- Modify: `src/server/app.ts`

- [ ] **Step 1: Write failing provider registry tests**

Test mock provider deterministic responses, missing credential errors, provider selection by agent config, normalized tool/action output, stream event normalization, usage metadata propagation, retryable error classification, terminal error classification, and retry behavior for transient failures.

- [ ] **Step 2: Define provider interface**

Expose `runAgentTurn(input)` returning streamed/collected `AgentProviderEvent` records, optional usage metadata, and normalized errors with `retryable: boolean`.

- [ ] **Step 3: Implement mock provider**

Return structured outputs for Boss, PM, Architect, Dev, QA, and specialist recruitment scenarios.

- [ ] **Step 4: Implement OpenAI adapter**

Read credentials from environment and optional `~/.autoagent/providers.json`; normalize text outputs and basic tool-intent JSON when present.

- [ ] **Step 5: Implement Anthropic adapter**

Read credentials from environment and optional `~/.autoagent/providers.json`; normalize text outputs and basic tool-intent JSON when present.

- [ ] **Step 6: Implement retry wrapper**

Retry transient provider failures according to config. Do not retry terminal auth, invalid request, or policy errors.

- [ ] **Step 7: Add provider status route**

Expose `GET /api/providers/status` with configured/unconfigured status, never returning secrets.

- [ ] **Step 8: Run tests**

Run: `npm run test:run -- tests/server/provider-registry.test.ts`.

- [ ] **Step 9: Commit**

```bash
git add src/server/providers src/server/routes/providers.ts src/server/app.ts tests/server/provider-registry.test.ts
git commit -m "feat: add model provider adapters"
```

## Task 5: Policy Runtime and Tools

**Files:**
- Create: `src/server/policy/policy.ts`
- Create: `src/server/policy/path-policy.ts`
- Create: `src/server/policy/command-policy.ts`
- Create: `src/server/tools/tool-runtime.ts`
- Create: `src/server/tools/file-tools.ts`
- Create: `src/server/tools/shell-tool.ts`
- Create: `tests/server/policy.test.ts`

- [ ] **Step 1: Write failing policy tests**

Test production denies writes outside workspace, development allows host paths, agent role permissions are enforced, and denied tool calls emit `tool.denied`.

- [ ] **Step 2: Implement policy resolver**

Merge global policy profile, workspace overrides, and agent overrides into an effective policy.

- [ ] **Step 3: Implement path policy**

Normalize paths, resolve symlinks when possible, and compare absolute paths against workspace root for production policy.

- [ ] **Step 4: Implement file tools**

Support read, write, list, and append artifact operations under policy.

- [ ] **Step 5: Implement shell tool**

Execute commands with cwd set to workspace root, capture stdout/stderr/exit code, enforce policy before execution, and emit events.

- [ ] **Step 6: Run tests**

Run: `npm run test:run -- tests/server/policy.test.ts`.

- [ ] **Step 7: Commit**

```bash
git add src/server/policy src/server/tools tests/server/policy.test.ts
git commit -m "feat: enforce workspace tool policy"
```

## Task 6: Agent Runtime and Core Roster

**Files:**
- Create: `src/server/agents/roster.ts`
- Create: `src/server/agents/prompts.ts`
- Create: `src/server/agents/agent-runtime.ts`
- Create: `src/server/agents/recruitment.ts`
- Create: `src/server/storage/session-store.ts`
- Create: `tests/server/agent-runtime.test.ts`

- [ ] **Step 1: Write failing agent runtime tests**

Test that each assignment creates an `AssignmentRun`, emits `agent.status_changed`, `agent.step_started`, provider events, artifacts, and completion/failure events. Test that each workspace agent has an isolated `agents/<workspaceAgentId>/sessions/` directory and that session history is written and reloaded independently for different agents.

- [ ] **Step 2: Implement core roster seeding**

Create Boss, PM, Architect, Dev, and QA profiles and workspace agents idempotently, including `agent.json` and `sessions/` under each workspace agent directory.

- [ ] **Step 3: Implement prompts**

Provide concise role prompts that require structured JSON outputs for phase results, recruitment needs, tool intents, QA pass/fail, and final acceptance.

- [ ] **Step 4: Implement agent runtime**

Load workspace agent state and session history, run provider adapter, append the turn transcript to the agent session store, execute normalized tool intents through tool runtime, append events, and return structured assignment result.

- [ ] **Step 5: Implement recruitment service**

Create `AgentProfile` and `WorkspaceAgent` from a Boss-approved capability gap; emit recruitment and join events.

- [ ] **Step 6: Run tests**

Run: `npm run test:run -- tests/server/agent-runtime.test.ts`.

- [ ] **Step 7: Commit**

```bash
git add src/server/agents src/server/storage/session-store.ts tests/server/agent-runtime.test.ts
git commit -m "feat: add agent runtime and roster"
```

## Task 7: Mission Control

**Files:**
- Create: `src/server/mission/phases.ts`
- Create: `src/server/mission/mission-control.ts`
- Create: `src/server/routes/tasks.ts`
- Create: `tests/server/mission-control.test.ts`
- Modify: `src/server/app.ts`

- [ ] **Step 1: Write failing mission tests**

Cover happy path, QA failure return to Dev, Architect capability gap, Boss recruitment, pause, resume, stop/interrupt, one-active-TaskRun-per-workspace enforcement, and event ordering.

- [ ] **Step 2: Implement mission phases**

Define `boss_intake`, `pm_plan`, `architect_plan`, `implementation`, `qa`, `boss_acceptance`, `paused`, `completed`, `failed`, `interrupted`.

- [ ] **Step 3: Implement task start route**

Expose `POST /api/workspaces/:workspaceId/tasks` to create a `Task`, `TaskRun`, seed roster, emit `task.created`, and start mission execution. If the workspace already has an active task run, return a typed conflict error instead of starting another run.

- [ ] **Step 4: Implement deterministic loop**

Route assignments through Boss, PM, Architect, Dev/specialist, QA, and Boss acceptance.

- [ ] **Step 5: Implement pause and resume routes**

Expose `POST /api/workspaces/:workspaceId/tasks/:taskId/pause` and `POST /api/workspaces/:workspaceId/tasks/:taskId/resume`. Pause marks the active task run `paused` between assignment boundaries and emits `task.phase_changed`; resume continues from the next Mission Control step.

- [ ] **Step 6: Implement stop route**

Expose `POST /api/workspaces/:workspaceId/tasks/:taskId/stop`; mark active task run interrupted and emit `run.interrupted`.

- [ ] **Step 7: Run tests**

Run: `npm run test:run -- tests/server/mission-control.test.ts`.

- [ ] **Step 8: Commit**

```bash
git add src/server/mission src/server/routes/tasks.ts src/server/app.ts tests/server/mission-control.test.ts
git commit -m "feat: orchestrate autonomous team loop"
```

## Task 8: SSE Event Streaming

**Files:**
- Create: `src/server/routes/events.ts`
- Modify: `src/server/storage/event-ledger.ts`
- Modify: `src/server/app.ts`
- Create: `tests/server/events-route.test.ts`

- [ ] **Step 1: Write failing SSE tests**

Test that clients can subscribe to workspace events and receive newly appended events.

- [ ] **Step 2: Add event bus**

Publish every appended event to an in-process event bus keyed by workspace and task run.

- [ ] **Step 3: Implement SSE route**

Expose `GET /api/workspaces/:workspaceId/events` with replay cursor support for recent events.

- [ ] **Step 4: Run tests**

Run: `npm run test:run -- tests/server/events-route.test.ts`.

- [ ] **Step 5: Commit**

```bash
git add src/server/routes/events.ts src/server/storage/event-ledger.ts src/server/app.ts tests/server/events-route.test.ts
git commit -m "feat: stream workspace events"
```

## Task 9: Workspace Home UI

**Files:**
- Create: `src/client/api.ts`
- Create: `src/client/components/WorkspaceHome.tsx`
- Create: `src/client/components/StatusBadge.tsx`
- Modify: `src/client/App.tsx`
- Modify: `src/client/styles.css`
- Create: `tests/client/projection.test.ts`

- [ ] **Step 1: Implement API client**

Add typed helpers for health, workspace list/create, provider status, snapshot, task start, pause, resume, stop, and SSE subscription.

- [ ] **Step 2: Implement Workspace Home**

Show workspace list, create/attach workspace form, provider status, and active task summary.

- [ ] **Step 3: Add focused UI projection test**

Test frontend helper maps snapshot agent status to display state.

- [ ] **Step 4: Run tests and build**

Run: `npm run test:run -- tests/client/projection.test.ts` and `npm run build`.

- [ ] **Step 5: Commit**

```bash
git add src/client tests/client/projection.test.ts
git commit -m "feat: add workspace home UI"
```

## Task 10: Workspace Console and Canvas

**Files:**
- Create: `src/client/components/WorkspaceConsole.tsx`
- Create: `src/client/components/TeamCanvas.tsx`
- Create: `src/client/components/EventStream.tsx`
- Create: `src/client/components/AgentDrawer.tsx`
- Modify: `src/client/App.tsx`
- Modify: `src/client/styles.css`

- [ ] **Step 1: Implement console layout**

Left column: goal input and task controls including start, pause, resume, and stop. Center: team canvas. Right: event stream and current step.

- [ ] **Step 2: Implement TeamCanvas**

Render Boss -> PM -> Architect -> Dev/Specialist -> QA -> Boss topology from snapshot agents and assignments.

- [ ] **Step 3: Implement live SSE updates**

On task start or workspace selection, subscribe to events, update snapshot through API refresh or local projection, and keep the UI in sync.

- [ ] **Step 4: Implement Agent Drawer**

Show role, capabilities, current assignment, current step, recent tool calls, and artifacts.

- [ ] **Step 5: Run build**

Run: `npm run build`.

- [ ] **Step 6: Commit**

```bash
git add src/client
git commit -m "feat: add live team console"
```

## Task 11: Docs, Demo Flow, and Production Hardening

**Files:**
- Create: `README.md`
- Modify: `.gitignore`
- Modify: `package.json`
- Modify: `src/server/config.ts`
- Modify: `src/server/errors.ts`

- [ ] **Step 1: Add README**

Document install, dev, build, start, provider configuration, workspace policy profile, and a local demo flow.

- [ ] **Step 2: Harden config and errors**

Validate ports, home directory paths, JSON parse failures, missing provider credentials, and invalid workspace paths with clear user-facing errors.

- [ ] **Step 3: Add final verification script**

Ensure `npm run test:run`, `npm run typecheck`, and `npm run build` are documented and pass.

- [ ] **Step 4: Commit**

```bash
git add README.md .gitignore package.json src/server/config.ts src/server/errors.ts
git commit -m "docs: document AutoAgent local deployment"
```

## Task 12: Automated E2E Mock Loop

**Files:**
- Create: `tests/e2e/mock-loop.e2e.test.ts`
- Modify: `package.json`
- Modify: `src/server/app.ts`

- [ ] **Step 1: Write E2E test**

Create a temporary workspace, start the app in test mode with the mock provider, create a workspace through the API, submit a goal, wait for completion, and assert that the task run completed.

- [ ] **Step 2: Assert persisted facts**

Verify `events.jsonl` exists under `<workspace>/.autoagent/tasks/<taskId>/runs/<taskRunId>/`, includes Boss/PM/Architect/Dev/QA events, includes a `run.completed` event, and can reconstruct the final snapshot.

- [ ] **Step 3: Assert UI-ready snapshot**

Fetch the workspace snapshot and assert the canvas projection includes five core agents, statuses, current/final phase, and no UI-owned persistence requirement.

- [ ] **Step 4: Add test script if needed**

Ensure `npm run test:run` includes E2E tests or add `npm run test:e2e` and call it from final verification.

- [ ] **Step 5: Run E2E**

Run: `npm run test:run -- tests/e2e/mock-loop.e2e.test.ts`.

- [ ] **Step 6: Commit**

```bash
git add tests/e2e/mock-loop.e2e.test.ts package.json src/server/app.ts
git commit -m "test: add mock team loop e2e"
```

## Final Verification

- [ ] Run `npm run test:run`.
- [ ] Run `npm run typecheck`.
- [ ] Run `npm run build`.
- [ ] Start production server with `npm run start`.
- [ ] Open the printed local URL.
- [ ] Create an empty workspace.
- [ ] Run a mock-provider task end-to-end.
- [ ] Confirm events appear in `<workspace>/.autoagent/tasks/<taskId>/runs/<taskRunId>/events.jsonl`.
- [ ] Confirm the canvas shows active agent highlighting and final completion.
- [ ] Confirm workspace `.gitignore` includes `.autoagent/`.
