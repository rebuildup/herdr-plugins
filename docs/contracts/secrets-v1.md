# Contract `herdr-plugins.secrets/v1`

Secret reference resolution and env injection for the
`rebuildup.secrets` herdr plugin (Issue #160; boundary ADR-0027 —
successor to the ADR-0014/0015/0018 credential-boundary family).
Conventions match the other plugin contracts: single JSON document on
stdout, diagnostics on stderr, exit 0 success / 1 handled error /
2 usage.

**Value guarantee.** No command in this contract ever returns, logs,
persists, or places in argv a resolved secret value. `resolve` is
metadata-only; there is deliberately no eval/`--emit-env` escape hatch
in v1 (adding one requires a successor ADR).

## Provider

- `infisical` only. References are `infisical:<env>:<path>:<secret>`.
- Resolution uses the official `infisical` CLI
  (`secrets get … -o json`) per invocation; auth is inherited from the
  caller's environment (`infisical login` profile, `INFISICAL_TOKEN`,
  or Machine Identity token exported by the user). The plugin stores no
  credentials.
- `op://` and other providers: rejected (`config_error` at binding
  validation).

## Config (`config.json`, plugin config dir)

```json
{
  "infisical": {
    "domain": "https://secrets.rebuildup.dev/api",
    "projectId": "optional-default-project-id",
    "tokenEnv": "optional-env-var-holding-a-token"
  },
  "bindings": [
    {
      "name": "deepseek",
      "env": "DEEPSEEK_API_KEY",
      "ref": "infisical:dev:/shared:DEEPSEEK_API_KEY",
      "projectId": "optional-per-binding-override"
    }
  ]
}
```

- `domain` defaults to the canonical self-host
  `https://secrets.rebuildup.dev/api`; managed-Cloud domains produce a
  `config_warnings` entry.
- Binding `env` must be a POSIX env name and must not match `HERDR_*`
  (any case). `projectId` resolves binding → `infisical.projectId`;
  missing → `config_error` at selection time.
- Invalid bindings are reported in `invalid_bindings` and are not
  selectable.

## Commands

### `capability [--probe] [--infisical-bin <path>]`

```json
{
  "contract": "herdr-plugins.secrets/v1",
  "command": "capability",
  "plugin": "rebuildup.secrets",
  "version": "0.1.1",
  "provider": {
    "name": "infisical",
    "domain": "https://secrets.rebuildup.dev/api",
    "cli": { "bin": "infisical", "available": true, "version": "infisical version 0.45.14" },
    "project_id_configured": true,
    "reachability": { "status": "not_checked" }
  },
  "bindings": [{ "name": "…", "env": "…", "ref": "…", "projectId": "…" }],
  "invalid_bindings": [],
  "config_warnings": [],
  "credential_boundary": { "…": "docs/adr/0027-…" },
  "commands": ["capability", "resolve", "run", "inject", "config"],
  "generated_at": "…"
}
```

`--probe` resolves a guaranteed-absent sentinel secret
(`__REBuildup_SECRETS_PROBE_000__`) to classify reachability/auth
without touching a real value: `reachability.status` is `ok` (server
answered `*not found*`), `unresolved`, `provider_unreachable`,
`auth_missing`, or `provider_error`.

### `resolve --binding <name>...`

Resolves each named binding against the provider, discards the values,
and reports per-binding status. stdout:

```json
{
  "contract": "herdr-plugins.secrets/v1",
  "command": "resolve",
  "ok": false,
  "bindings": [
    { "name": "alpha", "env": "ALPHA_KEY", "ref": "infisical:dev:/:ALPHA_SECRET", "status": "resolved" },
    { "name": "missing", "env": "MISSING_KEY", "ref": "infisical:dev:/:MISSING_SECRET", "status": "unresolved", "detail": "secret MISSING_SECRET not found at dev:/" }
  ]
}
```

Exit 0 iff every requested binding resolved; otherwise 1. Unknown or
invalid binding names fail before any provider call (`config_error` on
stderr).

### `run --binding <name>... -- <cmd> [args...]`

Resolves the named bindings, then spawns `<cmd>` with
`env = process.env + resolved bindings` and inherited stdio (sink 1 —
child process environment, equivalent to `infisical run -- <cmd>`).
The plugin writes nothing to the child's stdout itself.

- Any binding failure → stderr JSON
  `{ok:false, error:{kind:"resolution_failed", bindings:[…per-binding status…]}}`,
  exit 1, command never starts.
- Child exit code propagates; a signal terminates the plugin with the
  same signal. Spawn failure → `spawn_failed` on stderr, exit 1.

### `inject --binding <name>... --surface <workspace|tab|pane> [opts]`

Resolves the named bindings, then creates a herdr surface with the
resolved map in the creation `env` params (sink 2 — protocol-22
`env: HashMap` on `workspace.create` / `tab.create` / `pane.split`).

Surface options: `--workspace <id>` (tab/pane target workspace),
`--target-pane <id>` + `--direction right|down` + `--ratio <n>`
(pane split), `--cwd`, `--label`, `--focus`.

stdout on success:

```json
{
  "contract": "herdr-plugins.secrets/v1",
  "command": "inject",
  "ok": true,
  "bindings": [ { "name": "…", "env": "…", "ref": "…", "status": "resolved" } ],
  "injected": {
    "surface": "workspace",
    "pane_id": "…", "tab_id": "…", "workspace_id": "…",
    "env_names": ["ALPHA_KEY", "BETA_KEY"]
  }
}
```

`env_names` lists injected names only — never values. Any binding
failure → same `resolution_failed` stderr shape as `run`, exit 1,
**no surface is created**. Herdr RPC failures → `error.message` on
stderr, exit 1.

### `config [--init] [--config-dir <dir>]`

Prints the effective config as metadata (domain, projectId, tokenEnv
*name*, binding declarations) plus `invalid_bindings`/`warnings`.
`--init` writes a starter `config.json` (canonical domain, empty
bindings) and refuses to overwrite (`config_error`, exit 1).

## Status taxonomy

| `status` | Meaning |
| --- | --- |
| `resolved` | Provider returned a value this invocation (value discarded for `resolve`, routed to a sink for `run`/`inject`). |
| `unresolved` | Reference well-formed but secret absent (`*not found*` sentinel) or provider returned no entry. |
| `provider_unreachable` | CLI missing, spawn failure, timeout, or network/5xx-class failure. |
| `auth_missing` | Provider rejected credentials (401/403/login-class stderr). |
| `provider_error` | Non-zero exit or unparseable output not matching the above. |
| `config_error` | Binding/ref/env-name/projectId declaration problems; selected binding invalid. |

## Errors

stderr carries `{contract, ok:false, error:{code, kind?, message, …}}`.
`code` is `usage` (exit 2) or `error` (exit 1); `kind` is one of
`config_error`, `resolution_failed`, `spawn_failed` where applicable.
Error details never contain secret values — provider stderr/stdout
are never echoed verbatim. Failure `detail` fields carry only
classified, sanitized diagnostics (the exit code or signal
termination); provider output is used internally for status
classification (`provider_unreachable` / `auth_missing` /
`provider_error`) but is not transcribed into any emitted envelope.
`capability`'s `cli.detail` likewise reports only the `--version`
exit code, never provider output.

## Non-goals (v1)

- `op://` / other providers, wildcard or ambient-env injection,
  project-file (`t3.json`-style) auto-discovery, eval-style emission,
  value caching, secret listing, and any durable plugin state.
