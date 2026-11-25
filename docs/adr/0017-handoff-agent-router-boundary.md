# ADR-0017: Handoff plugin — Agent Router boundary and payload contract

Status: Accepted (release-0-6-0 candidate, Issue #103 / parent #6 T1)

## Context

Issue #6 (Handoff/Delegation) requires context transfer between agent
sessions — across providers, workspaces, and eventually machines —
without reimplementing routing. Its feasibility survey (issue #6
comments) fixed the decomposition: T1 (#103, this ticket) lands the
payload contract, state model, and a **read-only survey of the Agent
Router interface** plus the boundary ADR. Execution is T2 (#104),
cross-machine T3 (#105), delegation/lineage T4 (#106).

Two hard constraints shaped the design:

- AGENTS §4 invariants: herdr is the sole execution authority; plugin
  state must never fabricate statuses; stale organize state must not be
  applied to a different agent generation or reused pane id; unsupported
  or unverifiable data is never reported as success.
- Issue #6: "Agent Router の routing 判定は再実装しない" — the routing
  brain lives in dotfiles/pc-setup and must be consumed as a boundary,
  not duplicated.

## Agent Router interface survey (read-only)

Surveyed **without modifying anything**:

- `~/.dotfiles.102/` (dotfiles working copy): `script/agent/`,
  `config/agents.toml`, `docs/agent-launcher.md`,
  `docs/adr/ADR-0014.md`/`ADR-0015.md`.
- `~/.local/libexec/pc-setup`: installation/provisioning only; no
  agent-routing surface found.

### What the "Agent Router" actually is

It is **not a daemon or service** — it is a declarative launcher +
module library (dotfiles Epic #86):

- `config/agents.toml` — single source of truth for providers
  (endpoint, Infisical secret *names*, model catalogs), harnesses
  (command, adapter), and `[routes]` (`harness.provider` pairs).
  Fail-closed: unknown combinations exit non-zero listing supported
  choices; no implicit provider switch, no silent model fallback, no
  quota failover.
- `script/agent/contract.ts` (`CONTRACT_VERSION = "1.0.0"`) — the
  cross-module contract: `RouteRef` (`harness.provider` route ids),
  `AttemptIdentity`/attempt keys, `Attested<T>`/`Evidence`
  (verification status × provenance × evidence source, staleness via
  `isStale`), `QuotaScope`, secret redaction, canonical JSON, envelope
  versioning.
- `script/agent/*.ts` modules — catalog (#89 capability/pricing/terms,
  additive `[catalog.*]` TOML the launcher ignores), policy (#95
  project-init resolver), quota (#91 rate-limit telemetry), machines
  (#97 read-only `herdr machine list/status --json` inventory),
  attempts (#99 durable attempt records + generation leases/fencing),
  checkpoint (#99 side-effect journal), telemetry (#93 usage ledger),
  review/quality (#102 independent review gate + SHA-pinned validation),
  preflight (#? admission control: budgets, delegation policy, trusted
  repos), help (#88 progressive disclosure).
- `docs/agent-launcher.md` — design contract: *thin* (read TOML →
  filtered process env → spawn native CLI), *declarative*, *fail
  closed*, *native by default*; explicit non-goals: no daemon, proxy,
  router process, or new dependency.

### Interface implications for handoff

- There is **no routing RPC** to call. "Routing" = choosing a
  `harness.provider` route id (and optionally `--model`) that a human
  or agent then launches via `agent <harness> <provider>` or the
  per-provider entrypoints (`script/agent/mimo`, `minimax`, …).
- Route validity is defined only by `config/agents.toml` on the machine
  where the launch happens; the plugin cannot and must not read it
  (secrets-adjacent config, machine-local, owned by dotfiles).
- Attempt/quota/checkpoint discipline (#99/#93/#102) belongs to the
  launcher side; handoff records may *reference* an attempt or route id
  as opaque strings for humans/agents, nothing more.
- `machines.ts` already wraps `herdr machine list/status` read-only —
  relevant precedent for T3 (#105) remote capability probing, but it is
  dotfiles code, not something this plugin may depend on.

## Decision

**New plugin `rebuildup.handoff`** (install/disable independence)
implementing contract `herdr-plugins.handoff/v1`:

1. **Payload = references + bounded excerpt, never copies.** Refs name
   objects in sibling plugins' public contracts: conversations session
   keys (`<provider>:<session-id>`), checkpoints entry ids, and
   `external` uri/path/issue pointers. Excerpt ≤ 8192 chars; ≤ 32 refs;
   ≤ 32 requirements. This mirrors T3's "budgeted selection" — the
   receiving agent pulls full history on demand through the referenced
   indexes.
2. **Identity carries generation.** `transfer` records Host +
   `herdr_session` + Workspace/Tab/Pane + `agent_session` fingerprint +
   `state_change_seq`, plus an internal `session_key`
   (hostname + canonical socket path, inbox convention). Staleness is
   resolved at read time only: `pane_missing`,
   `agent_session_changed`, `generation_regressed` → `stale`;
   foreign-session or unreachable snapshot → `unchecked`. Stale records
   are reported, never applied; T1 applies nothing.
3. **Boundary with Agent Router.** The plugin records
   `target.provider_hint` as an **opaque label** (it may be a route id
   like `claude.openrouter`). It never reads `agents.toml`, never
   invokes the `agent` launcher, and never performs route resolution,
   quota checks, preflight admission, or review gating. T2 (#104)
   execution creates panes via herdr's own API (`workspace.create` /
   `tab.create` / `pane.split` + `agent.start`) and passes the provider
   hint through as recorded intent only; whether/how the Agent Router
   participates in target launch is a #104/#106 decision recorded in
   those tickets' ADRs.
4. **Boundary with sibling plugins.** Payload refs are resolved through
   owner plugins' **public CLIs only** (`conversations sessions
   --offline`, `checkpoints list`), discovered via sibling directory or
   `herdr plugin list --json` — the `rebuildup.usage` pattern
   (ADR-0013). Owner state files are never read. Resolution verdicts
   are honest: `resolved` / `missing_ref` (proven absence only) /
   `unchecked` / `error` (never downgraded to `missing_ref`) /
   `external`.
5. **State.** Single `state.json` under `HERDR_PLUGIN_STATE_DIR`,
   single-writer lock + tmp+rename (inbox/projects/checkpoints
   discipline). Records are deliberately **not** session-namespaced —
   cross-session transfer is the feature; each record self-describes
   `session_key`. Cap 500, terminal statuses evict first.
6. **Status lifecycle** `pending → ready → delivered → done/failed/
   superseded` is fixed now (contract) but only `pending` is written in
   T1; transitions land with execution in #104.

## Consequences

- T2 (#104) inherits a stable record format and the `checkTransfer`
  gate it must enforce before any `execute`; no schema migration needed
  for local handoff.
- T3 (#105) extends `transfer.host` semantics for remote sessions; the
  `external` ref kind and `portable_context` strategy are the seeds of
  the portable-bundle design.
- T4 (#106) adds `relationship`/lineage on top of the record id — the
  record is already the lineage node.
- Consumers (herdr-t3) can render handoff state from `list`/`status`
  without touching plugin internals.
- If the Agent Router later exposes a machine-readable route catalog
  (e.g. `agent routes --json`, already specced in `agent-launcher.md`),
  `provider_hint` validation becomes possible **without contract
  breakage** — it is advisory today and may become checked tomorrow.
- Upstream gap candidates remain as surveyed in #6: remote agent
  lifecycle limits, `agent_session_path` publicity (#89), coarse
  turn-completion observation.
