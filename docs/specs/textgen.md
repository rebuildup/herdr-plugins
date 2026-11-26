# Spec: rebuildup.textgen (Issue #107 T1, #108 T2, #109 T3, #110 T4; parent #29)

Status: release-0-6-0 — `herdr-plugins.textgen/v1` **stable** (Versioning
section of `docs/contracts/textgen-v1.md`). Decisions: ADR-0017
(execution path), ADR-0018 (API credential boundary), ADR-0020
(agent-task guards).

## Purpose

Port T3 Code's text-generation surface (`apps/server/src/textGeneration/`)
to a herdr plugin: six tasks that turn user context into candidate text
(thread titles, branch names, commit messages, PR content, review
guides, next-prompt predictions). Generation is strictly separated from
execution — the plugin returns validated candidates; git/forge/composer
adoption is the caller's job, and manual specification always remains
available when generation is unavailable.

## Architecture

```
CLI (cli.ts)
  └─ generate.ts  pipeline: task → input guard → provider resolve → prompt → execute → validate
       ├─ agent.ts   agent-pane path (ADR-0017): herdr Socket API
       │             workspace.create → agent.start → agent.prompt --wait
       │             → agent.read → extract markers → workspace.close
       ├─ api.ts     API path (ADR-0018): opt-in HTTPS generators
       └─ providers.ts  agent:<kind> / api:<id> resolution + task×path matrix
```

- `model.ts` — contract id, task registry (paths, I/O fields, output
  shape, limits), `TextgenError`.
- `input.ts` — strict input allowlist, size caps, credential-pattern
  guard (fail closed, locations only).
- `prompts.ts` — per-task prompt templates; agent path adds
  `<<<TEXTGEN_RESULT>>>` markers.
- `output.ts` — marker extraction + output validation (empty, length,
  control chars, fences, JSON shapes).
- `config.ts` — `config.json` under `HERDR_PLUGIN_CONFIG_DIR`;
  normalized view, atomic writes, key resolution (env → key file).
- `gitcontext.ts` — git/forge input adapter (#108): resolves the
  `rebuildup.git` plugin root (override → sibling → `herdr plugin
  list`) and gathers task inputs through its read-only git-v1 CLI;
  probes repository convention files at the reported repo root.
- `pluginroot.ts` — shared sibling-plugin root resolution + CLI
  invocation (env-scrubbed, plugin dirs pinned); used by gitcontext
  and the usage-quota guard.
- `guards.ts` — pre-execution guards (#109): expensive-task opt-in,
  agent-kind availability vs herdr manifests, optional usage-quota
  probe. Runs before any pane is spawned.
- `quota.ts` — read-only `rebuildup.usage` `quota` probe (soft
  dependency; every failure degrades to a warning).
- `watch.ts` — `watch-next-prompt` engine (#109): subscribes to
  `pane.agent_status_changed`, triggers `next_prompt` generation on
  observed `working → idle|done` transitions, records the result as
  pane metadata + JSONL events.
- `providers.ts` — provider refs (`agent:`, `api:`, bare), defaults,
  manifests-aware resolution.

## Task registry

| task | paths | notes |
| --- | --- | --- |
| `thread_title` | agent, api | ≤200-char title from `context` |
| `branch_name` | agent, api | slug ≤100 chars |
| `commit_message` | agent, api | `diff` required; `conventions`, `instruction`, `candidates` (≤5) |
| `pr_content` | agent, api | `{title, body}`; JSON preferred |
| `review_guide` | agent only | read-only multi-step investigation; `target` required |
| `next_prompt` | agent only | predicted next composer prompt; `context` required |

`transcription` is out of scope (client-polish-misc side, per #29).

## Provider resolution

1. `--provider agent:<kind>` / `api:<id>` / bare name (agent kind first,
   then api id).
2. `config.defaultProvider` (explicit; unresolvable ⇒ `provider_unknown`).
3. herdr `server.agent_manifests` (when reachable) → known agent kinds
   → enabled API generators.

Agent path preferred over API by default (subscription vs per-token
billing). `--model` overrides per call; on the agent path it is reported
as ignored (`model_flag_ignored_on_agent_path`) because agent CLIs own
model selection via `agentProviders[].args`.

## Execution paths

### agent (ADR-0017)

Per invocation: `workspace.create` (dedicated, `focus:false`, optional
cwd) → `agent.start` (kind, name, args, startup timeout) →
`agent.prompt` with `wait.until=[idle,done,blocked]` → status check →
`agent.read` (`recent`, N lines, ANSI stripped) → marker extraction →
`workspace.close` in `finally` (cleanup warnings surfaced). `--cwd` or
`review_guide` input `cwd` selects the workspace directory — provider
trust prompts (e.g. claude folder trust) make cwd choice significant.
Prompt echo/TUI noise is discarded by taking the last marker pair;
absent markers ⇒ `output_unmarked`.

Real-herdr verification (isolated session `verify107`, codex agent):
`docs/research/textgen-v1-agent-pane-verification.md`. It surfaced and
fixed three races/format issues: pane shell-readiness and agent
name-registration retries, TUI-decorated marker extraction, and agent
name charset (`_` → `-`).

Agent-only tasks (`review_guide`, `next_prompt`) default their prompt
wait to the per-task `defaultTimeoutMs` (600 s / 120 s) rather than
the generic `agent.promptTimeoutMs`; `--timeout` overrides. Every
invocation still runs create → start → prompt → read → close with
cleanup in `finally` — interrupt/timeout honesty is unchanged (#109).

### api (ADR-0018)

Only `enabled: true` generators resolve. Endpoint must be `https:`
(`http:` loopback only). Key from `keyEnv` env var or
`<configDir>/keys/<id>.key`; used solely as request credential.
Request/response shapes per kind (`openai`/`openai-compatible` →
`/chat/completions`; `anthropic` → `/v1/messages`). Errors carry status
codes only.

### cli

Reserved, always `unsupported` — see ADR-0017.

## Input boundary (contract-enforced)

- Strict per-task key allowlist; unknown keys rejected.
- Required fields non-empty; empty optional strings dropped.
- `limits.maxInputChars` total cap (default 200 000).
- Credential-pattern guard: PEM, `sk-`, `ghp_`/`gho_`/`ghu_`/`ghs_`/
  `ghr_`, `github_pat_`, `xox*`, `AKIA|ASIA`, `AIza`, JWT, `Bearer` —
  `input_secret_detected` with field paths + pattern names only.

## Output validation

- `text`: trim; single wrapping fence unwrapped; interior fences ⇒
  `output_unexpected_fence`; control chars ⇒ `output_control_chars`;
  length ⇒ `output_too_long`.
- `text_list`: JSON string array or `---`-separated candidates; capped
  at `min(maxListItems, candidates)`.
- `pr_content`: JSON `{title, body}` preferred; first-line-title
  fallback; title ≤300 chars; body ≤ `maxOutputChars`.
- JSON shapes (`text_list` arrays, `pr_content` objects) parse strictly
  first; on failure a conservative second pass extracts the first
  balanced block and escapes raw `\n`/`\r`/`\t` inside JSON string
  literals only (provider agents wrap long string values across
  terminal lines — #186/#132). Truncated, unbalanced, multi-value, or
  non-JSON output still fails `output_invalid_json`; nothing is
  guess-repaired.

## Config

`config.json` under `HERDR_PLUGIN_CONFIG_DIR` (external:
`~/.config/herdr/plugins/config/rebuildup.textgen/`). Holds endpoints,
models, provider ids, `keyEnv` names — never secrets. `config` CLI:
`show`, `set-default-provider`, `set-default-model`,
`add-api-generator` (disabled unless `--enable`), `remove-api-generator`.
Writes are atomic (tmp+rename).

## Git/forge integration (#108, T2)

Upstream task mapping (T3 Code `textGeneration` → registry):
`generateBranchName` → `branch_name`, `generateCommitMessage` →
`commit_message`, `generatePRContent` → `pr_content` (the remaining
tasks — `generateThreadTitle`, `generateReviewGuide`,
`generateTranscriptionPostProcessing`, next-prompt — are covered by T1
registry entries or out of scope).

`generate --git-pane <pane>` (and the provider-free `git-context`
preview command) feeds the three git tasks from a pane's repository:

- **Discovery**: `--git-root` → `config.gitPluginRoot` → sibling
  `../git` → `herdr plugin list --json`; validated as a
  `rebuildup.git` root (`herdr-plugin.toml` id + `src/cli.ts`). Same
  cross-plugin pattern as usage→conversations (ADR-0013): only the
  public CLI contract is consumed — never another plugin's state
  files. The child's `HERDR_PLUGIN_*` env is scrubbed and pinned to
  the git plugin dirs.
- **Read-only by construction**: only git-v1 `status`, `diff`, `log`,
  `compare`, `pr status` run. Mutations (`stage`/`commit`/`branch`/
  `push`/`pr create`) are never invoked; every response's `contract`
  field must equal `herdr-plugins.git/v1` (`git_contract_mismatch`
  otherwise).
- **Per-task collection**: `branch_name` ← status + `diff --stat`;
  `commit_message` ← status + `diff --staged` (empty staged ⇒ unstaged
  `diff` with an explicit `# scope:` note) + convention files
  (`AGENTS.md`, `CONTRIBUTING.md`, `.commitlintrc*`,
  `commitlint.config.*`, `.github/CONTRIBUTING.md`; ≤8 KB/file,
  ≤40 KB total — repository content, not plugin state); `pr_content` ←
  status + `compare` (no upstream ⇒ worktree `diff` fallback + warning)
  + `log --limit 30` + `#N`/`owner/repo#N` ref extraction +
  `pr status` → `pr_context`. `pr status` failure (no `gh`/auth) is a
  warning, not a blocker.
- **Merge rule**: collected fields fill the task input; explicit
  `--input`/stdin fields override them. Empty input is allowed in git
  mode. Agent-path `cwd` defaults to the collected `repo_root`.
- **Generation-only invariant**: results remain candidates; adoption
  (`git branch create`, `git commit -m`, `git pr create --title …
  --body-file -`) is the caller's job, and textgen being uninstalled,
  unconfigured, or failing never affects the git/forge manual path —
  the adapter is additive and the git plugin has no dependency on
  textgen.
- `git-context` prints the collected `{input, sources, warnings,
  repo_root, branch}` without provider invocation; `capability` reports
  `integrations.git` (`resolved`/`unavailable`).

## Agent-task guards and watch (#109, T3)

`review_guide` and `next_prompt` run entirely on the agent-pane path
(API generators are rejected by the task×path matrix). Before any pane
is spawned, `generate` runs `checkGenerationGuards`:

- **Opt-in**: `review_guide` carries `requiresOptIn` in the registry —
  multi-step read-only investigation is the largest subscription cost.
  Requires `guards.expensiveTaskOptIn` in config.json or
  `--allow-expensive`; otherwise `task_not_opted_in` (policy) with zero
  transport calls.
- **Availability**: with reachable `server.agent_manifests`, the
  resolved kind must be listed → `provider_unavailable`; unreachable →
  `agent_availability_unverified` warning (fail-open; `agent.start`
  remains the authority).
- **Quota (opt-in)**: `guards.quota.enabled` probes
  `rebuildup.usage quota --provider <kind>` via the sibling-plugin CLI
  contract. `used_percent` ≥ `maxUsedPercent` (default 95) →
  `quota_exceeded`; plugin missing / non-zero exit / contract mismatch /
  non-`ok` status → `quota_check_unavailable` warning. Soft dependency —
  never hard-required, never consulted on the api path.

`watch-next-prompt --pane <id>` subscribes to
`pane.agent_status_changed` (`events.subscribe`) and generates one
`next_prompt` per observed `working → idle|done` transition: context is
the pane's recent scrollback (`pane.read`, tail-capped to the input
budget) or a static `--input` payload; the validated result is recorded
as pane metadata `textgen_next_prompt` and emitted as JSONL
(`next_prompt.triggered|generated|skipped|error`, `watch.stopped`).
Generations are sequential, debounced (`--debounce-ms`, default 5 s),
bounded by `--max-triggers`/`--once`/per-task timeout, and each uses a
dedicated workspace cleaned up by the agent executor. Composer/
notification UI stays with the caller (herdr-t3). Only observed
transitions trigger — statuses are seeded from `session.snapshot` and
a missed `working` edge never fires.

## Finalization and real-provider verification (#110, T4)

Contract `herdr-plugins.textgen/v1` is declared **stable** at plugin
v0.6.0 (contract Versioning section): command surface, task registry,
provider resolution order, execution-path semantics, guards, git
adapter, watch events, and error taxonomy are frozen except for
additive fields; breaking changes ship as `/v2` alongside v1.

Real-provider verification ran against an isolated herdr session
(`verify110`, dedicated XDG config/state dirs, ambient `HERDR_*`
unset): task×provider matrix, billing-safeguard confirmation, and
residuals are recorded in
`docs/research/textgen-v1-real-provider-verification.md`. Summary:

- `agent:codex` produced validated results for `thread_title`,
  `branch_name`, `commit_message`, `review_guide` (opted-in), and
  `next_prompt`; `--git-pane` end-to-end generation verified.
- `agent:claude` fails honestly (`output_unmarked`) while its
  subscription is unusable — same condition as #107.
- `pr_content` on `agent:codex` consistently failed
  `output_invalid_json` (provider wraps JSON string values across
  lines); resolved by #186 via conservative in-string-literal
  normalization — contract tests cover the observed shape, live
  re-verification is a residual.
- The api path was verified against a loopback fake endpoint
  (opt-in gating, credential header, response parsing); no real paid
  API credentials exist on the verification machine, so live
  OpenAI/Anthropic calls remain a documented residual.
- Billing prevention confirmed live: api generators default to
  `enabled: false` and are unresolvable until `--enable`; the agent
  path bills to provider subscriptions only; `review_guide` is
  opt-in gated before any pane spawn; the quota guard is opt-in and
  soft.
