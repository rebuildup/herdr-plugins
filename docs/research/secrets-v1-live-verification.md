# Verification evidence — rebuildup.secrets v1 (Issue #160)

Live verification of `herdr-plugins.secrets/v1` against an **isolated
named herdr session** (`verify160`, socket
`/var/tmp/herdr-160/xdg-config/herdr/sessions/verify160/herdr.sock`,
started via `herdr --session verify160` in a PTY with dedicated
`XDG_CONFIG_HOME`/`XDG_STATE_HOME`/`XDG_DATA_HOME`/`HOME` under
`/var/tmp/herdr-160/` and all `HERDR_*` vars unset; stopped via
`herdr server stop` + `herdr session delete` afterward). The user's
live sessions were never touched; plugin config/state lived under
`/var/tmp/herdr-160/plugin-{config,state}`.

Environment: herdr 0.9.5 (protocol 22), infisical CLI 0.45.14
(mise), Bun 1.4.4.

## Provider resolution — real Infisical (metadata only)

Config pointed at the canonical self-host
(`https://secrets.rebuildup.dev/api`), project `dotfiles`
(`d4c2fc09-…`), bindings `real-probe` → `infisical:dev:/:DEEPSEEK_API_KEY`
and `real-missing` → a guaranteed-absent name.

```bash
bun run src/cli.ts resolve --binding real-probe --binding real-missing
```

Result: `real-probe → resolved`, `real-missing → unresolved`
(`secret … not found at dev:/`), exit 1 — per-binding honest status,
**no value in stdout/stderr** (verified: output contains only names,
env names, refs, statuses). This proves end-to-end auth (user login
profile) + reference resolution against the real provider while
keeping the value in memory only.

`capability --probe` against the same config: CLI detected
(`infisical version 0.45.14`), `reachability.status: "ok"` — the
sentinel probe (`__REBuildup_SECRETS_PROBE_000__`) got a structured
`*not found*` answer, proving reachability + auth without touching a
real secret.

## Sink 1 — `run` child env (fake provider)

Stub `infisical` on PATH returned `FAKE160-<name>` values. Config
bindings `probe-alpha`/`probe-beta` → env `HP160_ALPHA`/`HP160_BETA`.

```bash
bun run src/cli.ts run --binding probe-alpha -- sh -c 'echo GOT:$HP160_ALPHA'
# → GOT:FAKE160-ALPHA_KEY   (exit 0)
```

Resolution failure (`--binding` on a `*not found*` name) → stderr
`resolution_failed` JSON, exit 1, wrapped command never spawned
(contract-tested with a `touch` marker).

## Sink 2 — surface-create `env` (fake provider, real herdr)

```bash
bun run src/cli.ts inject --binding probe-alpha --binding probe-beta \
  --surface workspace --label secrets-verify
# → ok, pane_id w2:p1, env_names ["HP160_ALPHA","HP160_BETA"]

bun run src/cli.ts inject --binding probe-alpha --surface tab --workspace w2
# → ok, pane_id w2:p2, tab_id w2:t2
```

In-pane verification via `herdr pane send-text`/`send-keys`/`read`:

- `w2:p1` (workspace root): `printenv HP160_ALPHA` → `FAKE160-ALPHA_KEY`;
  `printenv HP160_BETA` → `FAKE160-BETA_KEY`.
- `w2:p2` (tab root): `printenv HP160_ALPHA` → `FAKE160-ALPHA_KEY`.

Values reached the pane process env through the protocol-22 `env`
param exactly as designed; plugin stdout reported env *names* only.
`HERDR_PLUGIN_STATE_DIR` remained empty — nothing persisted.

## Contract tests

`tests/secrets.test.ts` — 17 tests: ref grammar, binding validation
(incl. `HERDR_*` rejection, `op://` rejection), config load/validation,
`capability`/`resolve`/`run`/`inject`/`config` against a stub
`infisical` + fake herdr unix socket. Asserts per-binding statuses
(`resolved`/`unresolved`/`provider_unreachable`/`auth_missing`), that
fake values never appear in plugin stdout/stderr for `resolve`/`inject`/
`capability`, that `run` delivers values to the child env, and that
resolution failure creates no surface. `bun run validate:fast`:
typecheck + lint + **672 tests, 0 fail**.

## Residual / not verified

- **No real secret value was injected into a live pane** — deliberate:
  real-provider verification used `resolve` (value discarded) and the
  sink tests used obviously-fake values, so no credential ever entered
  pane scrollback, plugin state, or logs.
- `pane.split` env delivery is contract-tested against a fake socket;
  live-verified surfaces were `workspace.create` and `tab.create`
  (same `env` param path in herdr protocol 22).
- Non-macOS herdr sessions; Windows named-pipe transport (shared
  `herdr-client` code path, unchanged).
- Machine Identity / OIDC auth flows — the plugin inherits whatever
  the caller exported (`INFISICAL_TOKEN`, login profile); no
  plugin-side identity management in v1 (ADR-0027 §1).
