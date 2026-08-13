# Linux Node verification delivery

## Configuration delivered

- `.github/workflows/linux-node.yml` runs on the native GitHub Actions `ubuntu-24.04` runner with Node 22.
- The workflow uses `npm ci`, then invokes `npm run verify:linux-node`.
- `scripts/verify-linux-node.mjs` rejects any non-Linux Node process (`process.platform !== "linux"`) before running tests. It invokes `npm` with `shell: false`, never `npm.cmd`, PowerShell, WSL, or a Windows Node executable.
- The entry is serial and fail-fast. It records JSON start/finish events and each child exit code; a non-zero step stops the sequence and exits non-zero.

Required order:

1. `npm run test:run -- tests/server/event-ledger-lock-recovery.test.ts`
2. `npm run test:run -- tests/server/runtime-host.test.ts`
3. `npm run test:run`
4. `npm run typecheck`
5. `npm run build`

## Native Linux execution status

**Not run in this workspace.** The available workspace host is Windows, and no remote CI trigger was authorized during this delivery. Therefore no Linux pass is claimed. Existing Windows results and workflow configuration are not native Linux execution evidence.

When authorized, the smallest external action is: **a repository member with CI/workflow permission manually dispatches the `Linux Node verification` workflow once** (or allows the push-triggered run). The resulting run URL, commit ref, runner OS, Node/npm versions, and JSON step exit codes must be retained as the native evidence. No customer-side installation is required.

## Local audit evidence

On this Windows host, the script's guard was exercised only as a negative check: it must exit 2 and must not start npm. This is not a substitute for Linux verification. The workflow and script are the configuration deliverable; the five command results below remain `not run natively` until the authorized Linux job executes.

| Item | Configuration | Native Linux result | Evidence source |
|---|---|---|---|
| lock recovery | fixed first step | not run | workflow + script; Linux run required |
| runtime-host | fixed second step | not run | workflow + script; Linux run required |
| full test:run | fixed third step | not run | workflow + script; Linux run required |
| typecheck | fixed fourth step | not run | workflow + script; Linux run required |
| build | fixed fifth step | not run | workflow + script; Linux run required |

No Git commit was created. Changes remain uncommitted by design.
