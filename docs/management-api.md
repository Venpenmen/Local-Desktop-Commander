# Local management API v1

On Windows, start a separate PowerShell 5.1 child for each request. Send one UTF-8 JSON line to stdin and read one UTF-8 JSON line from stdout. Close stdin after writing. No listener or daemon is required. Invoke the script by absolute path. The child runs with the caller's Windows identity and filesystem permissions. The service survives the closure of its management client.

```powershell
'{"protocol":1,"id":"status-1","operation":"state"}' |
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File ./management/LDC-CLI.ps1
```

The request fields are `protocol`, `id` (1–64 ASCII letters, digits or hyphens), `operation` and optional `arguments`. The response returns `protocol`, `id`, `ok` and either `result` or `error`. Exit 0 means the request was accepted or completed as specified. Exit 1 accompanies a structured error. Process startup failures outside the script can instead produce a PowerShell error on stderr. Request IDs are for correlation. They do not deduplicate operations.

| Operations | Arguments and result |
| --- | --- |
| `capabilities`, `versions`, `extensions` | Discover supported operations, versions and registered metadata. |
| `state` | Observed process identity, target and rollback, current configured roots, last task and OpenAI health data. |
| `config.get` | Schema, configured values and revision. |
| `start`, `stop`, `restart`, `rollback` | `confirmed: true`. Return the latest operation task. |
| `select` | `confirmed`, `revision`, `version`, `mode` (`files` or `terminal`). Saves the target. With a different running instance, switches using the existing process checks. |
| `root.set` | `confirmed`, `revision`, `version`, `path`. Stops are separate. The target version must be safe to configure and the root activates on its next start. |
| `network.set` | `confirmed`, `revision`, `proxy`. Use a loopback HTTP address or JSON null for automatic selection. |
| `task.get` | Latest task, optionally require its exact `id`. Historical task retention is outside v1. |
| `events`, `logs` | Poll the bounded recent event window and redacted tunnel summaries. No push notifications. |
| `diagnose` | Runs the existing credential-free OpenAI HTTPS probe. |

Use a confirmation dialog before passing `confirmed: true` for state-changing actions. For terminal mode, include that the terminal runs with the Windows user's permissions. Configured file roots apply to file tools. Read the current revision immediately before proposing a change, and discard stale forms on `REVISION_CONFLICT`. Revisions identify configuration content. Each write uses the existing atomic replace mechanism. Legacy selection files acquire schema 1 on their next write. Keep the version registry and runtime files under the management core's control.

Poll `task.get` or `state` from a second child while a mutation is outstanding. Tasks expose an ID, operation, timestamps and state (`running`, `completed`, `failed`, `cancelled` or `interrupted`). If an operation owner disappears, the next read checks its process creation time and reports interruption. Re-read actual state before retrying after a disconnect or timeout. A completed start may still be waiting for the isolated launch worker or MCP discovery. `state.actual` reports `stopped`, `starting`, `running` or `unsafe`. Treat health readings as sampled observations. Tunnel readiness, discovered tool counts and remote invocation evidence are separate.

On `BUSY`, wait and refresh before deciding to retry. `OPERATION_FAILED` is intentionally generic and can carry the tunnel log path. Use `task.get`, `state` and `logs` to recover. Other protocol errors include `INVALID_REQUEST`, `INVALID_ARGUMENT`, `UNKNOWN_OPERATION`, `UNSUPPORTED_PROTOCOL`, `CONFIRMATION_REQUIRED`, `INTERACTIVE_REQUIRED`, `TASK_NOT_FOUND`, `INVALID_MANIFEST` and `INITIALIZATION_OR_PARSE_FAILED`.

Credential configuration and deletion remain interactive console operations using the existing DPAPI path. The API exposes only whether a credential is configured. Launch may open a separate console for the existing credential flow. Management is local and intended for same-user clients under the same Windows logon session. The per-deployment mutex coordinates service changes. The existing OpenAI launch mutex provides an additional transport guard. Use a disposable profile, runtime, and LOCALAPPDATA for development. Avoid sharing the production key, proxy settings, profile or tunnel binary with fixtures.

Discover the deployment with state.instance. Clients can send the returned instance key in the optional request field instance. See [instance isolation](instance-isolation.md).

## B5 version lifecycle candidate (maintenance branch)

The optional `version.install`, `version.verify`, `version.activate`, and `version.remove` operations extend the existing v1 JSON stdio protocol without changing the original operations. Discover support using `capabilities.operations`; do not send these operations to the stable v1.0.0 release or older clients.

- `version.install`: `{confirmed:true,revision,path,sha256}`. An independently trusted SHA-256 digest is mandatory. Installs a bounded, manifest-pinned ZIP into a new managed version directory, then atomically updates `management/versions.json`; does **not** start the version or modify the active selection. A checksum of an unknown package alone does not establish trust.
- `version.verify`: `{id}`, read-only. Returns `verified`, `modified`, or `unmanaged`. Mutable local permissions/root/profile are outside immutable payload verification; legacy P6 may be reported as unmanaged.
- `version.activate`: `{confirmed:true,revision,version,mode}`. Requires a known healthy running version. Checks target payload integrity and reuses the managed switch; then checks observed PID/version/mode, healthz/readyz and MCP discovery snapshot. If unsuccessful, attempts to restore the prior version, returning `UPGRADE_ROLLED_BACK` or `RECOVERY_FAILED`; callers must read actual state afterward. This does not prove remote-client invocation.
- `version.remove`: `{confirmed:true,revision,id}`. Deletes only an unused manager-installed version; rejects active, target, rollback, default, unknown, or reparse-point versions.

Additional structured error codes: `INVALID_PACKAGE`, `PACKAGE_HASH_MISMATCH`, `VERSION_EXISTS`, `VERSION_PROTECTED`, `VERSION_UNVERIFIED`, `UPGRADE_ROLLED_BACK`, `RECOVERY_FAILED`. The manager uses the existing per-instance mutex and current configuration Revision; tasks remain correlated with the request but are not retained indefinitely. See [version lifecycle contract](version-lifecycle.md) for the ZIP manifest, test scope, and limitations.


## File access mode

State adds configuration.accessModes keyed by version ID and fileAccess with actual, target and restartRequired fields. The observed access policy is null until a current engine process reports it. Target includes mode and the retained restricted allowedRoot. The engine reports its policy independently of the tool mode.

Send an access.set request with arguments version, mode (restricted or full), confirmed: true and the current revision. Full requires explicit local acknowledgment. Stop the target instance before changing access or the root, then start it again. Configuration revisions include accessModes. INVALID_ROOT identifies a rejected root, INVALID_ACCESS_MODE identifies a malformed mode, ACCESS_BUSY requires stopping the target and ACCESS_UNAVAILABLE identifies an unsupported instance. See [file access](file-access.md).