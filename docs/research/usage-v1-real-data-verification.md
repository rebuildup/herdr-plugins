# Real-data verification — `rebuildup.usage` v0.5.0 (#93 / parent #28 T4)

End-to-end verification of `herdr-plugins.usage/v1` against **real
provider transcripts, real provider credentials, and the live LiteLLM
pricing table** — not fixtures. Covers `capability`, the conversations
`index` feed, `usage` aggregation, `cost` (estimated API cost), `quota`
(subscription quota/reset), `divergence`, and state retention/GC.

- Plugin: `plugins/usage` @ branch `93` (post-T3 `release-0-5-0`,
  herdr-plugins.conversations v0.5.0 as the read-only index source)
- herdr: `0.9.5` (protocol 22, isolated named session `verify93`)
- Bun: `1.4.4`; platform: macOS (arm64)
- Provider CLIs present: claude `2.1.330`, codex `0.171.0`
- Pricing source: live
  `https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json`
  (4,956 model entries fetched 2026-11-25T10:18:00Z)

## Environment

| Env | Isolation |
| --- | --- |
| herdr session | `verify93` under dedicated `XDG_CONFIG_HOME`/`XDG_STATE_HOME` (`/var/tmp/herdr-plugin-93`) — the user's live `default` session was never targeted; all CLI calls unset ambient `HERDR_*` and used `--session verify93` |
| plugin state | `HERDR_PLUGIN_STATE_DIR=/var/tmp/herdr-plugin-93/state-{usage,conversations}`, `HERDR_PLUGIN_CONFIG_DIR=…/config-{usage,conversations}` — nothing written outside these dirs or provider-owned locations |
| provider data | **Real** `~/.claude/projects`, `~/.claude/.credentials.json`, `~/.codex/sessions`, `~/.codex/auth.json` (read-only for the plugin; the resumed agents appended only what the providers themselves write on resume) |
| agents | Real `claude --resume` and `codex resume` processes in herdr panes `w1:p1`/`w1:p2`; `agent_session` bindings reported through the same `herdr:<agent>` source the shipped hooks use (`pane report-agent-session --source herdr:claude|codex --session-start-source resume`) |

The user's live session, agents, and worktrees were not touched. The
isolated session was stopped and deleted afterwards; evidence retained
at `/var/tmp/herdr-plugin-93`.

## Transcripts under test

| provider | session id | transcript | indexed events |
| --- | --- | --- | --- |
| claude | `5fc420d3-25ca-44ac-8a4a-a738cd1f63b6` | `~/.claude/projects/-Users-rebui-work-ahc074/….jsonl` | 1,489 |
| codex | `01a1f861-8d67-7042-9663-95ed0daf43e2` | `~/.codex/sessions/2026/11/20/rollout-…-01a1f861-….jsonl` | 6 |

## Results

| # | Check | Result |
| --- | --- | --- |
| 1 | `capability` | `herdr-plugins.usage/v1`, commands `[capability, usage, quota, divergence, cost]`, `read_only: true`, `mutation_commands: []`; sources: conversations-index, subscription-quota-api, cliproxy-api, model-pricing — PASS |
| 2 | conversations `index` (feed) | 2/2 indexed, 0 skipped, 1,495 events; `malformed_lines: 0` on both real transcripts — PASS |
| 3 | conversations `sessions` | both `status: ok`, `stale: false`, `live_session: verify93`, `transcript_present: true` — PASS |
| 4 | `usage` aggregation | 656 usage events / 2 sessions: claude `claude-opus-5-5` 654 events / 327.4M total tokens (incl. 324.4M cache-read), codex `gpt-6-luna` 2 events / 85k tokens; `provider_reported_cost_usd: null` everywhere (no provider reports cost) — PASS |
| 5 | `cost` (first run) | real LiteLLM fetch: `status: ok`, 4,956 known models, `cache.hit: false`; both real models priced — `claude-opus-5-5` est. **$98.4064558**, `gpt-6-luna` est. **$0.006726**; total `estimated_cost_usd: 98.4131818`, `estimate_complete: true`, `unpriced_models: []`; disclaimer labels it a list-price estimate, never a bill — PASS |
| 6 | `cost` cache | second run `cache.hit: true`, `age_seconds: 7`, `ttl_seconds: 86400`; identical total — PASS |
| 7 | `quota` | **codex**: real ChatGPT auth → `status: ok`, plan `Plus`, Session window 93% used (resets 2026-11-25T11:57:29Z), Weekly 51% (resets 2026-11-29T17:07:36Z), `reset_credits_available: 0`; **claude**: `request_failed` HTTP 403 — provider-side `oauth_not_allowed_for_organization` (see observations); **opencode**: `unsupported` (per-provider API keys, no subscription artifact) — PASS (honest statuses, no fabrication) |
| 8 | `divergence` | codex → `different_units` (quota 93%/51% subscription utilization vs 85k measured transcript tokens, reported side by side, never reconciled); claude → `quota_unavailable` (HTTP 403, measured 327.4M tokens still reported); opencode → `no_data`; `resolved_via: sibling`, `pages: 2`, `complete: true` — PASS |
| 9 | retention/GC (real state dir) | planted 40-day-old `quota-cache/expired-provider.json` + `pricing-cache/old.json` under `/var/tmp/herdr-plugin-93/state-usage`; next `cost` run GC'd both while keeping fresh `quota-cache/codex.json` and `pricing-cache/litellm.json` — PASS (referenced data never deleted) |
| 10 | secret hygiene | quota/pricing outputs and state files contain quota numbers and public prices only; no token material in any output or cache file (ADR-0014/0015 boundary held) — PASS |

## Bugs found and fixed during verification

1. **`pluginRoot()` off-by-one (`plugins/usage/src/source.ts`).**
   `path.resolve(import.meta.dir, "..", "..")` from `src/` yielded
   `plugins/`, so sibling auto-discovery computed
   `plugins/../conversations` — outside `plugins/` — and
   `rebuildup.conversations` was never found when the CLI ran without
   `HERDR_PLUGIN_ROOT` (the documented `bun src/cli.ts` path). Under the
   real plugin runtime `HERDR_PLUGIN_ROOT` is set, so installed plugins
   were unaffected; fixed to `".."` and covered by a regression test.

## Upstream / environment observations recorded

1. **Claude quota endpoint org policy.** `GET
   api.anthropic.com/api/oauth/usage` with the maintainer's real Claude
   Pro OAuth token returns HTTP 403
   `oauth_not_allowed_for_organization` — the organization disables
   OAuth for this surface. The plugin reports `request_failed` honestly
   (never fabricates windows); codex quota works end-to-end. Not a
   plugin defect; no upstream herdr issue applies.
2. **`agent_session` reporting requires the shipped-hook source.**
   `pane report-agent-session --source verify93 …` was silently ignored;
   `--source herdr:claude|codex` (the same source string the shipped
   hooks use) plus `--session-start-source resume` binds correctly.
   Consistent with herdrdev/herdr#5838 semantics; manual reporters must
   mimic hook sources.
3. **Agent detection needs a live process.** `report-agent` alone did
   not create an `agents[]` entry for a pane running a plain shell;
   launching the real `claude --resume` / `codex resume` processes let
   herdr's detection register the agents, after which session reports
   stuck.
4. **mise shim trust prompt in panes.** `codex` via the mise shim
   prompted "config files in ~ are not trusted" inside the isolated
   session's pane; bypassed by invoking the installed binary directly
   (`…/installs/codex/0.171.0/bin/codex`). Environment quirk, not a
   plugin or herdr defect.

## Verdict

`herdr-plugins.usage/v1` verified end-to-end on real claude/codex
transcripts, real provider credentials, and the live LiteLLM pricing
table in an isolated herdr 0.9.5 session: aggregation, estimated-cost
computation and caching, subscription quota probing, divergence
reporting, and retention/GC all behave per contract. Estimated cost is
labeled as an estimate distinct from billing; `provider_reported_cost_usd`
stays `null` because no provider reports cost; unknown models would
report `unpriced`, never a guess (covered by unit tests — both real
models happened to be priced).

Residual: claude quota could not be exercised to a `ok` result on this
machine due to the org OAuth policy (honest `request_failed` verified
instead); hub (`cliproxy`) quota source verified by unit/contract tests
only — no hub credentials configured on this host; Linux/Windows
verification not exercised (single-host macOS run).
