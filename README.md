# AutoAgent

AutoAgent is a local web console for running and observing a small autonomous agent team inside a workspace.

V1 ships a fixed team:

- Boss: intake, acceptance, staffing
- PM: planning and scope control
- Architect: technical plan and capability gap detection
- Dev: implementation and tool execution
- QA: verification
- Specialist: recruited automatically when the Architect reports a missing capability

## Quick Start

```powershell
npm.cmd install
npm.cmd run build
$env:AUTOAGENT_HOME="$HOME\.autoagent"
$env:PORT="8787"
npm.cmd start
```

Open `http://127.0.0.1:8787`.

For development:

```powershell
$env:NODE_ENV="development"
$env:AUTOAGENT_HOME="$HOME\.autoagent"
npm.cmd run dev
```

## Provider Config

The mock provider is always available and is used in tests. In the UI, use the `Provider` tab to configure OpenAI and Anthropic model, API key, and optional base URL. Secrets are stored under `AUTOAGENT_HOME/providers.json` and are redacted when read back through the API.

OpenAI and Anthropic can also be configured with environment variables:

```powershell
$env:OPENAI_API_KEY="..."
$env:ANTHROPIC_API_KEY="..."
```

Or with `providers.json` under `AUTOAGENT_HOME`:

```json
{
  "openai": {
    "provider": "openai",
    "model": "gpt-4.1-mini",
    "apiKey": "..."
  },
  "anthropic": {
    "provider": "anthropic",
    "model": "claude-3-5-sonnet-latest",
    "apiKey": "..."
  }
}
```

Provider configuration API:

- `GET /api/providers/config` returns redacted provider configs.
- `PATCH /api/providers/:provider` saves `openai` or `anthropic` config.

## Agent Config

Use the `Agent 配置` tab to inspect and edit the workspace team. Every workspace is seeded with Boss, PM, Architect, Dev, and QA. Specialist agents can be recruited by the runtime when a capability gap is detected.

Each workspace agent has independent persisted state under `<workspace>/.autoagent/agents/<workspaceAgentId>/agent.json`:

- `provider`: `mock`, `openai`, or `anthropic`.
- `model`: the model used by that agent's runtime loop.
- `policyOverride`: read, write, command execution, and host access permissions.

Agent configuration API:

- `GET /api/workspaces/:workspaceId/agents` seeds and lists the workspace roster.
- `PATCH /api/workspaces/:workspaceId/agents/:agentId` updates provider, model, and policy override.

## Storage Model

- Global state: `AUTOAGENT_HOME`
- Provider state: `AUTOAGENT_HOME/providers.json`
- Workspace state: `<workspace>/.autoagent`
- Agent state: `<workspace>/.autoagent/agents/<workspaceAgentId>`
- Agent sessions: `<workspace>/.autoagent/agents/<workspaceAgentId>/sessions`
- Task events: `<workspace>/.autoagent/tasks/<taskId>/runs/<taskRunId>/events.jsonl`
- Task control state: `<workspace>/.autoagent/tasks/<taskId>/runs/<taskRunId>/state.json`

Workspace `.autoagent/` is automatically added to the workspace `.gitignore`.

## Runtime Flow

1. Create or select a workspace.
2. Configure provider credentials globally when using OpenAI or Anthropic.
3. Configure per-agent provider, model, and policy when the workspace needs role-specific behavior.
4. Start a task from the console.
5. Mission Control runs Boss, PM, Architect, Dev, QA, and Boss acceptance.
6. The agent runtime reads each workspace agent's provider/model/policy before executing its assignment.
7. If the Architect reports a capability gap, Boss recruits a Specialist and the Specialist appears on the canvas.
8. QA failure emits `qa.failed` and returns the task to Dev, up to the retry budget.
9. UI receives live events over SSE and refreshes the workspace snapshot.

Only one active `TaskRun` is allowed per workspace.

## Policy Profiles

Production workspaces scope file access to the workspace root. Development workspaces allow host path access for local experimentation.

Role policy defaults are conservative: PM and Boss cannot execute commands, Dev and QA can execute commands, and Dev/Specialist can write workspace files.

## Verification

```powershell
npm.cmd run test:run
npm.cmd run test:e2e
npm.cmd run typecheck
npm.cmd run build
```

The E2E test creates a workspace, runs the mock team loop through the HTTP API, verifies specialist recruitment, checks the completed snapshot, and confirms the implementation artifact is written.

## V1 Boundaries

- No automatic git commit, push, or deployment.
- No marketplace-style recruiting UI yet.
- Agent prompts are intentionally compact; the user can replace the loop and prompts later.
- The UI stores view state only in memory. Agent/task state is persisted under `.autoagent`.
