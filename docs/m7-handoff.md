# M7 development handoff

Use the shared management API v1 as the starting point for both branches. Read [the management API](management-api.md), [transport contracts](transport-extensions.md) and [management operations](management.md). Use independent worktrees and an isolated profile, runtime and LOCALAPPDATA. Run `node tests/m7-management.mjs` for the management contract and `powershell -ExecutionPolicy Bypass -File scripts/verify.ps1` for isolated engine smoke tests after building. Preserve the release deployment and its process, secrets, Git branch and tag.

## GUI line

Start from `feature/management-gui`. Bind actual and target state separately. Use the JSON child process for all state and mutations, with separate children for polling. Keep the TUI available for credential prompts and recovery. Include launch-in-progress, local readiness, stale configuration, lock conflict and interrupted task states. Never kill an engine merely because the GUI exits.

## Gemini web line

Start from `feature/gemini-web`. First verify the web client's actual integration, authentication, supported transports and security model. Reuse MCP stdio and the public descriptor and settings contracts. Keep connectivity and credentials in a dedicated adapter. Start with an isolated fixture. No Gemini connection is implemented by M7-A.
