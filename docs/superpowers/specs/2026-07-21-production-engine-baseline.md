# AutoAgent Production Engine Baseline

Date: 2026-07-21

Status: implementation baseline

## Product invariant

AutoAgent is three cooperating systems. None may impersonate another:

- Agent Engine owns an Agent's ordered thread, turns, goals, model calls and tools.
- Ticket Engine owns the Mission Plan, Ticket DAG, attempts, dependencies and terminal state.
- Mission Control durably delivers ready Tickets to Agents and settles Agent proposals into Ticket commands.

The UI and Runtime Task state are rebuildable projections. They never decide routing or completion.

Assurance semantics also remain outside platform business logic. Agents
interpret the Mission baseline and real evidence. The host enforces only a
stable evidence envelope: judgment basis, observed facts, deviations,
provenance and exact transfer of those facts into final settlement. Mission
Control does not encode a product type, fixed role sequence, keyword classifier
or domain-specific acceptance rule.

## Authoritative state

| Fact | Sole owner |
| --- | --- |
| What an Agent has seen and said | Agent rollout |
| Whether an Agent turn is queued, running or finished | Agent rollout turn records |
| Whether work is ready, running, blocked, returned or complete | Ticket Engine |
| Whether the current Plan DAG is complete | Ticket Engine completion policy |
| Whether the Mission is accepted | Mission Control settlement against the Mission baseline |
| Delivery and settlement progress between the two engines | Mission Control process record |
| Task status, phase, avatar state and conversation badge | projection only |

There must be no writable `Task.status`, `phase` or avatar status that can contradict the owners above.

## Agent turn scheduling

1. Every trigger is first appended to the Agent rollout with a stable message/event id and turn id.
2. The unconsumed turn record in the append-only rollout is the durable queue entry; there is no second message queue.
3. One Agent thread executes at most one turn at a time. In-process promises provide mutual exclusion, while restart recovery scans the rollout for the earliest unconsumed turn.
4. Messages arriving during a turn remain queued for the next turn; they are never injected into the in-flight request and never start a second session.
5. A process restart reconstructs pending work from the rollout. In-memory promises are only an optimization.
6. Provider failures finish the current turn attempt with a visible operational outcome. They do not complete, fail or pause a Ticket or Plan by themselves.
7. Safety controls stop only the current turn attempt. They are configurable budgets and must expose the exact reason and continuation action.

## Ticket and Mission settlement

1. Ticket Engine emits `TicketReady`; Mission Control creates one idempotent dispatch process.
2. Mission Control claims the Ticket, starts one Agent Goal and records their mapping.
3. The Agent submits one structured proposal through `goal_resolution` or `request_human_input`.
4. Mission Control validates the proposal contract and applies one idempotent Ticket command.
5. Mission Control settles the same Agent proposal and marks the dispatch process settled.
6. A crash between steps resumes the same process from durable ids. It never asks the model to repeat completed work.
7. Mission Control does not infer routing from role names, keywords, natural language or phases.
8. `goal_resolution(status="failed")` is a terminal, immutable failure of the
   current Ticket. Its effect on the Plan is governed only by the Plan's
   completion policy:
   - `fail_fast` terminates the Plan.
   - `require_resolution` blocks the Plan and appends one independently ready
     planner-amendment Ticket.
9. The amendment Ticket carries the failed Ticket and its evidence as
   provenance. PM decides the replacement DAG through an ordinary Plan change;
   platform code does not infer a repair target, role, or implementation step.
10. A Plan change that repairs an immutable `failed`, `returned`, or
    `cancelled` Ticket must declare a `failureResolution` edge from that
    historical Ticket to one newly added correction or assurance Ticket. The
    historical status and Attempt remain unchanged. Its dependency is treated
    as satisfied only after the declared resolution Ticket completes; a
    returned or failed resolution Ticket keeps the Plan blocked and may itself
    be resolved by a later edge.
11. The planning Agent chooses the resolution relation. Ticket Engine only
    validates references, acyclicity, terminal closure, and completion state;
    Mission Control only transports the accepted change. Neither layer infers
    a repair target from roles, phases, keywords, or failure text.
12. An Agent that already knows the required structural change or completed
    upstream defect should still use the explicit Plan-change or correction
    action. A genuine exhausted execution may settle as `failed` without
    destroying a recoverable Mission.

## Completion and evidence

Agent completion is a claim about its own Ticket, not about the whole Mission.

- `completed` must address every Ticket success criterion.
- `domainOutcome` is the typed domain deliverable; top-level `criterionResults`
  is the universal checklist for the Ticket's own success criteria. Every
  normal resolution contains both, and a domain schema never bypasses the
  checklist.
- Every `satisfied` criterion must contain at least one evidence reference unless the Ticket contract explicitly marks it as cognitive-only.
- File evidence is resolved inside the workspace and recorded with size, modification time and content hash.
- Evidence facts remain immutable audit history. If one proposal references
  several facts for the same workspace path, only its newest referenced
  version participates in freshness validation. Referencing only a stale
  version still fails.
- Command evidence records command, working directory, exit code and bounded output.
- Browser/manual evidence records the tested URL or artifact and the observations.
- Platform validation proves evidence exists and is attributable. It does not invent semantic conclusions.
- QA independently determines pass, correction, plan change or required human input.
- Completing required terminal Tickets completes the current Plan DAG, not the Mission by itself.
- A Mission is complete only after an authorized Agent submits an accepted settlement covering every criterion in the current Mission baseline.

## Projection rules

Task state is derived in this order:

1. Durable Mission settlement, cancellation, or failure.
2. Plan terminal state that still requires Mission continuation or settlement.
3. Plan paused.
4. Blocked Ticket or blocked Agent Goal requiring human input.
5. Claimed Agent run or running Ticket.
6. Ready Ticket waiting for dispatch.
7. Idle.

An Agent avatar is green only while its turn is actually executing. It is yellow only when that Agent owns a blocked Ticket or a failed/paused turn requiring an explicit operator action.

## Current Ticket identity

1. Mission Control must attach an explicit machine-readable current-Ticket envelope to every dispatched Goal. At minimum it carries the current output schema and whether this Ticket may settle the Mission.
2. Providers, test doubles and projections must read the latest current-Ticket envelope. They must not infer current authority by searching the full prompt, historical handoffs or future DAG nodes for role names, schema names or permission fields.
3. Historical Ticket envelopes remain chronological audit facts. A later envelope supersedes them only for the current turn; it does not rewrite history.
4. Mock Provider behavior is contract simulation, not business routing. It must follow the same current-Ticket identity as a real provider so deterministic tests cannot pass or loop for reasons that production never sees.

## Source request and Mission baseline

1. The human source request is immutable chronological provenance. It is not the
   executable plan and must never be recursively copied into every downstream
   Agent session.
2. Intake converts that source into the formal Mission baseline, recording
   assumptions, clarifications, exclusions, and observable success criteria.
3. Planning receives both the formal baseline and a source-request audit copy.
   The baseline remains authoritative for execution; the source copy exists only
   to detect an unsupported omission, narrowing, or semantic downgrade.
4. If planning detects such a mismatch, the Agent returns a correction against
   intake. Mission Control transports that explicit result through Ticket
   contracts; it must not infer the mismatch from keywords or product-specific
   code.
5. Downstream execution and assurance Agents receive the accepted baseline,
   Ticket definition, and immutable handoff lineage. They do not reread the raw
   source request as a second competing specification.

## Graceful runtime shutdown

1. Stopping a RuntimeHost first prevents new scheduler ticks.
2. It then aborts active Pi sessions and waits for each Agent session to become idle, so a stalled provider request cannot stall process shutdown indefinitely.
3. After interruption, it drains in-flight scheduler work, queued/running Agent turns and serialized host operations before releasing workspace files and locks.
4. Registry and process shutdown must await this drain. Fire-and-forget disposal is forbidden because it can corrupt restart recovery and causes Windows file-lock races during cleanup.
5. Tests wait for durable terminal state rather than assuming a fixed number of scheduler ticks.
6. Every managed process records its Agent, thread, Goal and Ticket Attempt
   owner. Polling and local-browser evidence may consume it only from that same
   Attempt. Startup timeout terminates the whole child process tree, and a port
   is considered available only when both an active connection probe and an
   exclusive bind confirm it.

## Goal-owned execution resources

1. A Goal Attempt is the ownership boundary for browser sessions, managed
   services, command processes and their evidence. Settling, cancelling or
   disposing the Goal releases every owned resource; a later Goal never
   inherits an opaque browser daemon or process handle.
2. Browser commands that share a Goal Attempt session execute in arrival order.
   A provider may emit multiple tool calls concurrently, but the Tool Runtime
   serializes stateful operations on that session so navigation, observation
   and evidence cannot read another call's page state. Different Agent sessions
   remain independent and may execute concurrently.
3. Browser transport has a bounded command timeout. A transport timeout,
   connection reset or stale local daemon is an infrastructure outcome, not a
   product observation and not a Ticket result.
4. The tool runtime may replace a stale browser session and replay an
   observational command such as `open`, `snapshot` or `get`. It must not
   automatically replay commands with side effects such as clicks, key presses
   or form submission.
5. If transparent recovery cannot restore the tool, Agent Engine ends the
   current turn attempt with a typed infrastructure outcome. Mission Control
   keeps the same Goal, Ticket and Plan unchanged and schedules a bounded,
   observable retry.
6. Infrastructure failures never enter `domainOutcome`, never satisfy or fail a
   Mission criterion, and never create a planner amendment. Product conclusions
   remain the Agent's responsibility after tools are available again.
6. These rules are capability- and ownership-based. They contain no branch for
   a role name, phase name, product type or expected workflow.

## Release gates

A release is not production-ready until all gates pass:

1. Contract suite: engine ownership and invalid cross-layer transitions.
2. Recovery suite: crash injection after every dispatch and settlement write.
3. Concurrency suite: duplicate ticks, duplicate messages and simultaneous human messages produce one ordered turn sequence.
4. Real-provider canary: at least three different goals in disposable workspaces.
5. Artifact acceptance: inspect and execute produced files; browser products are exercised with Playwright at desktop and mobile sizes.
6. Human-loop acceptance: a real free-form human reply triggers exactly one next turn on the selected Agent.
7. Rework acceptance: QA correction preserves the returned Ticket as immutable
   provenance, appends a planner amendment and produces a fresh correction and
   assurance chain with an explicit failure-resolution edge. It never reopens
   a terminal Ticket, and downstream work unlocks only after the new resolution
   Ticket completes.
8. Operational acceptance: provider failure, restart and resume do not duplicate model calls or lose queued input.
9. Cost acceptance: per-Mission token/cost budget, warning and operator-visible stop reason.
10. Soak acceptance: repeated Missions run for hours without increasing pending queues, stale claims or memory use.

Mock-provider tests prove deterministic contracts only. They never count as artifact or product acceptance.

## Runtime restoration availability

- Immutable policy validation completes before the HTTP listener starts.
- Historical workspace restoration starts only after the listener is available and runs concurrently across workspaces.
- A slow or damaged historical workspace must not block health checks, the UI, or restoration of unrelated workspaces.
- Restoration uses a bounded worker pool (`AUTOAGENT_RUNTIME_RESTORE_CONCURRENCY`, default `2`) so restart cannot wake every historical Agent at once.
- `/api/health` exposes whether runtime hosts are `not_started`, `restoring`, `ready`, or `failed`.
- Every managed command or service is owned by one Agent Runtime. Disposing that runtime terminates the complete owned process tree; no service may survive as an untracked workspace-global process.
## Assignment and increment contracts

- TeamBinding snapshots both configured capabilities and the exact tools enabled for each Agent instance.
- A planned Ticket declares the capabilities and tools required to execute it.
- Mission Control performs exact set matching only. It does not infer tools from role names, Ticket titles, or business-language keywords.
- One TeamBinding member must satisfy the complete assignment; capabilities and tools from multiple Agents cannot be merged into one Ticket.
- A delivery increment is a grouping inside one Plan, not a hard-coded phase or role sequence.
- A later increment waits for the unfinished exits of the preceding increment through DAG dependencies.
- Ticket Engine validates graph ordering without requiring a particular role, title, or output schema for an increment exit.

## 调度与团队绑定不变量

- `TeamBinding` 是 Mission 创建时形成的不可变快照，必须随 Mission 持久化。恢复任务只能读取该快照，不得根据当前档案或当前工作区成员重新推导历史 Mission 的负责人、能力或验收权限。
- Agent 的协议能力来自档案配置。岗位名称只用于展示和默认模板初始化，Mission Control 不得在运行时根据 `boss`、`pm`、`dev`、`qa` 等角色名追加能力。
- Ticket 没有满足 `principalId` 或 `requiredCapabilities` 的成员时保持 `ready` 且未领取。Mission Control 必须暴露能力缺口，不得静默改派给规划者或其他角色。
- Mission 的全局 human 消息发送给创建时固化的 owner；单 Agent 私聊发送给被选择的 Agent。两者都不得通过角色名称猜测接收者。
- Ticket 的负责人、状态、依赖和权限来自 Ticket Engine 与 TeamBinding；旧五阶段名称只能作为兼容展示数据，不能参与调度。
