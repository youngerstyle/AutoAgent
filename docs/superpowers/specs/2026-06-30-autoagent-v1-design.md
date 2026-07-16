# AutoAgent V1 Design

Date: 2026-06-30

## Goal

AutoAgent V1 is a local web platform for running an autonomous software team against one or more local project workspaces.

The first version must prove a real loop:

1. The user creates or selects a workspace.
2. The user describes a goal.
3. A fixed core team runs automatically: Boss, PM, Architect, Dev, QA.
4. The team can recruit specialist agents when it lacks a capability.
5. Agents execute real LLM loops through OpenAI or Anthropic.
6. Dev-like agents can read, write, and execute inside the configured workspace policy.
7. QA validates the result and sends failed work back into the loop.
8. The UI shows a live canvas of who is doing what, backed by an append-only event log.

V1 is local-first. It is not a cloud collaboration platform and does not automatically commit, push, deploy, or publish changes.

## Architecture Baseline

AutoAgent should combine three ideas:

- A Hermes-like single-agent runtime: real provider calls, tool execution, status callbacks, session persistence, context handling, and recovery boundaries.
- An OpenClaw-like multi-agent model: each agent is an isolated scope with its own workspace-facing state, auth/model settings, session history, and routing identity.
- An organization-level mission control layer: a deterministic state machine that assigns work, routes feedback, records decisions, and recruits specialists.

The core architecture is:

```text
AutoAgent Gateway
  -> Workspace Registry
  -> Mission Control / Orchestrator
  -> Agent Runtime Pool
  -> Tool and Policy Runtime
  -> Event Ledger
  -> UI Projection / Canvas
```

### Gateway / Control Plane

The Gateway is the local process that owns the platform API. It serves the web UI, receives workspace/task commands, streams events, handles pause/stop, and routes all runtime state to the UI.

The UI is not the source of truth. It subscribes to Gateway events and can request snapshots.

### Mission Control

Mission Control owns organization-level state:

- Which phase the task is in.
- Which agent owns the current assignment.
- Whether QA feedback should return to Dev or a specialist.
- Whether a capability gap requires recruitment.
- Whether the task is complete, blocked, failed, paused, or stopped.

Mission Control is not a hidden super-agent. It does not decide implementation details. It routes work through auditable assignments and uses agent outputs as inputs to the next state transition.

### Agent Runtime

Each agent runs through the same runtime contract:

```text
runAssignment({
  workspace,
  workspaceAgent,
  task,
  assignment,
  context,
  tools,
  eventSink
})
```

The runtime loads the agent prompt, session context, workspace context, provider configuration, and tool policy; then executes a real loop using OpenAI or Anthropic.

Each meaningful step emits events through `eventSink`.

### Agent Isolation

An agent is not just a label on the canvas. It has identity, local state, capabilities, tool policy, session history, and workspace-specific context.

The design separates:

- `AgentProfile`: global capability identity that can be reused across projects.
- `WorkspaceAgent`: an instance of a profile inside one workspace.
- `TaskRun`: one end-to-end team execution for a task goal.
- `AssignmentRun`: one concrete execution of one assignment by one workspace agent. This is the runtime clone, or "shadow clone", used for one task/subtask.

This lets a recruited TypeScript specialist join multiple workspaces without sharing project-local sessions or mutable state.

### Event Ledger and UI Projection

The append-only event ledger is the fact source for the UI and replay. The canvas is a projection of events plus the latest snapshot. Refreshing the browser must not lose the task state.

## Canonical Decisions

- A `Task` is the user's goal in a workspace. A `TaskRun` is one attempt to complete that task through the team workflow. V1 allows one active `TaskRun` per workspace, but the data model must allow more later.
- An `AssignmentRun` is the execution of one assignment by one agent. Tool calls, provider events, and agent step events attach to the assignment run when applicable.
- The event ledger and `state.json` snapshot are stored per `TaskRun`. Assignment runs are represented inside the same ledger with `assignmentRunId`.
- `qa.failed` is the canonical QA failure signal for Mission Control and UI projection. `qa.feedback` carries the structured feedback that explains the failure and can be emitted before or alongside `qa.failed`.
- `policyProfile` means permission defaults only. It does not mean "real model" vs "mock model." V1 product runs use real OpenAI or Anthropic providers when credentials are configured; tests and demos can use mock providers.
- `development` policy allows full host access by default. `production` policy restricts file writes and command execution to the workspace by default.

## Main Flow

```text
User creates/selects workspace
  -> User enters goal
  -> Boss checks whether the goal is actionable
  -> PM decomposes the goal into work
  -> Architect designs the technical approach and detects capability gaps
  -> Boss decides whether to recruit specialists
  -> Dev and/or specialists execute assignments
  -> QA verifies the result
  -> If QA fails, work returns to Dev/specialist with feedback
  -> If QA passes, Boss performs final acceptance
  -> User sees final result and event replay
```

V1 defaults to workspace-local full automation. The human is in the flow as owner and observer, not in the loop as a mandatory approver. The user can pause, stop, inspect, or later take over.

## Workspace Model

A workspace is one local project directory. It can be an existing project or an empty directory.

If the directory is empty, the team treats the first goal as project creation. Architect chooses the technical approach based on the requirement, and Dev creates the initial files.

V1 supports multiple workspaces at the platform level. The first UI can focus on one active task per workspace, but all backend entities must carry `workspaceId` from the start.

## Storage

Use global storage for cross-workspace profiles and provider configuration:

```text
~/.autoagent/
  profiles/
  providers.json
```

Use workspace-local storage for project-specific state:

```text
<workspace>/.autoagent/
  workspace.json
  agents/<workspaceAgentId>/
    agent.json
    sessions/
  tasks/<taskId>/runs/<taskRunId>/
    events.jsonl
    state.json
    artifacts/
```

The workspace-local `.autoagent/` directory is ignored by Git by default. It contains local run facts, snapshots, sessions, artifacts, and project-specific agent state.

`events.jsonl` is append-only. `state.json` is a convenience snapshot generated from events and runtime state.

## Core Entities

```text
Workspace
  id
  name
  rootPath
  policyProfile: development | production
  createdAt

AgentProfile
  id
  name
  role
  capabilities
  defaultProvider
  defaultModel
  defaultPolicy

WorkspaceAgent
  id
  workspaceId
  profileId
  roleInWorkspace
  agentDir
  status
  policyOverride

Task
  id
  workspaceId
  title
  goal
  status
  createdBy
  activeTaskRunId

TaskRun
  id
  taskId
  workspaceId
  status
  startedAt
  endedAt

Assignment
  id
  taskId
  taskRunId
  ownerWorkspaceAgentId
  type
  brief
  expectedArtifact
  status

AssignmentRun
  id
  taskId
  taskRunId
  assignmentId
  workspaceAgentId
  status
  startedAt
  endedAt

Event
  id
  workspaceId
  taskId
  taskRunId
  assignmentRunId
  actorId
  type
  summary
  payload
  timestamp
```

## Event Model

V1 event types include:

```text
task.created
task.phase_changed
assignment.created
assignment.started
assignment.completed
assignment.failed
agent.status_changed
agent.step_started
agent.step_completed
tool.started
tool.completed
tool.failed
handoff.created
qa.feedback
qa.failed
recruitment.requested
recruitment.approved
recruitment.failed
agent.created
agent.joined_workspace
run.completed
run.failed
run.interrupted
provider.failed
tool.denied
assignment.blocked
```

Events must be structured enough for replay and UI projection. The UI should never need to parse freeform assistant text to know whether an agent is running, blocked, or done.

## Team and Recruitment

V1 starts every workspace with five core roles:

- Boss
- PM
- Architect
- Dev
- QA

Any role can raise a capability gap. Boss owns the final recruitment decision in V1.

Recruitment is automatic and direct:

1. An agent emits a capability gap.
2. Boss evaluates the gap.
3. Boss creates a new `AgentProfile` with role, capability description, provider/model defaults, and policy.
4. The profile joins the current workspace as a `WorkspaceAgent`.
5. The new agent receives an assignment and appears on the canvas.

There is no trial period. Safety is enforced through scoped assignments, tool policy, event logging, QA feedback, and Boss/Architect routing.

Later versions can split recruitment into a dedicated Recruiter agent.

## Provider Layer

V1 supports OpenAI and Anthropic through a common provider interface.

Provider adapters should expose:

- model invocation
- streaming event callbacks
- tool-call normalization
- token/usage metadata when available
- retryable vs terminal error classification

Deterministic Engine and contract tests use mock providers. Release acceptance is a separate gate: it must use a configured real provider and verify the final artifact from the user's point of view, as defined in `2026-07-16-user-view-real-acceptance.md`.

## Tool and Policy Runtime

Policy is enforced in the backend, not in the UI.

Policy layers:

```text
Global Policy Profile
  development: full host access by default
  production: workspace-scoped file writes and command execution by default

Workspace Policy
  allowed paths
  command rules
  network rules
  budget limits

Agent Policy
  role-specific tools and overrides
```

Default V1 permissions:

- Boss: read workspace, create/route/recruit/accept; no source edits.
- PM: read workspace, write planning artifacts; no source edits.
- Architect: read workspace, write architecture artifacts, suggest dependencies and commands.
- Dev: read/write workspace, execute commands under policy.
- QA: read workspace, run test commands, write test reports.
- Specialist: generated from the recruitment need; default permissions must not exceed Dev unless the policy explicitly allows it.

V1 does not automatically commit, push, deploy, publish, or modify remote infrastructure.

## UI Design

The first UI has three views.

### Workspace Home

Shows all workspaces, supports adding an existing project directory or creating an empty workspace, and summarizes current task status, active agents, and last run time.

### Workspace Console

Main operating surface:

```text
Left: task input, start/pause/stop, current phase, final result
Center: team canvas
Right: event stream, current agent step, recent tool calls
```

### Agent Detail Drawer

Clicking an agent opens details:

- identity and role
- capabilities
- current assignment
- recent steps
- recent tool calls
- artifacts
- session summary

### Canvas Projection

V1 canvas is a task-status topology, not a freeform whiteboard:

```text
Boss -> PM -> Architect -> Dev/Specialist -> QA -> Boss
                     ^                     |
                     |------ feedback -----|
```

Visual rules:

- Running agents are highlighted and show current step.
- Waiting agents are visually quiet.
- Failed or blocked agents are marked clearly.
- Completed agents show completion state.
- Recruited specialists appear beside Dev or the relevant phase.
- QA failure draws a feedback path back to the responsible agent.

The canvas answers "where is the team now?" The event stream answers "what exactly happened?"

V1 can use React plus SVG/HTML layout. A heavier canvas library is deferred until free dragging, zooming, or multi-task graph editing is needed.

## Error Handling

Errors become events and affect Mission Control state.

Important error categories:

- `provider.failed`: model call failed.
- `tool.denied`: policy blocked a tool.
- `tool.failed`: file or command operation failed.
- `assignment.blocked`: owner cannot continue.
- `qa.failed`: QA did not accept the result; Mission Control must route work back to the responsible owner or escalate.
- `run.interrupted`: user paused or stopped the run.
- `recruitment.failed`: Boss could not create a useful specialist.

Recovery rules:

- Retry transient provider failures according to configuration.
- Do not bypass policy denial automatically.
- Route Dev/QA failures back through Mission Control.
- Restore UI from `state.json` and `events.jsonl` after page refresh.
- On backend restart, V1 restores history and current state but does not promise to continue a half-finished tool call.

## Testing Strategy

V1 needs focused tests around the product's facts, not just rendering.

Required coverage:

- Mission Control state machine: happy path, QA failure loop, recruitment, stop/interrupt.
- Event Ledger: append-only writes, ordering, replay, snapshot reconstruction.
- Policy Runtime: workspace restrictions, development vs production policy profiles, agent overrides.
- Provider Adapters: OpenAI and Anthropic behavior through mock streaming/tool calls.
- Agent Runtime: status callbacks and tool event emission.
- UI Projection: event streams reconstruct canvas state.
- Basic E2E: create workspace, submit goal, run a complete loop through mock providers.

## Explicit Non-Goals for V1

V1 does not include:

- freeform canvas editing
- multi-user collaboration
- remote hosted platform mode
- automatic commit/push/deploy
- production release automation
- complex performance management or scorecards
- long-running scheduled operations
- guaranteed recovery of a half-executed tool call after crash
- UI-owned state persistence

## Acceptance Criteria

V1 is successful when:

1. A user can create or select a local workspace.
2. A user can submit a goal and start the autonomous team.
3. Boss, PM, Architect, Dev, and QA run as distinct agents with separate runtime state.
4. Agents can use real OpenAI or Anthropic calls when provider credentials are configured.
5. Dev can make workspace-local changes under policy.
6. QA can validate and route failures back to implementation.
7. Boss can recruit a specialist agent for a missing capability.
8. The specialist joins the current workspace and appears on the canvas.
9. The UI shows step-level status without exposing hidden chain-of-thought.
10. The event log can replay the task run and reconstruct the visible state.

## Reference Notes

- Hermes is the reference for making a single agent loop real: provider adapters, tool execution, session persistence, status callbacks, compression/recovery boundaries, and gateway surfaces.
- OpenClaw is the reference for multi-agent isolation and routing: agents as scoped workspaces with their own state, sessions, and configuration.
- AutoAgent adds the missing organization layer: Mission Control, assignment contracts, QA gates, recruitment, and a canvas projection of runtime facts.
