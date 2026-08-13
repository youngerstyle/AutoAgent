# Linux Node verification status

This is a status record for the repository-owned verification entry, not a claim that the entry has passed on Linux.

- Configuration: **delivered** (`.github/workflows/linux-node.yml`, `scripts/verify-linux-node.mjs`, `package.json` script).
- Native Linux execution: **not run**. The current agent workspace is Windows and remote CI dispatch authorization is unavailable.
- Minimum external action: one repository member with workflow permission manually dispatches the `Linux Node verification` workflow.
- Customer action: none; the customer is not asked to install a company validation environment.
- Evidence rule: only the authorized Linux runner's machine-auditable command output and exit codes can change the native execution status.
- Existing Windows test/typecheck/build results remain Windows-only background and are not promoted to Linux evidence.
