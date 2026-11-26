# ADR-0028: Remote machines inventory — #161 survives as a narrowed read-only plugin

Status: Accepted (release-0-8-0 candidate, Issue #34 / parent #161 —
remote-machines residual of `secrets-remote-devices`)

## Context

#34's inventory
(`docs/research/secrets-remote-devices-inventory.md`) classifies T3Code
remote access/devices as **existing + partial**: herdr saved machines
+ `herdr --machine <id> <cmd>` (`SavedSshApiBridge`, ADR-0020) already
provide programmatic remote control, and `herdr machine
list/status/add/enable/disable` own lifecycle. The residual question —
raised in #34's open design questions — was whether a plugin-side
"saved-machine inventory/probe" surface is worth a ticket (#161) or
whether the area collapses to documentation.

What already exists:

- `herdr machine list --json` → `{id,label,target,session,enabled}`.
- `herdr machine status` → reachability check without prompting.
- handoff `remote-probe` / `execute --remote` (ADR-0020) → probes a
  machine for *handoff execution*: bridge capability, remote snapshot
  version/protocol, remote identity recording.
- `herdr --machine <id> api snapshot` → remote `version`, `protocol`,
  panes/agents/workspaces.

What does not exist: a **general, consumer-neutral inventory
contract** — one surface reporting, per saved machine: reachability,
bridge support, remote herdr version/protocol, enabled/disabled state,
and (pending verification) remote plugin surface — consumable by
herdr-t3 UI, the #30 MCP server, automations targeting, and future
remote operations without each re-implementing probe logic.

## Decision

**#161 survives as a plugin**, narrowed to read-only inventory/probe:

1. **Scope: read-only.** The `herdr-plugins.machines/v1` contract
   (implemented by #161) exposes `list` (saved machines + probe
   results), `probe` (single/all machines), and `capability`. Machine
   lifecycle — add/remove/rename/enable/disable/reconnect — is never
   reimplemented; the contract reports herdr's own state and points at
   the herdr CLI for mutations.
2. **Transport reuse.** Probe uses the ADR-0020 path:
   `herdr machine list --json` for enumeration and
   `herdr --machine <id> api snapshot` (+ `remote-api-bridge --check`
   semantics via the bridge handshake) per machine. Calls are
   stateless CLI spawns with timeouts; ambient `HERDR_*` env is
   stripped from children exactly as ADR-0020 rule 1 requires. The
   handoff remote transport (`plugins/handoff/src/remote.ts`) is *not*
   extracted into `packages/` preemptively — handoff's transport is
   execution-shaped (`HandoffTransport`); if #161's probe needs the
   same resolution helpers and a second real consumer appears, a
   `packages/` extraction is a separate decision per the
   packages-are-for-2+-plugins rule.
3. **No credentials, ever.** SSH keys/agent and machine auth are
   OpenSSH/herdr-owned (`machine.rs`); the plugin passes target strings
   to argv only, reads no credential material, stores nothing beyond
   probe *metadata* (timestamps, versions, reachability) under
   `HERDR_PLUGIN_STATE_DIR` with the standard lock+atomic-rename
   discipline. Probe results are cache-able metadata — never
   credential-adjacent.
4. **Honest degradation.** Disabled machines report `disabled` without
   probing; unreachable machines report structured `unreachable` /
   `unsupported_remote` (bridge-less remotes, per ADR-0020); a remote
   that answers `api snapshot` but lacks a verified plugin surface
   reports `plugin_surface: "unsupported"` — never a fabricated
   inventory.
5. **Remote plugin enumeration is a verification item, not an
   assumption.** `herdr plugin list` exists locally; whether it is
   API-backed (meaningful under `--machine`) is unverified — it likely
   enumerates the local plugin directory. #161 must check live against
   a real saved machine. If remote enumeration is impossible, the gap
   is recorded as an upstream candidate (session-API `plugin.*`
   inventory for remotes) and the contract ships without it.

### Why not collapse to doc-only

- handoff `remote-probe` is execution-scoped: it exists to gate a
  handoff `execute`, records handoff-specific remote identity, and is
  not a general inventory. Reusing it for display/MCP/automation
  consumers would couple unrelated features to the handoff plugin.
- The probe logic (machine resolution, bridge capability, snapshot
  version/protocol, timeout/error taxonomy) is identical work whoever
  consumes it; a thin contract plugin is cheaper than N reimplementations
  and keeps herdr-t3/MCP consumers off plugin internals.
- The incremental cost over "docs only" is small: enumeration and
  bridge transport are already proven by ADR-0020.

### Boundary vs. out-of-scope items

- Device streaming, Simlock, guest links, T3 Connect, peer-link OAuth,
  managed policy, background service, updating — all remain
  out-of-scope/upstream-blocked per the inventory; this ADR does not
  reopen them.
- If #161's live verification shows `plugin list` remote semantics are
  useless *and* no consumer materializes, the plugin may still shrink —
  but the `list`/`probe`/`capability` inventory itself is justified by
  herdr-t3 display needs recorded in the ledger.

## Consequences

- #161 implements `rebuildup.machines` (contract
  `herdr-plugins.machines/v1`, spec `docs/specs/machines.md`,
  contract `docs/contracts/machines-v1.md`) with fake-herdr contract
  tests plus live probe verification on an isolated saved machine
  where available (handoff's `remote-probe` live evidence at
  `docs/research/handoff-remote-api-verification.md` is the fallback
  citation).
- Upstream candidates recorded: remote plugin enumeration API;
  persistent remote channel (already noted in ADR-0020).
- Ledger entry `secrets-remote-devices` (#34) is updated to reflect:
  inventory canonized, residuals assigned to #160/#161, all other
  upstream surfaces classified with reasons.
