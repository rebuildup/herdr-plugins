# Verification evidence — textgen real-provider matrix + billing safeguards (Issue #110 / #29 T4)

Live verification of `rebuildup.textgen` (`herdr-plugins.textgen/v1`,
now **stable** per the contract Versioning section) against an
**isolated named herdr session** (`verify110`). All state was kept out
of the user's live session:

- `XDG_CONFIG_HOME=/var/tmp/herdr-110/config`,
  `XDG_STATE_HOME=/var/tmp/herdr-110/state` (herdr 0.9.5 server started
  headless via the real binary
  `~/.local/share/mise/installs/herdr/0.9.5/herdr --session verify110
  server`; the `~/.local/bin/herdr` mise shim cannot run under a
  relocated `XDG_CONFIG_HOME`, so the resolved binary was invoked
  directly).
- Every plugin invocation used
  `env -u HERDR_SOCKET_PATH -u HERDR_PANE_ID -u HERDR_WORKSPACE_ID
  -u HERDR_TAB_ID` plus `--session verify110`,
  `HERDR_PLUGIN_CONFIG_DIR=/var/tmp/herdr-110/plugin-config`,
  `HERDR_PLUGIN_STATE_DIR=/var/tmp/herdr-110/plugin-state`.
- Isolation was confirmed read-only (`workspace list` → only `w1`)
  before and after guarded/failing calls; the session was stopped and
  deleted and `/var/tmp/herdr-110` removed after verification.

Environment: macOS arm64, herdr 0.9.5, codex-cli 0.171.0 (ChatGPT auth
present), claude 2.1.330 (subscription currently unusable — see
Residuals). No `OPENAI_API_KEY`/`ANTHROPIC_API_KEY`/etc. in the
environment, so **no real paid API call was possible or made**; the
api path was verified against a loopback fake endpoint instead.

## Task × provider matrix

| Task | Path | Provider | Result | Evidence |
| --- | --- | --- | --- | --- |
| `thread_title` | agent | `agent:codex` | ✅ ok, 10.4 s | `"herdr-plugins 0.6.0 Textgen Release Readiness"` |
| `branch_name` | agent | `agent:codex` | ✅ ok, 11.6 s | `"add-textgen-plugin-contract-finalization-verification-docs"` |
| `commit_message` | agent | `agent:codex` | ✅ ok (3rd attempt), 10.4 s | `["chore(foo): replace old text with new"]`; attempts 1–2 failed `output_unmarked` (codex TUI non-determinism, honest rejection) |
| `pr_content` | agent | `agent:codex` | ❌ `output_invalid_json` ×4 | see "pr_content finding" below |
| `review_guide` | agent | `agent:codex` | ✅ ok, 34.1 s | `--allow-expensive`; agent performed read-only repo inspection and returned a structured markdown guide |
| `next_prompt` | agent | `agent:codex` | ✅ ok, 13.2 s | predicted next prompt string |
| `thread_title` | agent | `agent:claude` | ❌ `output_unmarked` | same subscription-unavailable condition recorded in `textgen-v1-agent-pane-verification.md` (#107); honest structured failure, no fabricated result |
| `thread_title` | api | `api:local` (loopback fake, openai shape) | ✅ ok, 8 ms | `"FakeAPI Title for textgen verification"` — proves the api path end-to-end with zero paid calls |
| `git-context` | — | `rebuildup.git` sibling CLI | ✅ ok | `--task commit_message --git-pane` resolved `repo_root` = this worktree, `branch` = `110`, collected unstaged-diff fallback + `AGENTS.md` conventions, `sources` listed |
| `commit_message` | agent+git | `agent:codex` + `--git-pane` | ✅ ok | end-to-end: git-v1 collection fed the prompt; result adopted as candidate only (no git mutation) |

`capability` against the live session reported `agent_manifests:
"queried"`, 14 agent kinds (`agent:claude`…`agent:qwen`,
`availability: "manifest"` — manifest presence, not CLI install proof;
only `codex` actually executed), `api: []` by default, `cli` path
`unsupported` (ADR-0017), and guards off by default.

## pr_content finding (provider compliance, honestly rejected)

Four `agent:codex` runs of `pr_content` all failed
`output_invalid_json`. A manual reproduction (dedicated workspace →
`agent.start codex` → same marked prompt → `agent.read`) showed why:
codex wraps long JSON string values across terminal lines with
**literal newlines inside the string**, e.g.

```
<<<TEXTGEN_RESULT>>>
  {"title":"Pull request summary pending","body":"## Summary\n\nProvide a diff or commit list to summarize the change
  and its notable behavior.\n\n## Verification\n\nNo test results were provided."}
  <<<TEXTGEN_END>>>
```

The candidate starts with `{`, so the first-line-title fallback does
not apply and strict `JSON.parse` correctly rejects it. This is a
provider-output-compliance gap, not a contract violation: validation
refuses to guess, and the manual PR path is unaffected. Follow-up
filed as rebuildup/herdr-plugins#132 (lenient JSON extraction /
provider-specific output shaping); not an upstream herdr gap, so no
upstream issue was filed. Resolved by #186: output validation now
applies a conservative second-chance parse (first balanced JSON block,
raw control chars escaped inside string literals only) after strict
parsing fails — see `docs/contracts/textgen-v1.md` "Output
validation". Live `agent:codex` re-verification remains a residual.

## Billing-prevention confirmation (#29 acceptance)

All checks ran live against `verify110`:

1. **API generators are off by default and opt-in only.** Fresh config
   → `capability.providers.api == []`; `generate --provider api:openai`
   → `provider_unknown` (never a silent fallback to a paid endpoint).
   `config add-api-generator` without `--enable` writes
   `enabled: false`; a disabled generator is unresolvable
   (`provider_unknown`, zero HTTP calls — verified by re-disabling
   `api:local` and re-running).
2. **Agent path uses subscription CLI credentials.** Every agent
   provider reports `cost_note: "uses the provider's own
   subscription/CLI credentials via herdr"`; the plugin passes only
   prompt text — no API keys, no per-token billing path is reachable
   without explicit `enabled: true` + credential configuration.
3. **`review_guide` cannot fire accidentally.** Without opt-in:
   `task_not_opted_in` (`policy`) before any transport call —
   `workspace list` confirmed no pane/workspace was created. Opt-in
   requires `guards.expensiveTaskOptIn` or `--allow-expensive`.
4. **Quota guard is opt-in and soft.** `guards.quota.enabled`
   defaults `false`; when enabled it probes `rebuildup.usage`'s
   read-only `quota` command and blocks at `maxUsedPercent` (default
   95) with `quota_exceeded`; every probe failure degrades to a
   `quota_check_unavailable` warning (ADR-0020).
5. **API-path generation never probes quota** and requires both
   `enabled: true` and a resolvable credential (`no_credential` /
   `provider_misconfigured` otherwise) — verified: `api:local`
   without `LOCAL_TEST_KEY`/key file failed before any request.
6. **Manual fallback preserved.** Every failure above is a structured
   `{ok:false, error:{code,kind}}`; generation never performs git,
   forge, or composer operations, so manual specification is
   unaffected by construction (ADR-0017/0018, contract "The plugin
   generates text only").
7. **Credential boundary.** The loopback fake server logged the
   request; the key travelled only as the `Authorization` header,
   `capability` exposes `credential_configured` (boolean) and never
   key material, and `config.json` stores `keyEnv` names only.

## Upstream gap filing decision

No new **upstream** (`herdrdev/herdr`) gaps were found: the Socket API
surface used (`workspace.create/close`, `agent.start/prompt/read`,
`server.agent_manifests`, `events.subscribe`, `pane.*`) covered every
verified flow. The Agent Router question was already adjudicated in
ADR-0017 (no stable public interface → dedicated agent pane is the
canonical path; headless CLI subprocess rejected as `unsupported`).
The `pr_content` JSON-compliance issue is plugin-side and tracked as a
repo follow-up issue.

## Residuals / not verified

- **Real paid API endpoint**: no provider API credentials exist on
  this machine; the api path is verified against a loopback fake
  (contract shape + credential header + opt-in gating). A live
  OpenAI/Anthropic call remains unverified — acceptable because the
  path is opt-in and off by default.
- **`agent:claude`**: subscription unusable at verification time
  (same condition as #107); `output_unmarked` is the honest failure.
  Other manifest kinds (`gemini`, `grok`, `opencode`, …) were not
  exercised — manifests advertise kinds, not installed/authed CLIs.
- **`pr_content` on `agent:codex`**: persistent `output_invalid_json`
  (see finding); `pr_content` succeeded only via contract tests with
  conforming fake output.
- **`watch-next-prompt` live trigger**: the `next_prompt` *generation*
  path is verified above; the subscription/trigger loop is covered by
  `tests/textgen-t3.test.ts` (fake transport) and was not run against
  a live pane transition in this pass.
- **`commit_message`/`pr_content` `output_unmarked` flakes**: codex
  occasionally produces unmarked or non-conforming output; each is an
  honest structured failure with workspace cleanup verified
  (`workspace list` → `w1` only after every run).
- **cwd sensitivity**: one early `agent:codex` run with
  `--cwd` = a linked git worktree exited the provider process
  (code 1) → `output_unmarked`; reruns with `--cwd /Users/rebui/work`
  succeeded. Provider-side cwd behavior, honestly surfaced.
- **Linux/Windows herdr sessions**: unverified (macOS only).
