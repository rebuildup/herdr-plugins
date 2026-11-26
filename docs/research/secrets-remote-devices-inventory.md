# Research: Secrets / Remote / Devices — upstream inventory and responsibility assignment

Status: canonized baseline for `secrets-remote-devices` (#34), first
ticket of the release-0-8-0 train. This document is the authoritative
inventory and classification; the boundary decisions live in
ADR-0027 (secrets env injection) and ADR-0028 (remote machines
inventory / #161 disposition).

Cross-check basis (pinned):

- t3code `9cc4018c75ff4c61be8e86a6391d49a6c2d79830` —
  `docs/user/*`, `docs/internals/*`, `apps/server/src/{secrets,device,
  peer,guest,cloud}/`, `packages/{secret-provider-core,
  secret-provider-onepassword,ssh,tailscale}/`.
- herdr 0.9.5 / API protocol 22 — installed binary
  (`herdr api schema --json`, `herdr machine --help`,
  `herdr workspace|tab create --help`, `herdr pane split --help`)
  plus vendored source `/Users/rebui/work/herdr`
  (`src/cli/machine.rs`, `src/remote/*`, `src/api/schema/*`).
- This repository: ADR-0014/0015/0018 (credential boundary family),
  ADR-0019 (structured dialogs upstream gap), ADR-0020 (handoff remote
  execution), ADR-0025 (MCP boundary), ADR-0026 (inbound HTTP gap),
  `.agents/skills/secrets-management/SKILL.md` (binding Infisical
  policy), existing plugins under `plugins/`.

## Upstream inventory and classification

| Upstream feature (t3code ref) | Upstream implementation | herdr / existing-ecosystem coverage | Classification |
| --- | --- | --- | --- |
| Secret providers (`op://` references) | `apps/server/src/secrets/` + `packages/secret-provider-{core,onepassword}`. Credential fields store provider references resolved via the `op` CLI at use time; Settings → Secrets manages providers. | Infisical is canonical (`secrets-management` skill; self-host `https://secrets.rebuildup.dev`). Credential boundary precedents exist: ADR-0014 (provider OAuth token use-don't-hold), ADR-0015 (hub management key env-var only), ADR-0018-textgen (`<config>/keys/<id>.key`). **Plugin-side residual**: no shared reference-resolution + spawn/surface env-injection path. | **plugin** → #160 |
| Agent secret request card | `SecretRequests.ts` + MCP `request_secret`. Values stay in the `secret-ref:` store (24h), never enter transcript/projection; `file` requests go to an owner-only file. | herdr has no structured dialog API (ADR-0019; upstream request herdrdev/herdr#6196). PTY inference is forbidden. | **upstream-blocked** — same root as controls T4 dialogs; no new ticket, recorded here |
| Remote access (LAN/Tailscale/SSH/pairing/scoped session/device approval) | `docs/user/remote-access.md`, `docs/internals/{remote,environment-auth,connection-runtime}.md`. Environment identity separated from routes; scoped sessions; route learning. | herdr saved machines (`herdr machine list/add/status/reconnect/enable/disable`) hold SSH target + session only; credentials are OpenSSH-owned (`machine.rs`). `herdr --machine <id> <cmd>` → `SavedSshApiBridge` makes every API-backed CLI remote-capable (ADR-0020; consumed by handoff `remote-probe`/`--remote`). | **existing + partial** → residual is the unified machine inventory/probe surface → #161 |
| Devices (simulator/emulator stream, SSH device hosts, Simlock) | `apps/server/src/device/*` (expo-device-hub / agent-device / DeviceHubProxy / SshDeviceHost / SimlockDeviceHost / EasDeviceHost). Environment server owns the hub and streams to all clients. | No device hub equivalent in herdr. SSH device hosts conceptually overlap saved-machine targets; simctl/adb driving is possible inside panes but streaming UI is herdr-t3/desktop responsibility. | **out-of-scope** (GUI/OS capture). Agent-facing `device_*` tools re-evaluated per-demand via new Issues |
| Guest links | `docs/user/guest-links.md`, `GuestShareService` (HMAC token, per-thread read + propose, requires T3 Connect). | herdr has no inbound HTTP server, pairing, or token issuance. Plugins are socket-API clients and cannot host a server (ADR-0026 same conclusion for webhooks). | **upstream-blocked / out-of-scope** — needs herdr-core HTTP ingress + auth; upstream Issue candidate |
| T3 Connect (Clerk relay/tunnel/device approval/managed webhook forward) | `docs/internals/t3-connect.md`, `infra/relay`. Trusted broker + DPoP + link rotation. | Does not exist. herdr remote = saved-machine SSH only; hosted ingress is an upstream gap already recorded in `mcp-upstream-inventory.md` / herdrdev/herdr#6199 family. | **out-of-scope** (upstream service/infra; herdr upstream request candidate) |
| Linked environments / peer links | `docs/internals/remote.md#peer-links`, `apps/server/src/peer/`. MCP OAuth links environments with access ceilings and `linkOrigin` fencing. | handoff `--remote` (ADR-0020) covers the execution-transfer part. #30 MCP server is the outside-agent ingress foundation. | **partial** — remainder tracked under #30/#6; #34 records the boundary only |
| Background service | `docs/user/background-service.md` (`t3 up`/`service install`, systemd/launchd/Task Scheduler, `service.env`, `t3 service protect`). | herdr server residency + dotfiles/pc-setup operations cover the same responsibility. | **out-of-scope** (herdr core / machine setup) |
| Managed policy | `docs/user/managed-policy.md` (per-OS policy distribution, settings lock/limits). | None. Org distribution is dotfiles/pc-setup responsibility. | **out-of-scope** |
| Updating | `docs/user/updating.md` (client/server version alignment, `t3 update`, channels). | herdr's own updater / upstream release channel owns this. | **out-of-scope** |
| T3 Connect troubleshooting | `docs/user/t3-connect-troubleshooting.md` | — | **out-of-scope** (bound to T3 Connect) |

## Confirmed herdr 0.9.5 capability surface (live-verified)

- `herdr machine list|status|reconnect|add|rename|remove|enable|disable`
  — saved SSH machines; credentials never handled by plugins.
- `herdr --machine <id-or-label> <cmd>` — `SavedSshApiBridge` remote
  execution of API-backed CLI subcommands (ADR-0020).
- `--env KEY=VALUE` injection points confirmed on installed binary:
  `herdr workspace create --env`, `herdr tab create --env`,
  `herdr pane split --env`. (`agent start` takes no env — injection is
  at surface creation only.)
- `herdr plugin list [--plugin <id>] [--json]` exists locally. Whether
  it is API-backed (and therefore meaningful under `--machine`) is
  **unverified** — `plugin list` appears to enumerate the local plugin
  directory, not session state. #161 must verify live; if it lists
  local plugins only, remote plugin detection is an upstream gap and
  the probe reports `plugin_surface: unsupported` honestly.

## Feasibility verdict

Only two residuals are feasible as plugin work, both small-to-medium:

1. **Secrets** (#160): reference resolution (`infisical` canonical;
   `op` compat decided in ADR-0027) plus injection into the surface
   creation `env` map. Values transit herdr API params — the consent
   model, non-persistence, and failure honesty are fixed by ADR-0027.
2. **Remote machines** (#161): thin read-only inventory — saved-machine
   list + bridge capability + remote `api snapshot`
   version/protocol + (pending verification) remote plugin surface.
   `herdr machine list/status` and handoff `remote-probe` already cover
   the minimum; the plugin's value is the unified inventory contract
   for herdr-t3 / MCP / automations consumers. ADR-0028 confirms #161
   survives as a plugin at this narrowed scope.

## Upstream gaps / infeasible items (recorded, not worked around)

- **Guest links / inbound HTTP + scoped pairing**: no server-side HTTP
  ingress, pairing, or token issuance in herdr; plugins cannot host a
  server → herdr upstream Issue candidate.
- **Agent secret request card**: no structured dialog API
  (herdrdev/herdr#6196 root, ADR-0019). Resolves with controls T4
  upstream progress; no separate ticket.
- **T3 Connect-equivalent hosted ingress**: persistent remote channel
  already recorded as upstream gap in ADR-0020; saved-machine SSH
  covers the demonstrated range.
- **Peer links equivalent**: partially substituted by #30 MCP (stdio)
  + handoff remote bridge; full OAuth peer link deferred to #30 T3-T4
  scope decision.
- **Remote plugin enumeration**: `plugin list` remote semantics
  unverified; if local-only, record as upstream gap (session-API
  `plugin.*` methods are plugin-management, not remote inventory).

## Responsibility assignment summary

| Bucket | Items |
| --- | --- |
| plugin (this repo) | #160 secrets resolve/run/inject; #161 machines inventory/probe |
| herdr core | execution runtime, PTY, agent lifecycle, saved-machine SSH ownership, (gap) structured dialogs, (gap) inbound HTTP, (gap) persistent remote channel |
| herdr-t3 / desktop | device streaming UI, SnapShots/browser capture, appearance/keybindings polish |
| dotfiles / pc-setup | managed policy distribution, background service install, machine bootstrap |
| upstream service | T3 Connect relay, Clerk auth, hosted ingress |
| upstream-blocked (recorded) | agent secret request card, guest links, peer-link OAuth, remote plugin list (pending #161 verification) |

## Open questions — resolved by ADRs in this ticket

- Secrets provider scope (`op://` compat?) → **ADR-0027**: Infisical
  only in v1; `op://` deferred as successor-ADR compat path.
- Env-injection consent model → **ADR-0027**: declared bindings in
  plugin config + per-invocation explicit selection; no ambient
  inheritance, no wildcard injection.
- Secret transit through herdr `env` params → **ADR-0027**: allowed
  only at surface creation, never persisted/logged/emitted by the
  plugin; extends the ADR-0014/0015/0018 credential-boundary family.
- #161 plugin vs doc-only → **ADR-0028**: survives as a narrowed
  read-only inventory plugin; lifecycle stays with herdr CLI.
