# Plugin lifecycle verification — Issue #170 (release-safety gate)

End-to-end plugin lifecycle verification for **all 14 plugins** on an
**isolated named herdr session**. Code under test: `release-0-8-0` @
`83c4b372d947f62161559e433edb2335487528b5` (worktree
`/Users/rebui/work/herdr-plugin-170`, branch `170-plugin-lifecycle`).
herdr `0.9.5` (protocol 22, real binary
`~/.local/share/mise/installs/herdr/0.9.5/herdr`), Bun `1.4.4`, macOS
arm64. The user's live session was never touched (see Isolation).

## Isolation

| Env | Value |
| --- | --- |
| Session | `verify170` (dedicated; deleted afterwards) |
| Socket | `/var/tmp/herdr-plugin-170/config/herdr/sessions/verify170/herdr.sock` |
| XDG roots | `XDG_CONFIG_HOME`/`XDG_STATE_HOME`/`XDG_DATA_HOME` + `HERDR_CONFIG_PATH` all under `/var/tmp/herdr-plugin-170/` |
| Server | headless `herdr --session verify170 server`, ambient `HERDR_*` stripped via `env -i` |
| CLI calls | wrapper exporting the isolated XDG roots and passing `HERDR_SOCKET_PATH=<verify170 socket>` after `env -u` of every ambient `HERDR_*` var (`HERDR_SOCKET_PATH`, `HERDR_PANE_ID`, `HERDR_WORKSPACE_ID`, `HERDR_TAB_ID`, `HERDR_SESSION`, `HERDR_PLUGIN_CONTEXT_JSON`, `HERDR_ENV`, `HERDR_BIN_PATH`, `HERDR_STARTUP_CWD`, `HERDR_PLUGIN_CONFIG_DIR`, `HERDR_PLUGIN_STATE_DIR`) |
| Plugin state | resolved under `/var/tmp/herdr-plugin-170/state/herdr/plugins/<id>/`; config under `.../config/herdr/plugins/config/<id>/` |

Post-run audit: the live state dir
(`~/.local/state/herdr/plugins/`) contains only pre-existing live-session
files (session keys are the live `default`/`ht3*` sockets; no `verify170`
key anywhere). Live plugin registry `~/.config/herdr/plugins.json`
untouched (XDG override). Session `verify170` stopped, deleted, and
`/var/tmp/herdr-plugin-170` removed.

## Plugins under test (all at `release-0-8-0` @ `83c4b37`)

| Plugin id | Dir | Version | Source used |
| --- | --- | --- | --- |
| rebuildup.artifacts | artifacts | 0.2.0 | local link |
| rebuildup.automations | automations | 0.7.0 | local link |
| rebuildup.checkpoints | checkpoints | 0.4.0 | local link |
| rebuildup.controls | controls | 0.6.0 | local link |
| rebuildup.conversations | conversations | 0.5.0 | local link |
| rebuildup.git | git | 0.2.0 | local link |
| rebuildup.handoff | handoff | 0.6.0 | local link |
| rebuildup.inbox | inbox | 0.1.0 | local link → GitHub install → link (both paths exercised) |
| rebuildup.machines | machines | 0.1.0 | local link |
| rebuildup.mcp | mcp | 0.7.0 | local link |
| rebuildup.projects | projects | 0.3.0 | local link |
| rebuildup.secrets | secrets | 0.1.0 | local link |
| rebuildup.textgen | textgen | 0.6.0 | local link |
| rebuildup.usage | usage | 0.5.0 | local link |

Local install method: `herdr plugin link <abs path to plugins/<name>>`
(the documented local-source path; `herdr plugin install` accepts only
`OWNER/REPO[/SUBDIR]` GitHub sources). GitHub parity was verified on
`rebuildup.inbox`: `herdr plugin install
rebuildup/herdr-plugins/plugins/inbox --ref release-0-8-0 -y` resolved
exactly `83c4b37` — identical to the local worktree HEAD.

## Results

| # | Check | Method | Result |
| --- | --- | --- | --- |
| 1 | Local install ×14 | `plugin link` each `plugins/<name>` | PASS — all returned `plugin_linked`, `enabled:true`, correct manifest/id/version; `plugin list` shows 14 enabled, zero name collisions |
| 2 | GitHub install | `plugin install …/inbox --ref release-0-8-0 -y` (after `unlink`) | PASS — resolved `83c4b37` exactly, enabled, clone under isolated `github-installations/` |
| 3 | Collision guard | `plugin install` (GitHub) while inbox was linked | PASS (honest refusal) — `plugin rebuildup.inbox is already linked from a local path; uninstall/unlink it before installing from GitHub` |
| 4 | `plugin list` / registry persistence | list after link-all, after server stop+start | PASS — 14 enabled both times; registry in isolated `config/herdr/plugins.json` survives restart |
| 5 | CLI smoke ×14 | `bun run src/cli.ts capability` per plugin in isolated env | PASS — all 14 exit 0, contract JSON emitted |
| 6 | Read-command smoke | per-plugin read commands (see table below) | PASS — all exit 0 with contract JSON |
| 7 | Pane-context action | `plugin action invoke status --plugin rebuildup.git` on focused pane `w1:p1` | PASS — dispatched with `HERDR_PLUGIN_CONTEXT_JSON` context, git status JSON returned, `plugin log` shows `succeeded` exit 0 |
| 8 | Event hooks | created workspace/tab/pane in verify170 | PASS — `rebuildup.automations` `[[events]]` fired on `workspace.created`, `tab.created`, `pane.created`, `*.focused` — all `succeeded` exit 0 in `plugin log` |
| 9 | Startup hook | server restart with plugins registered | PASS — `rebuildup.inbox` `[[startup]] reconcile` ran at boot, `succeeded` exit 0 (only plugin declaring `[[startup]]`; others' manifests explicitly declare none) |
| 10 | Reinstall same version | `plugin link` ×14 again; `plugin update rebuildup.inbox -y` | PASS — re-link idempotent (`plugin_linked`, still enabled); update → `already up to date` exit 0 |
| 11 | `plugin update` honesty | bare `plugin update` (non-TTY, no `-y`) | PASS — `plugin update requires --yes when stdin is not interactive`; `update` with no GitHub plugins → `No GitHub-managed plugins installed` exit 0 |
| 12 | Disable→enable ×14 | `plugin disable`/`enable` each id, checking `plugin list` between | PASS — every plugin flipped disabled→enabled cleanly; inbox `state.json` byte-identical across the round-trip; settled organize entry intact |
| 13 | Uninstall→reinstall | `plugin uninstall rebuildup.inbox` → `plugin install --ref release-0-8-0` | PASS — state (`organized:1`) survived uninstall+reinstall |
| 14 | Source switch | link → github install → link on same id | PASS — state and enablement preserved across all three source kinds |
| 15 | Coexistence interleave | 20 mixed read commands across all plugins on one session | PASS — every command returned its own contract JSON; the only failures were honest structured `usage` errors for missing required args (`projects repos` bad subcommand, `conversations history` missing selector, `artifacts search` missing query) |
| 16 | Inbox settle/snooze lifecycle | `inbox settle w1:p1` → `list` → `restore w1:p1` → `list` | PASS — organized count 1→0, pane token `inbox_state` visible in `api snapshot`, state.json v2 session-namespaced under isolated state dir |
| 17 | MCP stdio smoke | JSON-RPC `initialize` → `serve` | PASS — valid `initialize` result (`rebuildup.mcp` 0.7.0, tools capability) |
| 18 | Migration: old schema version | wrote `{"version":0,…}` (and real inbox v1 `entries` shape) into each versioned `state.json`, ran read command | PASS (no crash) — all 8 versioned stores (`artifacts`, `automations`, `checkpoints`, `conversations`, `handoff`, `inbox`, `machines`, `projects`) returned empty results exit 0; old data silently discarded on next write (see Findings) |
| 19 | Migration: corrupt JSON | truncated `state.json` in all 8 stores + corrupt `usage` quota-cache | PASS — every plugin emitted structured `{"ok":false,"error":…}` exit 1, no crash/stack trace; `usage` treated corrupt cache as miss and re-fetched honestly |
| 20 | Negative paths | `plugin disable rebuildup.nonexistent`; `plugin link /nonexistent` | PASS — `plugin_not_found` / `plugin_manifest_not_found` structured errors |

Per-plugin read-command smoke detail:

| Plugin | Commands run (all exit 0) |
| --- | --- |
| artifacts | `capability`, `list` |
| automations | `capability`, `list`, `runs` |
| checkpoints | `capability`, `list` |
| controls | `capability` (agent-targeted cmds need a live agent pane — none in scope; contract-covered) |
| conversations | `capability`, `sessions`, `index` (pane skipped `unknown_provider` honestly) |
| git | `capability`, `status w1:p1` (direct + via `plugin action invoke`) |
| handoff | `capability`, `list` |
| inbox | `capability`, `list`, `settle`, `restore`, `reconcile` (startup) |
| machines | `capability`, `list`, `probe --all` (0 machines → empty, honest) |
| mcp | `capability`, `serve` (stdio initialize) |
| projects | `capability`, `list`, `discover` (found the worktree repo) |
| secrets | `capability`, `capability --probe` (`project_id_configured:false` → `reachability:not_checked`, honest), `config` |
| textgen | `capability`, `config show` |
| usage | `capability`, `usage`, `quota` (real provider statuses incl. honest `credential_expired`/`unsupported`), `divergence` |

## Findings / defects

1. **LOW — `rebuildup.artifacts` session label misreports named sessions.**
   `plugins/artifacts/src/cli.ts:231-235` `sessionName()` reads
   `snapshot.session?.name`, which the protocol-22 snapshot does not
   populate, then falls back to `HERDR_SESSION` → `"default"`. With only
   `HERDR_SOCKET_PATH` set (the documented external-client targeting),
   `artifacts list`/`register` label records `"session": "default"` even
   when targeting `verify170`. The socket target itself is correct (no
   live-session access — state stayed under the isolated XDG root), so
   this is a metadata-labeling defect, not an isolation breach. Repro:
   run `artifacts list` with `HERDR_SOCKET_PATH` pointing at a named
   session and no `HERDR_SESSION`; observe `"session": "default"`.
   Severity: low — affects `--session` filtering/display of artifact
   records in named sessions.

2. **LOW — asymmetric source-override guard.** `herdr plugin install`
   (GitHub) refuses to install over an existing local link
   (`already linked from a local path`), but `herdr plugin link`
   silently replaces a GitHub-installed plugin of the same id (verified:
   link after `plugin install` flipped `rebuildup.inbox` source
   `github:…@release-0-8-0` → `local:…` with no warning). State is
   preserved either way, so impact is limited to surprise/UX; arguably
   intentional (link is the dev override), but the asymmetry is worth a
   docs note or a confirmation prompt upstream.

3. **OBSERVATION — old schema versions are silently discarded.** All 8
   versioned plugin state stores (`STATE_SCHEMA_VERSION` in
   `plugins/*/src/state.ts|model.ts`) treat `version !== current` as
   `emptyState()` — verified live: a v0/v1-shaped file yields empty
   results with no warning, and the next mutation rewrites current
   version, permanently dropping the old data. No crash and no false
   success, so it meets the "never crash / honest error" bar, but a
   `state_version_mismatch` warning in output would be safer for
   downgrade/upgrade edges. Corrupt (unparseable) JSON, by contrast, is
   an honest structured error exit 1 in every plugin.

4. **OBSERVATION — non-interactive honesty.** `plugin update` without
   `-y` on non-TTY refuses rather than guessing; `plugin install`
   prints a full preview then installs with `-y`. `plugin disable` /
   `link` on unknown targets return structured `plugin_not_found` /
   `plugin_manifest_not_found`. All good.

## Commands (abridged)

```bash
BASE=/var/tmp/herdr-plugin-170
export XDG_CONFIG_HOME=$BASE/config XDG_STATE_HOME=$BASE/state \
       XDG_DATA_HOME=$BASE/data HERDR_CONFIG_PATH=$BASE/config/herdr
HERDR=/Users/rebui/.local/share/mise/installs/herdr/0.9.5/herdr
env -i HOME=$HOME PATH=$PATH bash -c 'source env.sh; $HERDR --session verify170 server' &

# every CLI call:
env -u HERDR_SOCKET_PATH -u HERDR_PANE_ID -u HERDR_WORKSPACE_ID \
    -u HERDR_TAB_ID -u HERDR_SESSION -u HERDR_PLUGIN_CONTEXT_JSON \
    -u HERDR_ENV -u HERDR_BIN_PATH -u HERDR_STARTUP_CWD \
    -u HERDR_PLUGIN_CONFIG_DIR -u HERDR_PLUGIN_STATE_DIR \
    HERDR_SOCKET_PATH=$BASE/config/herdr/sessions/verify170/herdr.sock \
    $HERDR <cmd>

# plugin CLI smoke (per plugin, from plugins/<name>):
HERDR_SOCKET_PATH=<sock> bun run src/cli.ts capability   # etc.
```

Cleanup: `herdr server stop` + `herdr session delete verify170` via the
same isolated env; `/var/tmp/herdr-plugin-170` removed; `herdr session
list` confirms `verify170` gone; live session/agents/worktrees untouched.
