# Tool Catalog Configuration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make available tools configurable per Agent while keeping prompt exposure and runtime execution on one source of truth.

**Architecture:** Add a shared tool catalog, extend `AgentPolicy` with `enabledTools`, and make context assembly, runtime execution, API persistence, and UI projection consume that catalog.

**Tech Stack:** TypeScript, React, Express, Vitest.

---

### Task 1: Shared Tool Catalog

**Files:**
- Create: `src/shared/tool-catalog.ts`
- Modify: `src/shared/types.ts`
- Create: `tests/server/tool-catalog.test.ts`

- [x] Write failing tests for role defaults, prompt protocol, and policy filtering.
- [x] Add `WorkspaceToolName` and `AgentPolicy.enabledTools`.
- [x] Implement `TOOL_CATALOG`, `roleToolDefaults`, `toolsForPolicy`, `toolProtocolFor`.
- [x] Verify tool catalog tests pass.

### Task 2: Runtime Enforcement

**Files:**
- Modify: `src/server/agents/agent-runtime.ts`
- Modify: `tests/server/agent-runtime.test.ts`

- [x] Write failing runtime test where `canExecuteCommands=true` but `enabledTools=["readFile"]` and model requests `shell`.
- [x] Deny unknown or disabled tools before reaching file/shell implementations.
- [x] Return denial as a tool result so the same Agent loop can continue.
- [x] Verify agent runtime tests pass.

### Task 3: Prompt and API Configuration

**Files:**
- Modify: `src/server/context/context-assembler.ts`
- Modify: `src/server/routes/agents.ts`
- Modify: `src/server/agents/profile-store.ts`
- Modify: `tests/server/context-assembler.test.ts`
- Modify: `tests/server/agents-route.test.ts`

- [x] Replace local prompt tool examples with `toolProtocolFor`.
- [x] Persist `enabledTools` through workspace agent route and global profile sanitization.
- [x] Verify context and route tests pass.

### Task 4: Frontend Configuration Surface

**Files:**
- Modify: `src/client/view-model.ts`
- Modify: `src/client/App.tsx`
- Modify: `src/client/styles.css`
- Modify: `tests/client/view-model.test.ts`

- [x] Project single tools instead of only broad permission groups.
- [x] Add per-tool toggles in project team runtime configuration.
- [x] Keep broad permission toggles as coarse safety gates.
- [x] Verify client view-model tests and typecheck pass.
