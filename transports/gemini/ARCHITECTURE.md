# C3 Gemini adapter architecture (branch-local)

The official Gemini custom MCP app is the intended HTTPS Streamable HTTP client. C2 established OAuth/PKCE, native `read_file` execution and Restricted denial in the actual Gemini web app; see ignored `experiments/gemini-web-c2/runtime` evidence. C3 builds a separate branch-local transport package under `transports/gemini`, without modifying OpenAI, GUI, the shared management v1 protocol or the stable main tag.

## Boundaries

- **Web gateway:** Streamable HTTP server, JSON-RPC handling, source redaction, request limits, anonymous access refusal when public, and OAuth validation.
- **Authentication:** one-client-per-instance OAuth provider, exact Google redirect, S256 PKCE, single-use local preapproval, short-lived access and refresh grants; scope and tool allowlist changes require a new authorization process.
- **Engine bridge:** one pinned stdio child running `engine/stdio.mjs`, dynamic tool discovery, explicit deny-by-default allowlist and native MCP response forwarding. Tool permissions and filesystem resolution remain enforced by the pinned upstream LDC engine.
- **Instance:** deterministic id, isolated runtime and working root, process identity, generated settings, no secret in source or logs. Restricted is default; Full and terminal are deferred to C4's explicit secure-mode review. A change to target mode requires a stop/restart.
- **Lifecycle:** local-only startup, status, stop and restart. Public entry is reserved for the separate C5 authenticated tunnel integration. A local standalone gateway must never expose unauthenticated file tools to the network.

## Public management contract

The existing M7 manager currently registers `openai` / `local-dev` only. C3 does not edit `management/LDC-Core.ps1`, `management/LDC-Instance.ps1` or `LDC-Extensions.ps1`. To make Gemini a fully managed transport, a later common-maintenance change must add a trusted adapter hook, separate process ownership observer, status/diagnostic operations and extension descriptor integration. Until that change is coordinated into `develop` and both worktrees, this is a branch-local adapter and does not claim GUI management coverage.

## Test contract

Acceptance includes config rejection, real native MCP discovery and file reads, canonical restricted-root rejection, explicit tool allowlist, OAuth regression and token rejection, timeouts, engine failure, lifecycle cleanup and coexistence with existing worktrees. `C2.5` remains immutable evidence. Do not claim hosted Gemini L5 for C3 unless a new real web test is performed; C2's hosted evidence remains a proof of transport feasibility, not proof of C3 deployment.

## C3 implementation acceptance boundaries

The branch-local adapter is intentionally **loopback-only** and uses an ephemeral local bearer secret distinct from the C2 OAuth/public tunnel. It does not yet have a production OAuth web endpoint, nor a stable public hostname; official Gemini website verification is inherited from C2 but cannot be claimed as a C3 deployment acceptance. The C3 release gate covers only the standalone local adapter infrastructure; the C5 hosted OAuth deployment will reuse the previously verified secure flow after formal ownership and storage design.

The standalone `cli.mjs` is a long-running child protocol rather than a replacement of M7 management API v1. It supports status, configuration inspection, explicit-confirmation start/stop/restart and target configuration revisions. Public manager integration is a proposed C6 change and must be implemented through `develop` before GUI exposes it. The standalone CLI does not write into shared `management/` files or change existing process owners. The loopback gateway reports actual file and process state only for the current in-process runner. A crash of the standalone CLI destroys its volatile credential and listener; the next instance must start afresh.

The pinned native upstream engine currently advertises 14 file tools in files-only mode, but the C3 adapter deliberately exposes **only read_file** until C4 validates the broader tools and safety controls. Full access and terminal execution remain forbidden by this configuration. The Restricted root is verified by both the adapter and native Windows path policy; junction escapes are forbidden by the native engine. The tool allowlist is not the same thing as a Windows OS sandbox.

Source and checks:
- `config.mjs`: target configuration schema, revision and local allowed-root validation
- `bridge.mjs`: native pinned stdio child, dynamic tool discovery, allowlist and native results
- `gateway.mjs`: local Streamable HTTP, volatile bearer token, request limits and masked errors
- `runner.mjs`: instance identity, atomic target/status writes, lifecycle and process ownership
- `cli.mjs`: standalone loopback control over JSON stdin/stdout (not common manager v1)
- `adapter.test.mjs`, `cli.test.mjs`, `fault.test.mjs`, `isolation.test.mjs`, `timeout.test.mjs`: C3 local integration tests

Known C4/C5/C6 follow-up: expand tool schemas and tool modes; trusted OAuth endpoint and stable address with protected client storage; introduce a shared manager adapter registration and status/diagnostic hooks in a common-maintenance branch. Neither `management/LDC-Core.ps1` nor the GUI worktree should be modified for this branch-local C3 checkpoint.
