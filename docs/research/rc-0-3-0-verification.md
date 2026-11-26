# RC verification — v0.3.0 (`rebuildup.projects` Projects + Scripts)

Verification record for the v0.3.0 release candidate. Fixed target:

- Ticket branch HEAD (code under test): `b05cfb7316c77e359bb98bd3cf69eeb63a5c8866`
  (branch `69`, on top of `release-0-3-0` @ `c09af2b`; this document and
  the ledger/PR sync land as docs-only commits on top)
- herdr: `0.9.5` (protocol 22), Bun: `1.4.4`, git: `2.56.1`
- Platform exercised: macOS (arm64)

## Environment

| Env | Host | Session | Isolation |
| --- | --- | --- | --- |
| macOS | local (arm64) | `plugin-rc03` | dedicated `XDG_CONFIG_HOME`/`XDG_STATE_HOME` under `/var/tmp/herdr-plugin-rc03`, headless `herdr server`, clean `PATH` (direct mise bins, no shims) |

The user's live sessions were never intentionally touched; the isolated
session was stopped and deleted after verification. Evidence retained at
`/var/tmp/herdr-plugin-rc03`.

Environment notes (not plugin defects):

- **Ambient `HERDR_SOCKET_PATH` wins over `--session`.** This agent
  environment exports `HERDR_SOCKET_PATH` pointing at the user's live
  socket; `resolveSocketPath` gives the env override precedence, so the
  first `scripts run` smoke test executed against the LIVE session
  (workspace `wKW`, since closed). All subsequent verification ran with
  `HERDR_SOCKET_PATH`/`HERDR_PANE_ID`/`HERDR_TAB_ID`/`HERDR_WORKSPACE_ID`
  unset. Agents invoking plugin CLIs from inside a herdr pane inherit
  the same hazard — filed as follow-up issue #83.
- **Headless panes need `SHELL`.** The first `herdr server` was started
  via `env -i` without `SHELL`; spawned panes exited immediately
  (recorded honestly as `unknown`, never fabricated). Restarting the
  server with `SHELL=/bin/zsh` fixed pane spawning. Operators running
  headless servers should ensure `SHELL` is set.
- `env -i` + direct binary `PATH` was used throughout (mise shims error
  on the repo's untrusted `mise.toml` when cwd is inside a checkout).

## Results

| # | Area | Method | Result |
| --- | --- | --- | --- |
| 1 | Quality gates | `bun install`, `bun run validate:fast` at `b05cfb7` (`validate:integration` is the same entry) | PASS — tsc clean, biome clean (pre-existing FIXABLE warnings only), **168 tests / 0 fail** |
| 2 | Plugin install | `herdr plugin install rebuildup/herdr-plugins/plugins/projects --ref 69` → resolved exactly `b05cfb7`; git `@release-0-2-0`, inbox `@main` for regression | PASS |
| 3 | Capability | `capability` → contract `herdr-plugins.projects/v1`, **version 0.3.0**, 13 commands, `read_only:false`, `mutation_commands` enumerated (12) | PASS |
| 4 | Registry CRUD | `register` (derived id, `--title`, `--id`), `list`, `show`, `update --repo-add/--repo-remove`, `repos add/remove`, `pin`/`unpin`, `archive`/`unarchive` (archived hidden from `list`, retained via `show`) | PASS |
| 5 | Repo membership + live inspect | `repos list` → stored `root`/`remote`/`added_at` + live `branch`/`dirty`/`has_submodules`; remote identity `github.com/RC/SmokeRepo` (scp remote, host lowercased, **path case preserved**); unreachable-member `null` fields + `skipped` covered by unit tests | PASS |
| 6 | `scripts list` | `t3.json` fixture (3 scripts) resolved with `source:"t3.json"`; repo-path target and `project_id` linkage verified; empty-script repo → `[]` | PASS |
| 7 | `scripts run` success | `smoke` (`echo`) → dedicated workspace+pane, `shell_family:"sh"`, `shell_source:"process_info"`, marker exit 0 → `success`, `exit_code:0`, bounded log stored, `script_smoke` metadata token visible via `pane list` | PASS |
| 8 | `scripts run` failure | `failer` (`( exit 3 )`) → `failed`, `exit_code:3`, log tail captured | PASS |
| 9 | `scripts stop` + results/logs | `slowpoke` (`sleep 60`) left `running`; `scripts stop <run-id-prefix>` → ctrl+c → `stopping` → confirmed `stopped` (pane-exit evidence, `stop_requested_at` set); `scripts results` newest-first honest states; `scripts logs` serves stored tail | PASS |
| 10 | Repo selection | 2-repo project `scripts run` without `--repo` → `repo_ambiguous` (member list carried); `--repo` to a repo with no scripts → `unknown_script` | PASS |
| 11 | `discover` | session snapshot pane cwds → repo found with `registered_project_id:"repo-a"`; non-git cwds reported in `skipped` (unit-tested) | PASS |
| 12 | Settings | `settings set/get/unset` round-trip; allow-list enforced (`settings_key_not_allowed`); **corrupt file reads `{}` and next `set` rewrites wholesale** — verified live, matches documented policy | PASS |
| 13 | Error paths | non-git register → `not_a_repo`; unknown project → `project_not_found`; missing args → usage exit 2; duplicate repo → `repo_already_registered` (unit-tested) | PASS |
| 14 | Inbox regression | `rebuildup.inbox` capability/list on the same isolated session — unaffected | PASS |
| 15 | Git regression | `rebuildup.git` capability + `status w1:p1` against a projects-created pane (cwd=repo-a) → correct branch/changes (`unstaged:1` = fixture edit) | PASS |

## Audit items (#65 → #69)

1. **`has_submodules` failure-vs-absent** — FIXED. `inspectRepo` now
   returns `boolean | null`: non-empty `git submodule status` output →
   `true`, empty → `false`, non-zero exit or probe failure (timeout /
   git_missing) → `null` (unknown). Branch/dirty still report; a probe
   failure never guesses `false`. Covered by a git-shim unit test.
   Contract + spec updated.
2. **`loadSettings` corrupt → silent `{}`** — SPECIFIED, no code
   change. Corrupt settings read as empty (overrides are
   non-authoritative); the next `settings set`/`unset` rewrites the
   file wholesale — corrupt bytes are never partially merged and no
   `settings_corrupt` error is raised, matching the `runs.json`
   policy. Verified live; documented in spec + contract.
3. **`normalizeRemoteUrl` case sensitivity** — SPECIFIED + two small
   fixes. Host is lowercased and non-default ports are now kept
   (`parsed.host`); **path case is preserved verbatim** — folding it
   would merge distinct repos on case-sensitive forges, and a missed
   grouping is safer than a false merge (consumers compare the
   identity exactly). Rule documented in spec + contract.
   Additionally fixed: scheme'd URLs (`ssh://git@host:2222/org/repo`)
   previously matched the scp-like branch first and misparsed as
   `host/2222/org/repo`; URL parsing now runs first.

## Defects / observations

1. **Ambient `HERDR_SOCKET_PATH` overrides `--session`** (environment,
   not plugin code): an agent pane's exported socket env silently
   retargets plugin CLI socket calls — including `scripts run` pane
   creation — at the wrong session. Mitigated in verification by
   unsetting the env; follow-up issue #83 filed to warn or
   re-prioritize explicit flags.
2. **Bare `exit` in a script command kills the execution pane's
   interactive shell** before the marker prints → run reconciles to
   `unknown` (honest, never fabricated). Documented in spec + contract;
   exit-code probes should use a subshell.
3. **Headless `herdr server` without `SHELL`** spawns panes that exit
   immediately; runs record `unknown`/`running` honestly. Environment
   caveat, documented above.
4. Disk pressure (ENOSPC) interrupted one server restart during
   verification; retried successfully. Environmental only.

## Verdict

**READY FOR APPROVAL on macOS.** All `herdr-plugins.projects/v1`
surfaces verified end-to-end on real herdr 0.9.5 in an isolated
session at the fixed RC SHA (`b05cfb7`): GitHub-install path,
registry CRUD/membership/settings, `repos list` live inspection with
the new `has_submodules` tri-state, `scripts list/run/stop/results/
logs` including success/failed/stopped/unknown outcomes, repo
ambiguity and structured error paths, settings-corrupt policy, and
inbox/git regressions. The three #65 audit items are converged (one
code fix, two spec clarifications + two small `normalizeRemoteUrl`
fixes). Linux/Windows official-install verification was NOT exercised
in this round (single-host environment) — tracked as residual before
`release-0-3-0 → main`; unit coverage is platform-neutral and the
Windows-specific paths (cmd/powershell wrappers) are contract-tested.

Cleanup: isolated session `plugin-rc03` stopped and deleted; the one
accidental live-session workspace (`wKW`) was closed immediately after
detection. User's live session otherwise untouched.
