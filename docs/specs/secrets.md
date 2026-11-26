# Spec: rebuildup.secrets (Issue #160; parent #34/#22; release-0-8.0)

Secret reference resolution and env injection for herdr. Contract:
`herdr-plugins.secrets/v1` (`docs/contracts/secrets-v1.md`). Boundary:
ADR-0027 (`docs/adr/0027-secrets-env-injection-boundary.md`), successor
to the ADR-0014/0015/0018 credential-boundary family. Provider policy:
the binding `secrets-management` skill (Infisical canonical, self-host
`https://secrets.rebuildup.dev`).

## Purpose

Give consumers (project scripts, controls/handoff launch surfaces,
textgen key resolution, user shells) one contract to resolve declared
secret *references* at point of use and inject them into process
environments — without the plugin ever holding, persisting, logging, or
emitting secret values.

## Provider scope (ADR-0027 §1)

- **Infisical only in v1.** Reference grammar:
  `infisical:<env>:<path>:<secret>` — four colon-separated fields;
  `<path>` is an absolute folder path (`/` = root, single slashes);
  `<env>`/`<secret>` are single segments `[A-Za-z0-9][A-Za-z0-9_.-]*`.
- `op://` and every other provider are rejected at parse time. A
  successor ADR extends the provider enum if needed.
- Resolution shells out to the official `infisical` CLI per invocation:
  `infisical secrets get <secret> --env <env> --path <path>
  --projectId <id> --domain <domain> -o json --silent`. The `-o json`
  output's `secretValue === "*not found*"` sentinel maps to
  `unresolved`; non-zero exits are classified into
  `provider_unreachable` / `auth_missing` / `provider_error` from
  stderr heuristics. Values are never placed in argv — the CLI is
  spawned with fixed argv and auth material flows only through the
  inherited environment (plus an optional declared `tokenEnv` →
  `INFISICAL_TOKEN` mapping).
- The plugin stores **no** Infisical tokens, service tokens, or
  machine-identity credentials. Auth is whatever the caller already
  has: `infisical login` profile, `INFISICAL_TOKEN`, or a Machine
  Identity token the user exported. Per skill §7, workers get only the
  capability they were granted — the plugin adds nothing.
- `infisical.domain` defaults to the canonical
  `https://secrets.rebuildup.dev/api`; pointing at managed Cloud
  (`app.infisical.com`) produces a config warning (skill §5: no
  implicit vendor-default fallback, no second canonical store).

## Consent model (ADR-0027 §2)

Two explicit layers; nothing is implicit.

1. **Declaration** — `config.json` under the herdr-provided plugin
   config dir (`HERDR_PLUGIN_CONFIG_DIR`, resolved equivalently for
   external clients via `pluginDirs`). Holds `infisical.domain`,
   optional `infisical.projectId`/`tokenEnv`, and `bindings[]`:
   `{name, env, ref, projectId?}`. No wildcards, no "inject
   everything", no project-file auto-discovery — the plugin config dir
   is the single declaration point.
2. **Invocation** — every action names bindings with repeated
   `--binding <name>`; `capability`/`config` expose metadata only.

Binding validation at load:

- `name`: `[A-Za-z0-9][A-Za-z0-9_.-]{0,63}`, unique.
- `env`: POSIX env name `[A-Za-z_][A-Za-z0-9_]*`; **`HERDR_*` (any
  case) is rejected** — plugins must not shadow herdr session context.
  Duplicate `env` targets across bindings are rejected.
- `ref`: must parse as `infisical:<env>:<path>:<secret>`.
- Invalid bindings are collected into `invalid_bindings` (never fatal
  to the whole config, never usable by name); selecting one is a
  structured `config_error`.

Ambient environment is never harvested: the plugin does not scan
`process.env` for secret-shaped variables and never *adds* undeclared
values. `run` forwards the caller's own environment to the wrapped
command (same trust domain as running it directly — equivalent to
`infisical run`).

## Transit boundary (ADR-0027 §3)

A resolved value has exactly two legal sinks:

1. **Child process environment** — `run --binding … -- <cmd>` spawns
   the command with `{...process.env, ...resolvedEnv}` and inherited
   stdio; the plugin's own stdout stays clean for scripting.
2. **herdr surface-creation `env` params** — `inject --surface
   workspace|tab|pane` calls `workspace.create` / `tab.create` /
   `pane.split` (protocol 22 `env: HashMap`) with the resolved map.
   `agent.start` accepts no env, so surface-create is the only
   herdr-side injection point.

Rules:

- **Never persisted** — no config/state/log/cache writes of values;
  resolution is per-invocation, no TTL cache.
- **Never emitted** — `resolve` reports `{name, env, ref, status}`
  metadata only; there is no `--emit-env`/eval escape hatch in v1.
- **Never argv'd** — provider CLI argv is fixed; values move via
  stdout→memory→sink only.
- **Sink honesty** — `inject` reports created surface ids and env
  *names* only. Values transit the herdr server process and the target
  pane's process env by design; the plugin claims no more and extends
  no further (no `agent.start` args, prompts, titles, metadata).
- **Failure honesty** — per-binding structured statuses
  (`resolved`/`unresolved`/`provider_unreachable`/`auth_missing`/
  `provider_error`/`config_error`); partial multi-binding resolution
  reports each binding and never fabricates all-or-nothing success. No
  fallback to ambient env, config key files, or another provider.

## Commands

| Command | Description |
| --- | --- |
| `capability [--probe]` | Contract/plugin/provider metadata: CLI presence+version, domain, per-binding declarations, optional sentinel-secret reachability probe (`--probe`). Never values. |
| `resolve --binding <name>...` | Per-binding resolution check; reports status metadata only, discards values. Exit 0 iff all resolved. |
| `run --binding <name>... -- <cmd> [args]` | Wrapped execution: child env = caller env + resolved bindings. Any resolution failure → structured stderr error, command never starts. Exit code/signal propagates. |
| `inject --binding <name>... --surface <kind>` | Creates a herdr surface with `env` params. `--surface workspace` (default new workspace) / `tab` (`--workspace` optional) / `pane` (`--direction`, `--target-pane`, `--workspace`, `--ratio`). Surface opts `--cwd --label --focus` shared. |
| `config [--init]` | Print redacted config + validation warnings; `--init` writes a starter `config.json` (refuses overwrite). |

Common flags: `--session`, `--socket`, `--timeout`, `--config-dir`,
`--infisical-bin` (provider binary override for tests/non-PATH
installs). Single JSON document on stdout (except `run`, which
inherits child stdio); diagnostics on stderr; exit 0/1/2.

## State

None. The plugin keeps no durable state — `config.json` is the only
file, under the herdr-provided config dir. No `[[actions]]`/`[[events]]`/
`[[startup]]` in the manifest: every operation is an explicit CLI
invocation, so a plugin failure can never wedge herdr's event pipeline.

## Relationship to existing credential surfaces

- textgen API generators (ADR-0018-textgen) keep `<config>/keys/<id>.key`
  in v1; offering Infisical as an additional key source would be a
  textgen-contract amendment.
- usage quota/hub credentials (ADR-0014/0015) are provider-owned
  artifacts read in-process — a different credential class; secrets
  bindings do not merge with them.
