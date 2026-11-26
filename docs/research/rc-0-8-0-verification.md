# RC verification — v0.8.0 (`rebuildup.secrets` + `rebuildup.machines`, `secrets-remote-devices`)

Verification record for the v0.8.0 release candidate (Issue #167, final
ticket of the train). Fixed target:

- Code under test: `release-0-8-0` @ `09d3fa0b99f913af4933e0d0341714b809d79981`
  (plugins installed into the isolated session with
  `herdr plugin install … --ref release-0-8-0`; both resolved exactly
  `09d3fa0`. This document, the ledger/program sync, and any audit
  follow-ups land on top — no behavioral change after the verified SHA)
- herdr: `0.9.5` (protocol 22, real binary
  `~/.local/share/mise/installs/herdr/0.9.5/herdr`), Bun: `1.4.4`,
  git: `2.56.x`, infisical CLI: stubbed for sink tests (real-provider
  resolve evidence: `secrets-v1-live-verification.md`)
- Platform exercised: macOS (arm64)

## Environment

| Env | Host | Session | Isolation |
| --- | --- | --- | --- |
| macOS | local (arm64) | `verify167` | dedicated `XDG_CONFIG_HOME`/`XDG_STATE_HOME`/`XDG_DATA_HOME`/`HERDR_CONFIG_PATH` under `/var/tmp/herdr-plugin-167`, headless `herdr --session verify167 server`, all ambient `HERDR_*` unset for server/CLI calls |

The user's live session was never touched; the isolated session was
stopped and deleted after verification and `/var/tmp/herdr-plugin-167`
removed. For CLI invocations of the plugins themselves,
`HERDR_SOCKET_PATH` pointed at the isolated session socket and the
plugin config/state dirs resolved under the isolated XDG roots.

Environment notes (not plugin defects):

- Ambient `HERDR_*` env must be stripped for every call
  (`env -u HERDR_SOCKET_PATH -u HERDR_SESSION -u HERDR_PANE_ID -u
  HERDR_TAB_ID -u HERDR_WORKSPACE_ID -u HERDR_ENV -u
  HERDR_STARTUP_CWD -u HERDR_PLUGIN_CONFIG_DIR -u
  HERDR_PLUGIN_STATE_DIR`); the agent environment exports live-session
  vars (known hazard, issue #83).
- The mise `herdr` shim fails under XDG override; the real binary path
  was used throughout.
- Saved machines for the machines probe were seeded directly into the
  isolated `state/herdr/client/endpoints.json` (32-hex ids required by
  herdr): one `enabled:false`, one pointing at
  `nonexistent.invalid`. `herdr machine add` requires live SSH and was
  not used.

## Audit results (Issue #167 scope 1)

Boundary re-audit of `plugins/secrets` and `plugins/machines` against
ADR-0027 / ADR-0028 / `docs/contracts/{secrets,machines}-v1.md`:

- **secrets — value boundary: PASS.** Resolved values exist only in
  memory between `provider.ts` (`resolveSecret` → child stdout parse)
  and the two legal sinks: `run` child env (`cli.ts` `cmdRun`) and
  `inject` surface-create `env` params (`inject.ts` →
  `workspaceCreate`/`tabCreate`/`paneSplit`). `resolve`/`capability`/
  `config` emit metadata only — no `env`/value section exists in any
  output path; `inject` reports `env_names` only. No persistence:
  secrets plugin has no state writes at all (verified: state dir empty
  after live run). No argv leakage: the `infisical` spawn uses fixed
  argv (secret *name* only, never value); `tokenEnv` mapping forwards
  via `INFISICAL_TOKEN` env, never argv. Error paths
  (`classifyFailure`) truncate provider stderr to 300 chars of
  diagnostics — no value channel.
- **secrets — HERDR_* rejection: PASS.** `validateBinding`
  (`model.ts`) rejects env names matching `/^HERDR_/i` at declaration
  time; duplicate env names across bindings rejected in `config.ts`
  and per-invocation in `resolveAll`.
- **secrets — consent model: PASS.** No ambient env harvesting
  (provider child inherits caller env per ADR §1 — same trust domain);
  every action requires explicit `--binding`; no wildcard injection;
  `op://` refs rejected.
- **machines — read-only: PASS.** Only `capability`/`list`/`probe`;
  `mutation_commands: []` advertised. All remote access is
  `herdr machine list --json` + `herdr --machine <id> api snapshot` /
  `plugin list --json` (ADR-0020 transport). `STRIPPED_ENV` removes
  ambient `HERDR_*` from children. State file holds probe metadata
  only (timestamps, versions, reachability) under
  `HERDR_PLUGIN_STATE_DIR` with lock + atomic rename; no credential
  material anywhere.
- **Cross-plugin reads: PASS.** Neither plugin reads another plugin's
  state or internals; both consume only `packages/herdr-client` (the
  ADR-0013-pattern public surface is N/A — no cross-plugin CLI calls
  needed in v1).
- **Manifests/README: PASS.** Both `herdr-plugin.toml` declare
  `platforms = ["linux","macos","windows"]`, `min_herdr_version =
  "0.9.0"`, CLI-only (no actions/events/startup). README plugin table
  rows for `machines`/`secrets` match the shipped contracts.

No audit findings requiring fixes; no follow-up issues filed.

## Results

| # | Area | Method | Result |
| --- | --- | --- | --- |
| 1 | Quality gates | `bun run validate:fast` (typecheck + biome + `bun test`) at `09d3fa0`; full suite re-run as `bun test --timeout 30000` | PASS — tsc clean, biome clean (pre-existing FIXABLE style warnings only, non-blocking), **694 tests / 0 fail** (4065 expects, 42 files, ~289s). Known flake confirmed: default 5s timeout produced 1 unrelated `tests/git.test.ts` timeout under full-suite load; passes with `--timeout 30000` |
| 2 | Plugin install | `herdr plugin install rebuildup/herdr-plugins/plugins/{secrets,machines} --ref release-0-8-0 -y` in `verify167` | PASS — both resolved `09d3fa0`, enabled, config dirs under isolated XDG |
| 3 | machines `capability` | CLI in isolated env | PASS — contract `herdr-plugins.machines/v1` (draft), `read_only:true`, `mutation_commands:[]`, 3 commands, honest probe-state/plugin-surface taxonomies |
| 4 | machines `list` | 2 seeded saved machines | PASS — live `machine list --json` merged with `last_probe:null`; no probing on list |
| 5 | machines `probe --all` | disabled + nonexistent-host machines | PASS — `disabled` reported without any SSH attempt (`reachable:null`); `nonexistent.invalid` → `unreachable`/`remote_command_failed` with upstream SSH error preserved verbatim, exit 0, honest data. `ok`/`unsupported_remote`/`plugin_surface` paths covered by `tests/machines.test.ts` (22 tests) + prior live evidence (`machines-v1-live-verification.md`: real Ubuntu WSL probe `state:ok`, `server_version:0.9.5`, `protocol:22`, `plugin_surface:supported`) |
| 6 | machines state | `state.json` after probe | PASS — per-machine probe metadata persisted (lock+atomic rename path exercised); `list` re-run merges `last_probe` |
| 7 | secrets `capability --probe` | stub `infisical` on PATH (version + `*not found*` sentinel) | PASS — CLI detected (`0.45.14-fake`), `reachability.status:"ok"` via sentinel probe, bindings/invalid_bindings/credential_boundary metadata only |
| 8 | secrets `resolve` | `--binding alpha --binding missing` | PASS — per-binding statuses `resolved`/`unresolved`, exit 1 on partial failure; **zero occurrences of the fake value in stdout** (grep-verified) |
| 9 | secrets `run` (sink 1) | `--binding alpha --binding beta -- sh script` | PASS — child env received `FAKE167-ALPHA_KEY`/`FAKE167-BETA_KEY` (`printenv`-equivalent echo); resolution failure → `resolution_failed` stderr, exit 1, wrapped command never spawned |
| 10 | secrets `inject` workspace (sink 2) | `--surface workspace --label secrets-verify167` → pane `w1:p1` | PASS — `ok`, `env_names:["HP167_ALPHA","HP167_BETA"]` only; in-pane `printenv` returned both fake values — env delivered through protocol-22 surface-create `env` params |
| 11 | secrets `inject` tab | `--surface tab --workspace w1` → pane `w1:p2`/`tab w1:t2` | PASS — `env_names:["HP167_ALPHA"]`; in-pane `printenv HP167_ALPHA` → `FAKE167-ALPHA_KEY` |
| 12 | secrets persistence/leak audit | state dir + output scan after all commands | PASS — `state/herdr/plugins/rebuildup.secrets/` empty (plugin writes no state); no `FAKE167-*` string in any plugin stdout/stderr/config |
| 13 | Regression | `herdr plugin list` on `verify167` | PASS — both plugins enabled, no cross-plugin interference; live session untouched throughout |

Real-Infisical-provider resolve evidence (real `resolve` against
`secrets.rebuildup.dev`, value never emitted) is in
`secrets-v1-live-verification.md` (#160); the RC re-verifies the same
code path with a deterministic stub so no credential material entered
this verification at all.

## Defects / observations

1. **5s default test timeout flake** — `bun test` (default timeout)
   timed out once on `tests/git.test.ts > mutations > unstage --all
   and per-path restore the index` under full-suite load; the same
   suite passes clean at `--timeout 30000` (694/694). Environmental,
   consistent with prior RC notes; CI should use the 30s timeout.
2. **Biome `useTemplate` FIXABLE diagnostics** — pre-existing style
   warnings in `plugins/conversations`/`tests/conversations-t2`; lint
   exits 0, unchanged by this ticket.
3. `pane.split` env delivery remains contract-tested only (fake
   socket); `workspace`/`tab` live-verified here and in #160's record —
   same `env` param path in protocol 22.

## Verdict

**READY FOR APPROVAL on macOS.** Both plugins verified end-to-end on
real herdr 0.9.5 in isolated session `verify167` at `release-0-8-0` @
`09d3fa0`: GitHub-install path, machines read-only inventory
(capability/list/probe incl. honest `disabled`/`unreachable`), secrets
boundary (metadata-only resolve, per-binding failure honesty, both
legal sinks delivering values into real pane environments, zero
persistence/leakage). Boundary audit found no violations of ADR-0027 /
ADR-0028. Residuals (unchanged from feature verifications): real
Infisical resolve was evidenced in #160's record rather than re-run
here by design; `pane.split` sink is contract-test-only; Linux/Windows
official-install verification not exercised this round.

Cleanup: isolated session `verify167` stopped and deleted;
`/var/tmp/herdr-plugin-167` removed; user's live session, agents, and
worktrees untouched.
