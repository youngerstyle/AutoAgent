# Alpha real-user acceptance — 2026-08-12

## Release decision

AutoAgent passes the core gate for a controlled Alpha: a user can create a new project from the UI, staff a real Luna-backed team, publish a natural-language goal, receive real files, run the delivery, independently verify it, report a discovered defect as a new product task, and receive a verified repair without manually editing the generated project.

This is not yet a broad public-beta recommendation. The main remaining product UX gap is that a QA-started preview service is reclaimed when its Goal settles, while the completed-project UI does not expose a durable preview URL or one-click restart.

## Architecture under acceptance

Planning now has one model-facing protocol:

```text
Mission facts -> Luna -> rationale + flat TodoList
                         |
                         v
              deterministic Plan Compiler
                         |
                         v
 IDs + assignments + tools + contracts + DAG + criterion bindings
                         |
                         v
             execution -> independent QA -> settlement
```

The model owns semantic judgment: why the work is needed and the ordered architecture/implementation todos. The platform owns control-plane facts: IDs, team assignment, tool grants, output contracts, dependency edges, delivery increments, Mission criterion bindings, independent assurance, and final settlement.

The previous model-facing `plan-change-set-v3` protocol and its conversion path were removed. There is no compatibility branch that can opt a custom template back into model-authored graph internals.

## Acceptance environment

- AutoAgent UI: `http://127.0.0.1:8787/`
- Provider shown in each tested project: `GPT5.6-Luna (gpt-5.6-luna)`
- Acceptance method: browser-driven UI use plus independent commands against the generated deliverables
- Generated projects were not manually patched during acceptance. A discovered defect was reported through AutoAgent as a new task and repaired by the staffed team.

## Project 1 — browser Pomodoro

- Project: `Alpha Flat Todo Web v2`
- Workspace: `C:\Users\xieyizhi\Desktop\AutoAgentAlphaQA\flat-todo-web-v2`
- Goal: no-build responsive Pomodoro with 25/5 modes, start/pause/reset, completion count, persistence, tests, documentation, local service, and real-browser QA
- Planner output: two semantic todos (architecture and implementation), with no graph/schema correction loop
- Developer run: Playwright initially reported 4 passed / 1 failed; the delivery Agent diagnosed the failure, edited the product, and reran to 5 passed / 0 failed
- Independent QA: 7/7 Mission criteria satisfied, including desktop and mobile interaction, reload persistence, and browser screenshots
- External user check: followed the generated README, started a separate local service, received HTTP 200, opened the app in a fresh browser session, switched modes, and observed the running timer

Result: pass.

## Project 2 — NDJSON CLI

- Project: `Alpha NDJSON CLI v2`
- Workspace: `C:\Users\xieyizhi\Desktop\AutoAgentAlphaQA\ndjson-cli-v2`
- Goal: zero-runtime-dependency Node.js CLI supporting file/stdin NDJSON, level filtering, JSON output, strict mode, totals, malformed-line diagnostics, exit codes, help, examples, README, and automated tests
- Planner output: two semantic todos, with no graph/schema correction loop
- Initial team delivery: 8/8 tests passed and independent QA settled the Mission
- External user check found a defect not covered by the initial suite: PowerShell `Get-Content -Raw` supplied a leading UTF-8 BOM and trailing empty terminators, producing incorrect totals
- Defect handling: the issue was published as a new task in the same AutoAgent project; the team independently planned, implemented, and verified a generic fix that strips only a leading BOM while preserving middle/inline BOM semantics
- Repaired suite: 12/12 tests passed
- Exact external PowerShell result:

```text
EXIT=0
STDOUT={"total":4,"valid":4,"invalid":0,"levels":{"info":2}}
STDERR=
```

- Exact external strict-mode result:

```text
EXIT=1
STDOUT=
STDERR=error: line 2: invalid JSON
```

Result: pass after a real user-discovered defect and autonomous repair loop.

## Repository verification

- Production build: pass
- Automated suite: 65 test files passed; 585 tests passed
- Legacy model-authored Plan protocol search: no references under `src` or `tests`
- Working acceptance evidence captured locally under `.gstack/qa-reports/screenshots/`

## Alpha gate

| Gate | Result |
| --- | --- |
| Create a project entirely through the UI | Pass |
| Use the configured Luna provider, not mock acceptance | Pass |
| Produce a runnable browser product | Pass |
| Produce a runnable non-browser CLI product | Pass |
| Detect and repair an actual user-found defect through the product | Pass |
| Independent QA and authoritative settlement | Pass |
| Deterministic compiler owns platform graph/state | Pass |
| Durable post-completion preview UX | Known gap |
