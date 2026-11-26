# Research: herdr remote control surface (for handoff T3 / #105)

Date: 2026-02 (release-0-6-0). Evidence: installed `herdr 0.9.5`
(`herdr api schema --json`, protocol 22) + vendored source
`/Users/rebui/work/herdr` (`src/remote*`, `src/cli/target.rs`,
`src/cli/machine.rs`, `src/api/schema*`). Live probe against a saved
machine (`herdr --machine <id> api snapshot` / `agent list` /
`workspace list`) returned the remote session's real snapshot.

## Verdict: remote agent control IS available — via saved machines

| Path | Headless agent control? | Notes |
| --- | --- | --- |
| `herdr --remote <ssh-target>` | **No** | Interactive TUI attach only (`src/remote/host.rs` client bridge). Cannot drive `agent.start`/`agent.prompt`. |
| `server.ssh_agent.register` | **No** | Connection-scoped API method that registers the LOCAL `SSH_AUTH_SOCK` path into the remote server so remote agent CLIs can reach the local ssh-agent (`src/remote/ssh_agent.rs`). Agent forwarding, not a control surface. |
| Saved machines + `herdr --machine <label-or-id> <cmd>` | **Yes** | `herdr machine list --json` → profiles `{id,label,target,session,enabled}`. `herdr --machine` routes ANY CLI subcommand through `SavedSshApiBridge` (`src/cli/target.rs`, `src/remote/saved.rs`): SSH → remote `herdr --session <profile-session> remote-api-bridge` → stdio forward of the remote API socket. |

`remote-api-bridge` capability probe: `herdr --session <s>
remote-api-bridge --check` prints `herdr-api-bridge-v1`; remote hosts
without it fail machine API forwarding (upstream tells users to update
herdr on the remote). The bridge command is discovered remotely
(`find_installed_remote_herdr`, posix + windows-powershell variants).

## What the remote path exposes

Every API-backed CLI subcommand works remotely and prints the same
`{id, result|error}` JSON envelope as local calls (errors go to stderr,
exit 1):

- `api snapshot` → `{result:{snapshot:{…}, type:"session_snapshot"}}`
  with `version`, `protocol`, `panes`, `agents` (array), `workspaces`,
  `tabs`.
- `workspace create --cwd --label --focus|--no-focus --env K=V`
- `tab create --workspace --cwd --label --focus|--no-focus`
- `agent start <NAME> --kind <KIND> --pane <ID> [--timeout MS] [-- ARGS…]`
- `agent get <TARGET>` / `agent prompt <TARGET> <TEXT> [--wait --until
  S --timeout MS]` / `agent wait <TARGET> --until S --timeout MS`
- `pane close <PANE_ID>`

CLI→API param mapping is upstream-owned (`src/cli/*_bindings.rs`,
`src/cli/projection.rs`); the plugin never speaks the socket protocol
itself for remote calls.

## Caveats recorded for #105

- Per-invocation cost: each `herdr --machine` call spawns a fresh SSH
  bridge; `agent wait --timeout` holds it open. No persistent remote
  socket is exposed to third parties — upstream gap candidate.
- Machine profiles bind ONE remote session (`session` field); there is
  no `--remote-session` override on `herdr --machine`.
- Remote `agent_session`/`state_change_seq` come from the remote
  snapshot — generation signals are host-local by design.
- `agent.start` name constraint: herdr documents
  `[a-z][a-z0-9_-]{0,31}`; the plugin's `handoff <id>` name contains a
  space — same behavior local and remote (server-side validation is
  identical on both paths).
