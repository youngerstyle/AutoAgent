# AutoAgent Production Platform Design

## Purpose

AutoAgent should ship as a local autonomous team platform, not only as a runnable multi-agent demo.

The production-ready product must let a user define reusable agents, assemble a project team, run real work inside a workspace, observe and control the team while it works, and audit the result after completion or failure.

The current V1 implementation proves several runtime primitives:

- Workspace registry and workspace-local `.autoagent` state.
- Event ledger, snapshots, and SSE.
- Fixed Boss, PM, Architect, Dev, QA loop.
- Mock/OpenAI/Anthropic provider adapters.
- Basic canvas and task console.
- Workspace agent runtime settings for provider, model, and policy override.

That is a runnable prototype. It is not yet the full platform because Agent identity, soul, loop definition, workspace team composition, and runtime operations are not first-class product surfaces.

## Production-Ready Definition

AutoAgent is production-ready for P0 when a local user can:

1. Configure provider credentials and verify that real OpenAI or Anthropic calls can run.
2. Define or inspect reusable agents with identity, soul, loop definition, capabilities, and runtime defaults.
3. Add agents to a workspace as a project team without mutating the reusable agent definition.
4. Submit a workspace task and watch the team execute through auditable assignments.
5. Pause, resume, stop, and diagnose failed runs from the UI.
6. Inspect task history, run history, assignment history, tool calls, artifacts, QA results, and Boss acceptance.
7. Understand safety boundaries for development vs production policy and dangerous permissions.
8. Restart the app and recover durable workspace, agent, session, event, and run facts.

This definition is intentionally narrower than the long-term fully automated company. It excludes hosted multi-user mode, marketplace, visual loop graph editing, complex performance management, and multi-task concurrent scheduling.

## P0 User Journeys

Production readiness should be judged against concrete user journeys.

### Journey 1: First Local Setup

The user starts AutoAgent locally, opens the web app, configures a provider, tests the connection, and sees whether the system can run real tasks.

Done means:

- The app starts from documented commands.
- Provider state is understandable without reading logs.
- Invalid credentials produce an actionable UI error.
- The user can continue with mock mode for demos or tests.

### Journey 2: Define a Reusable Agent

The user creates or edits an agent in Agent Studio and can understand its identity, soul, loop, capabilities, and runtime defaults.

Done means:

- The agent definition can be saved, reopened, duplicated, and versioned.
- Soul and loop are visible product concepts, not hidden prompt fragments.
- The user can tell whether they are editing a reusable agent or a workspace override.

### Journey 3: Assemble a Workspace Team

The user creates or selects a workspace, adds existing agents to the team, and configures project-specific overrides.

Done means:

- Adding an agent creates a workspace-scoped instance.
- The same reusable agent can join multiple workspaces without shared mutable session state.
- The team page shows role, responsibility, effective provider/model, policy, and current status.

### Journey 4: Run and Control a Task

The user submits a task and watches the team execute.

Done means:

- The user can see the active phase, active agent, current step, recent events, and task controls.
- Pause, resume, and stop work from the UI.
- The canvas and event stream reflect backend facts.

### Journey 5: Audit a Result or Failure

The user reviews what happened after a run completes or fails.

Done means:

- The user can inspect assignment history, model calls, tool calls, artifacts, QA result, and Boss acceptance.
- Failure pages explain whether the issue was provider, policy, tool, loop, QA, or user interruption.
- Restarting the app does not erase run facts.

## Product Architecture

The platform has three primary product layers.

```text
Agent Studio
  defines reusable agent bodies, souls, loops, capabilities, and defaults

Workspace Team
  binds reusable agents into a project as workspace-scoped instances

Runtime Ops
  runs assignments, controls execution, records facts, and exposes audit surfaces
```

The UI should expose those layers directly:

- `Run Console`: current task, canvas, events, controls.
- `Agent Studio`: reusable agent definitions.
- `Team`: workspace-specific team composition and overrides.
- `Provider`: credentials, models, and connection tests.
- `History`: tasks, runs, artifacts, events, failures, and audit trails.

The current `Agent 配置` page should become `Team`. A real `Agent Studio` page should own identity, soul, loop definition, capabilities, and reusable defaults.

## Domain Model

### AgentDefinition

An `AgentDefinition` is a reusable worker identity. It is global and can join many workspaces.

```ts
interface AgentDefinition {
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

An agent definition is not the same thing as a running workspace agent. Editing an agent definition changes future reusable behavior, and may create a new version rather than silently mutating past runs.

### AgentIdentity

Identity is the visible and durable agent body.

```ts
interface AgentIdentity {
  name: string;
  displayName: string;
  role: "boss" | "pm" | "architect" | "dev" | "qa" | "specialist" | string;
  avatar?: string;
  summary: string;
  origin: "system" | "user" | "recruited";
  version: string;
}
```

Identity answers: who is this agent, where did it come from, and how should a user recognize it?

### AgentSoul

Soul is the stable behavioral core used when constructing prompts and interpreting work style.

```ts
interface AgentSoul {
  mission: string;
  principles: string[];
  personality: string;
  workStyle: string;
  decisionRules: string[];
  boundaries: string[];
  communicationStyle: string;
}
```

Soul should be editable but not casually hidden inside task prompts. It must be visible in Agent Studio because it defines whether an agent is careful, aggressive, skeptical, product-minded, security-focused, or execution-heavy.

### LoopDefinition

Loop definition is how an agent works.

```ts
interface LoopDefinition {
  id: string;
  version: string;
  inputContract: string;
  planningStrategy: string;
  executionStrategy: string;
  reflectionStrategy: string;
  handoffRules: string[];
  stopConditions: string[];
  failurePolicy: string;
  requiredSignals: string[];
}
```

Loop definition should affect runtime behavior. It is not decorative metadata. Every assignment run should record which loop id and version were used.

### CapabilitySet

Capabilities describe what the agent can plausibly do and which tools it may request.

```ts
interface CapabilitySet {
  domains: string[];
  skills: string[];
  languages: string[];
  frameworks: string[];
  tools: string[];
  limitations: string[];
}
```

Capabilities are used by Mission Control for routing and by Boss for later recruitment decisions.

### AgentRuntimeDefaults

Runtime defaults are reusable defaults, not per-workspace overrides.

```ts
interface AgentRuntimeDefaults {
  provider: "mock" | "openai" | "anthropic";
  model: string;
  temperature?: number;
  contextStrategy: "recent" | "summarized" | "full-when-small";
  policyDefaults: Partial<AgentPolicy>;
}
```

### WorkspaceAgent

A `WorkspaceAgent` is an instance of an `AgentDefinition` inside one workspace. This is the "shadow clone" that accumulates project-specific memory and runtime state.

```ts
interface WorkspaceAgent {
  id: string;
  workspaceId: string;
  agentDefinitionId: string;
  agentVersion: string;
  instanceName?: string;
  roleInWorkspace: string;
  status: EntityStatus;
  runtimeOverride?: Partial<AgentRuntimeDefaults>;
  policyOverride?: Partial<AgentPolicy>;
  workspaceMemory?: WorkspaceAgentMemory;
  joinedAt: string;
}
```

Workspace-specific edits should not mutate the source agent definition unless the user explicitly promotes those edits back to the reusable agent.

### AssignmentRun

Assignments are the runtime audit unit.

```ts
interface AssignmentRun {
  id: string;
  taskId: string;
  taskRunId: string;
  workspaceAgentId: string;
  agentDefinitionId: string;
  agentVersion: string;
  loopDefinitionId: string;
  loopVersion: string;
  provider: ProviderName;
  model: string;
  type: AssignmentType;
  status: EntityStatus;
  promptDigest: string;
  startedAt: string;
  endedAt?: string;
}
```

The event ledger can remain the append-only source of runtime facts, but the UI needs queryable history projections for tasks, assignment runs, artifacts, and failure reasons.

## Storage Layout

Global storage under `AUTOAGENT_HOME`:

```text
~/.autoagent/
  providers.json
  workspaces.json
  agents/
    <agentDefinitionId>/
      agent.json
      versions/
        <version>.json
```

Workspace-local storage:

```text
<workspace>/.autoagent/
  workspace.json
  team/
    <workspaceAgentId>/
      agent.json
      memory.json
      sessions/
  tasks/
    <taskId>/
      runs/
        <taskRunId>/
          state.json
          events.jsonl
          assignments/
          artifacts/
```

The current path `<workspace>/.autoagent/agents/<workspaceAgentId>` can be migrated or aliased to `team/<workspaceAgentId>` during implementation. The design intent is that global `agents` are reusable definitions and workspace `team` entries are project instances.

## Runtime Flow

1. User creates or selects a workspace.
2. User configures providers and validates credentials.
3. User defines agents in Agent Studio or uses system defaults.
4. User adds agents to the workspace team.
5. User submits a task.
6. Mission Control selects the next assignment owner using role, capabilities, loop state, and task phase.
7. Agent Runtime builds the turn from:
   - assignment contract
   - agent identity
   - agent soul
   - loop definition
   - workspace memory
   - recent session context
   - provider/model/policy effective config
8. Provider runs the turn.
9. Tool runtime executes normalized tool intents under policy.
10. Runtime appends events, session history, tool results, artifacts, and assignment audit data.
11. Mission Control routes to the next agent, requests QA retry, recruits a specialist, completes, blocks, or fails.
12. UI projects the live run from durable backend facts.

## Mission Control Responsibilities

Mission Control is the organization-level router, not a hidden general-purpose super-agent.

It owns:

- Task phase.
- Assignment routing.
- QA retry routing.
- Capability gap evaluation.
- Boss-owned recruitment in P0.
- Pause/resume/stop boundaries.
- Run terminal states.

It should not hide implementation choices in unstructured text. Every decision that affects routing should become a structured event.

## Agent Studio Surface

Agent Studio P0 should support:

- List reusable agents.
- Inspect system agents.
- Create a new user agent.
- Edit identity, soul, loop definition, capabilities, and runtime defaults.
- Duplicate an existing agent.
- Version an agent when meaningful behavior changes.
- Show where an agent is currently used.

P0 can keep authoring as structured forms and text areas. A visual loop editor is P1/P2.

## Workspace Team Surface

Workspace Team P0 should support:

- Show the active project team.
- Add an existing AgentDefinition to the workspace.
- Remove or disable an agent from the workspace.
- Configure workspace-specific provider/model/policy overrides.
- Show workspace memory/session status.
- Distinguish source definition fields from workspace override fields.
- Show recruited specialists as real agents that joined the project.

This page replaces the current overloaded `Agent 配置` meaning.

## Runtime Ops Surface

Runtime Ops P0 should support:

- Current task status and current phase.
- Active agent and current step.
- Pause, resume, stop.
- Structured event stream.
- Assignment list for the current run.
- Tool call history.
- Artifacts.
- Failure reason and retry path.
- Boss acceptance and QA result.
- Previous task runs for the workspace.

The canvas is valuable only when it reflects runtime facts. It should not be the only way to understand a run.

## Provider and Safety Surface

Provider P0 should support:

- OpenAI and Anthropic key configuration.
- Base URL configuration.
- Default model configuration.
- Connection test.
- Redacted secret display.
- Clear errors for missing key, invalid key, model unavailable, rate limit, and network failure.

Safety P0 should support:

- Explain `development` vs `production`.
- Show effective permissions per workspace agent.
- Highlight command execution and host access.
- Surface `tool.denied` as an expected safety event, not a confusing failure.

## Recruitment Direction

P0 keeps Boss as the recruiter. There is no separate recruiter agent yet.

Recruitment flow:

1. An agent emits a structured capability gap.
2. Boss evaluates the gap.
3. Boss creates a new `AgentDefinition` with identity, soul, loop, capabilities, and defaults.
4. Boss joins that agent to the current workspace as a `WorkspaceAgent`.
5. The specialist receives an assignment.

P0 can use conservative generated defaults for soul and loop. Later versions can add interview, evaluation, and a dedicated recruiter.

## P0 Workstreams

### P0.1 Agent Domain Model

Define `AgentDefinition`, `AgentIdentity`, `AgentSoul`, `LoopDefinition`, `CapabilitySet`, `AgentRuntimeDefaults`, and `WorkspaceAgent` boundaries.

Acceptance:

- Type definitions represent reusable agents separately from workspace instances.
- Existing system agents can be expressed through the new model.
- Tests prove workspace overrides do not mutate source definitions.

### P0.2 Agent Studio Storage and API

Persist reusable agents globally under `AUTOAGENT_HOME/agents`.

Acceptance:

- API can list, create, read, update, duplicate, and version agents.
- System agents are seeded idempotently.
- Secrets are not stored in agent definitions.

### P0.3 Workspace Team Storage and API

Bind agents into a workspace as project team members.

Acceptance:

- API can list team, add agent, update overrides, remove/disable agent.
- A single AgentDefinition can join multiple workspaces with isolated state.
- Recruited specialists appear as both global definitions and workspace team members.

### P0.4 Agent Studio and Team UI

Split current Agent configuration into product surfaces.

Acceptance:

- `Agent Studio` edits reusable definitions.
- `Team` edits workspace bindings and overrides.
- UI clearly labels source fields vs override fields.
- Browser QA verifies layout, navigation, and no console errors.

### P0.5 Runtime Uses Soul and Loop

Runtime prompt construction must use agent identity, soul, loop definition, and capabilities.

Acceptance:

- Assignment events record agent definition id, agent version, loop id, loop version, provider, and model.
- Tests prove changing a loop definition changes the runtime prompt.
- Session history remains workspace-agent scoped.

### P0.6 Runtime Ops and History

Expose run history and audit views.

Acceptance:

- User can inspect completed and failed runs.
- User can inspect assignment chain, provider events, tool calls, artifacts, QA result, and Boss acceptance.
- Restarting the app preserves history.

### P0.7 Provider and Safety Readiness

Make provider and permission state operationally clear.

Acceptance:

- Provider connection test exists.
- Missing/invalid credentials show clear UI errors.
- Effective policy is visible per workspace agent.
- Dangerous permissions are visually prominent.

### P0.8 Release Gates

Define the release gate as evidence, not optimism.

Required verification:

- `npm.cmd run test:run`
- `npm.cmd run test:e2e`
- `npm.cmd run typecheck`
- `npm.cmd run build`
- Browser QA on Run Console, Agent Studio, Team, Provider, and History.
- Manual smoke with a real configured provider when credentials are available.
- Failure-path smoke for missing key, tool denied, stop, resume, and QA retry.

## P0 Delivery Slices

Implementation should not attempt the entire platform in one pass. Each slice must leave the app in a coherent state and preserve the current runnable loop.

### Slice 1: Model Boundary

Introduce the new domain model while preserving current behavior.

Exit criteria:

- System Boss/PM/Architect/Dev/QA exist as `AgentDefinition` records.
- Current workspaces can still seed a team.
- Existing E2E mock loop still passes.

### Slice 2: Team Binding

Move workspace membership from implicit fixed roster toward explicit workspace team bindings.

Exit criteria:

- Workspace team state can be listed and updated through APIs.
- Workspace-specific provider/model/policy overrides continue to work.
- A single agent definition can be bound into two test workspaces with isolated sessions.

### Slice 3: Agent Studio UI

Expose reusable agent definitions.

Exit criteria:

- Users can inspect and edit identity, soul, loop, capabilities, and defaults.
- The old `Agent 配置` meaning is removed or renamed to `Team`.
- Browser QA covers Run Console, Agent Studio, Team, and Provider navigation.

### Slice 4: Runtime Contract Upgrade

Make soul and loop operational.

Exit criteria:

- Runtime prompt construction reads identity, soul, loop, and capabilities.
- Assignment events record agent definition and loop version.
- Tests prove loop changes affect runtime input.

### Slice 5: Runtime Ops History

Make completed and failed work inspectable.

Exit criteria:

- Users can navigate previous task runs.
- Assignment runs, tool calls, provider events, artifacts, QA, and acceptance are inspectable.
- Failure reasons are categorized.

### Slice 6: Release Gate Hardening

Close the operational gaps.

Exit criteria:

- Provider connection test exists.
- Effective policy is visible and understandable.
- Release commands and browser QA are documented and repeatable.

## Spec Review Notes

This spec was reviewed against the active product objective and current codebase facts.

Findings addressed in this revision:

- The original V1 design treated "fixed team can run" as shippable; this spec redefines production readiness around reusable agents, workspace team composition, runtime controls, and auditability.
- The earlier Agent configuration page mixed reusable agent identity with workspace runtime settings; this spec separates `AgentDefinition` from `WorkspaceAgent`.
- Identity, soul, and loop definition were not first-class enough; this spec promotes them into required domain model sections and runtime inputs.
- P0 was too broad to execute safely; this spec adds delivery slices with exit criteria.
- Runtime success was underdefined; this spec adds concrete user journeys and audit requirements.

Open review items for the user:

- Whether `Agent Studio -> Workspace Team -> Runtime Ops` is the approved P0 direction.
- Whether Agent soul should be mostly freeform text in P0 or more structured from day one.
- Whether the current workspace-local path should be migrated immediately from `.autoagent/agents` to `.autoagent/team`, or kept as an internal compatibility detail for one implementation phase.

## P1 Workstreams

- Dedicated recruiter agent.
- Agent interview/evaluation flow.
- Visual loop editor.
- Richer memory controls.
- Cost and usage reporting.
- Multi-run comparison.
- Better artifact review and diffing.

## P2 Workstreams

- Multi-task concurrent scheduling.
- Hosted remote mode.
- Multi-user collaboration.
- Marketplace or agent registry sync.
- Automated deploy/PR integration.
- Performance management and scorecards.

## Implementation Strategy

Do not continue by adding fields to the current `Agent 配置` cards.

Recommended sequence:

1. Land domain model and storage migrations behind APIs.
2. Seed current Boss/PM/Architect/Dev/QA as system `AgentDefinition` records.
3. Change workspace team seeding to bind definitions into workspaces.
4. Rename current Agent UI to Team and preserve provider/model/policy override behavior.
5. Add Agent Studio for reusable definitions.
6. Feed soul and loop into prompt construction.
7. Add Runtime Ops history pages.
8. Harden provider/safety UX and release gates.

This keeps the existing working runtime alive while replacing the incorrect product model underneath it.

## Design Decision

AutoAgent P0 should proceed with:

```text
Agent Studio -> Workspace Team -> Runtime Ops
```

That direction matches the user's product intent:

- Agents are not just avatars or runtime rows.
- Agent configuration includes identity, soul, and loop definition.
- Workspaces are projects.
- Agents can join many projects through shadow-clone workspace instances.
- The human is in flow as owner and observer, not a mandatory approval loop.
- Boss can own initial routing and recruitment before a dedicated recruiter exists.
