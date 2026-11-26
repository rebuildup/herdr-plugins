# Contract `herdr-plugins.textgen/v1`

Text-generation CLI contract for the `rebuildup.textgen` herdr plugin
(Issue #107, parent #29 T1; git/forge integration #108 T2;
agent-task guards + next-prompt watch #109 T3; contract finalization
+ real-provider verification #110 T4; release-0-6-0). Same
conventions as the other
plugin contracts: single JSON document on stdout, diagnostics on
stderr, exit 0 success / 1 handled error / 2 usage.

The plugin **generates text only**. It never performs git, forge, or
composer operations — adopting a result is always the caller's job, and
a manual specification path must keep working when generation is
unavailable or fails (upstream parity, #29).

## Execution paths (ADR-0017)

| Path | Provider id | Mechanism | Status |
| --- | --- | --- | --- |
| `agent` | `agent:<kind>` | Dedicated herdr workspace/pane: `workspace.create` → `agent.start` → `agent.prompt --wait` → `agent.read` → `workspace.close` (always attempted). Visible, interruptible, herdr-owned PTY. | implemented |
| `api` | `api:<id>` | Opt-in HTTPS call to a configured generator (`openai`, `anthropic`, `openai-compatible`). Credential boundary per ADR-0018. | implemented |
| `cli` | — | Headless provider CLI subprocess. | **unsupported** (ADR-0017) |

Provider resolution order: explicit `--provider` →
`config.defaultProvider` → herdr `server.agent_manifests` → known agent
kinds → enabled API generators. Agent path is preferred over API when
both are usable (subscription billing vs per-token API billing).

## Tasks

| `kind` | Paths | Required input | Output |
| --- | --- | --- | --- |
| `thread_title` | agent, api | `context` | `string` (≤200 chars) |
| `branch_name` | agent, api | — (at least one of `change_summary`/`diff`/`instruction` recommended) | `string` slug (≤100 chars) |
| `commit_message` | agent, api | `diff` | `string[]` candidates (≤5, `---`-separated or JSON array) |
| `pr_content` | agent, api | — | `{title, body}` (JSON preferred; first-line-title fallback) |
| `review_guide` | agent only | `target` | `string` markdown (≤20 000 chars) — **requires opt-in** |
| `next_prompt` | agent only | `context` | `string` (≤2 000 chars) |

`review_guide` is flagged `requires_opt_in`: it runs a multi-step
read-only investigation inside the agent pane, the largest
subscription cost of any task. It fails with `task_not_opted_in`
(`policy`) unless `guards.expensiveTaskOptIn` is `true` in config.json
or the caller passes `--allow-expensive`. `capability` reports
`requires_opt_in` per task and a `guards` section.

`pr_content` also accepts the optional input field `pr_context` — a JSON
string describing an existing forge PR (number/title/state/url/body
excerpt), typically collected by the git adapter below. Manual callers
may omit it.

Optional shared input fields per task are enumerated in
`capability.tasks[].input_fields`; unknown keys are rejected
(`input_unknown_field`). `commit_message.candidates` (number, 1–5)
controls candidate count.

## Input boundary

- Input is a JSON object on stdin (default), `--input -`, or
  `--input FILE`.
- Strict allowlist per task; required fields non-empty; total payload
  capped by `limits.maxInputChars` (default 200 000).
- Credential-pattern guard fails closed: PEM blocks, `sk-`/`ghp_`/
  `github_pat_`/`xox*`/`AKIA|ASIA`/`AIza` keys, JWTs, `Bearer <token>`
  → `input_secret_detected` reporting field paths and pattern names
  only — never the matched value.

## Output validation

Provider text is untrusted. Validation rejects: empty output
(`output_empty`), control characters (`output_control_chars`),
runaway length (`output_too_long`), unexpected interior code fences
(`output_unexpected_fence`; a single wrapping fence is normalized),
malformed list/JSON (`output_invalid_json`). Agent-path output must
contain the `<<<TEXTGEN_RESULT>>>`/`<<<TEXTGEN_END>>>` markers
(`output_unmarked`).

JSON outputs (`pr_content` objects, `text_list` arrays) are parsed
strictly first. Only when strict parsing fails, a conservative
second-chance pass extracts the first balanced JSON block and escapes
raw line breaks/tabs that appear *inside* JSON string literals —
provider agents are observed wrapping long string values across
terminal lines (Issue #186/#132). Nothing is guess-repaired:
truncated, unbalanced, multi-value, or non-JSON output still fails
with `output_invalid_json`. This tolerance is additive: the accepted
result shapes and the error taxonomy are unchanged.

## Commands

### `capability`

```bash
bun run src/cli.ts capability [--session NAME] [--socket PATH] [--config-dir DIR]
```

Reports the task×path matrix, agent providers (herdr manifests when
reachable, `unverified` otherwise), API generators with `enabled` and
`credential_configured` booleans (never key material), the reserved
`cli` path status, redacted config, and config warnings. Works without
a reachable herdr session.

### `generate`

```bash
bun run src/cli.ts generate --task <kind> \
  [--provider agent:claude|api:<id>|<bare>] [--model <m>] \
  [--input <file|->] [--raw] [--timeout MS] [--cwd DIR] \
  [--git-pane <pane>] [--git-root <dir>] \
  [--session NAME] [--socket PATH] [--config-dir DIR]
```

### Git/forge context (`--git-pane`, #108)

For the git tasks (`branch_name`, `commit_message`, `pr_content`),
`--git-pane <pane_id>` makes the plugin collect repository context
through the `rebuildup.git` plugin's **read-only** `herdr-plugins.git/v1`
CLI before generating:

| Task | git-v1 commands used | Fields populated |
| --- | --- | --- |
| `branch_name` | `status`, `diff --stat` | `change_summary`, `diff` |
| `commit_message` | `status`, `diff --staged` (fallback: unstaged `diff` with a scope note), convention files | `diff`, `conventions` |
| `pr_content` | `status`, `compare` (fallback: `diff`), `log`, `pr status` | `diff`, `commits`, `issue_refs`, `pr_context` |

- The git plugin root resolves from `--git-root` → `config.gitPluginRoot`
  → sibling `../git` → `herdr plugin list --json`; it must be a
  `rebuildup.git` plugin root or the call fails with `git_unavailable`.
- Only read commands are invoked — `status`/`files`-equivalent reads,
  `diff`, `log`, `compare`, `pr status`. Mutations (`stage`, `commit`,
  `branch`, `push`, `pr create`, …) are never called; generation stays
  separated from execution (ADR-0017) and the manual path is unaffected.
- Convention files (`AGENTS.md`, `CONTRIBUTING.md`, `.commitlintrc*`,
  `commitlint.config.*`, `.github/CONTRIBUTING.md`) are probed at the
  repo root reported by git-v1 `status` — repository content, not
  plugin state — capped per file and in total.
- `--git-pane` on a non-git task is a usage error (exit 2). Explicit
  `--input` fields override collected ones; an empty stdin/`--input` is
  allowed in git mode. The agent workspace `cwd` defaults to the
  collected `repo_root` unless `--cwd` is given.
- `pr status` failure (missing `gh`, no auth) is a warning
  (`forge context unavailable`), never a generation blocker.
- Success payloads gain an additive `git_context` object:
  `{pane_id, repo_root, branch, sources[]}` listing the git-v1 commands
  and file probes that fed the input.

### `git-context`

```bash
bun run src/cli.ts git-context --task <kind> --git-pane <pane> \
  [--git-root <dir>] [--session NAME] [--socket PATH] [--timeout MS]
```

Runs the same collection as `generate --git-pane` without invoking any
provider and prints `{contract, command:"git-context", ok, task,
pane_id, git_plugin, repo_root, branch, input, sources, warnings}` —
for inspection and for callers that want to review/override collected
fields before generating.

`capability` reports the git integration under `integrations.git`
(`resolved` with `plugin_root`/`resolved_via`, or `unavailable` with a
reason) and lists `git-context` in `commands`.

## Pre-execution guards (#109)

Before any agent pane is spawned, `generate` runs cheap read-only
checks (agent path only, after provider resolution):

1. **Opt-in** — `requires_opt_in` tasks need `guards.expensiveTaskOptIn`
   or `--allow-expensive` → `task_not_opted_in`.
2. **Availability** — when `server.agent_manifests` was reachable, the
   resolved kind must be listed → `provider_unavailable`; when
   unreachable the call proceeds with an `agent_availability_unverified`
   warning (`agent.start` stays the authority).
3. **Quota (opt-in)** — `guards.quota.enabled` probes
   `rebuildup.usage`'s read-only `quota --provider <kind>` command
   (`herdr-plugins.usage/v1`, sibling-plugin CLI pattern). A reported
   window `used_percent` ≥ `guards.quota.maxUsedPercent` (default 95)
   blocks with `quota_exceeded`; plugin missing, non-zero exit, contract
   mismatch, or non-`ok` provider status all degrade to a
   `quota_check_unavailable` warning — the usage plugin is a soft
   dependency, never required. API-path generation never probes.

Agent-only tasks also default their prompt wait to the per-task
`defaultTimeoutMs` (`review_guide` 600 s, `next_prompt` 120 s) instead
of the generic `agent.promptTimeoutMs`; `--timeout` always wins.

### `watch-next-prompt`

```bash
bun run src/cli.ts watch-next-prompt --pane <pane_id> \
  [--once] [--max-triggers N] [--debounce-ms MS] [--read-lines N] \
  [--input <file|->] [--provider <id>] [--model <m>] [--allow-expensive] \
  [--session NAME] [--socket PATH] [--config-dir DIR]
```

Long-running watcher: subscribes to `pane.agent_status_changed` and, on
an observed `working → idle|done` transition of `--pane`, generates one
`next_prompt` candidate through the same agent-pane path (dedicated
workspace → prompt → read → markers → cleanup). Context is the pane's
recent scrollback (`pane.read`, `--read-lines`/`agent.readLines`,
tail-capped to `limits.maxInputChars`) unless `--input` supplies a
static `{context, instruction?}` payload.

stdout is JSONL: `watch.started`, `next_prompt.triggered`,
`next_prompt.generated` (carries `result`, `provider`, `elapsed_ms`),
`next_prompt.skipped` (`reason:"debounce"`), `next_prompt.error`
(`stage: "context"|"generate"`, structured `code`/`kind`/`details`),
`next_prompt.warning`, `watch.stopped` (`stopped: signal|stream_end|
once|max_triggers` + trigger counters). Generations are sequential, debounced
(`--debounce-ms`, default 5000), and per-trigger failures never kill
the watch. On success the prompt is recorded as pane metadata token
`textgen_next_prompt` (source `rebuildup.textgen`) — presenting it in
the composer is the caller's/herdr-t3's job. Stops on SIGINT/SIGTERM
(subscription closed; an in-flight generation finishes within its own
timeout and its workspace is still cleaned up), stream end, `--once`,
or `--max-triggers`.

Only *observed* `working → idle|done` transitions trigger — the plugin
never infers turn boundaries from pane text, and a watcher that missed
the `working` edge (e.g. attached mid-turn via an unseeded snapshot)
does not fire.

Success payload:

```json
{
  "contract": "herdr-plugins.textgen/v1",
  "command": "generate",
  "ok": true,
  "task": "commit_message",
  "provider": "agent:claude",
  "path": "agent",
  "model": null,
  "result": ["feat(textgen): add generation core (#107)"],
  "elapsed_ms": 12345,
  "warnings": []
}
```

`--raw` prints the result only (string tasks verbatim; others as
single-line JSON) for scripting. `--cwd` sets the working directory of
the dedicated agent workspace (agent path only); `review_guide` may
also carry `cwd` in its input payload.

Error codes (stderr envelope `{contract, ok:false, error:{code,kind,
message, ...details}}`):

| code | kind | Meaning |
| --- | --- | --- |
| `usage` | — | bad CLI usage (exit 2) |
| `input_required` / `input_invalid` / `input_unknown_field` / `input_missing_field` / `input_too_large` | `bad_request` | input boundary violations |
| `input_secret_detected` | `policy` | credential-shaped material in input |
| `provider_unknown` / `no_provider` / `provider_path_unsupported` / `provider_misconfigured` | `bad_request`/`unavailable`/`unsupported` | resolution failures |
| `provider_endpoint_insecure` | `policy` | non-https non-loopback endpoint |
| `no_credential` | `unavailable` | API generator has no key |
| `agent_workspace_failed` / `agent_start_failed` / `agent_prompt_failed` / `agent_blocked` / `agent_read_failed` | `agent_execution` | pane-path failures; workspace cleanup always attempted |
| `api_request_failed` / `api_bad_response` | `provider_error` | HTTP/parse failures (status only, never bodies) |
| `output_empty` / `output_too_long` / `output_control_chars` / `output_unexpected_fence` / `output_invalid_json` / `output_unmarked` | `invalid_output` | output validation failures |
| `git_unavailable` / `git_cli_failed` / `git_contract_mismatch` / `git_bare_repo` / `git_task_unsupported` | `unavailable`/`git_error`/`bad_request` | git-context adapter failures (#108) |
| `task_not_opted_in` | `policy` | `requires_opt_in` task without opt-in (#109) |
| `provider_unavailable` | `unavailable` | agent kind absent from herdr manifests (#109) |
| `quota_exceeded` | `unavailable` | usage-quota threshold reached (#109) |

### `config`

```bash
bun run src/cli.ts config show
bun run src/cli.ts config set-default-provider <agent:kind|api:id|kind>
bun run src/cli.ts config set-default-model <model>
bun run src/cli.ts config add-api-generator --id <id> --kind <openai|anthropic|openai-compatible> \
  --endpoint <url> [--model <m>] [--key-env <ENV>] [--max-tokens <n>] [--enable]
bun run src/cli.ts config remove-api-generator <id>
```

`config.json` lives under `HERDR_PLUGIN_CONFIG_DIR` (external clients:
`~/.config/herdr/plugins/config/rebuildup.textgen/`). It stores
endpoints, model names, provider ids, `gitPluginRoot`, and `keyEnv`
*names* — never key values. `add-api-generator` writes `enabled: false` unless `--enable`
(opt-in, ADR-0018). Keys resolve from the env var or
`<configDir>/keys/<id>.key`.

## Config schema (normalized view)

```json
{
  "defaultProvider": "agent:claude",
  "defaultModel": "…",
  "gitPluginRoot": "/path/to/plugins/git",
  "apiGenerators": [
    { "id": "openai", "kind": "openai", "endpoint": "https://api.openai.com",
      "model": "gpt-4o-mini", "keyEnv": "OPENAI_API_KEY", "enabled": true }
  ],
  "agentProviders": { "claude": { "args": ["--model", "…"], "enabled": true } },
  "agent": { "startupTimeoutMs": 60000, "promptTimeoutMs": 300000, "readLines": 400 },
  "guards": {
    "expensiveTaskOptIn": false,
    "quota": {
      "enabled": false,
      "usagePluginRoot": "/path/to/plugins/usage",
      "maxUsedPercent": 95,
      "timeoutMs": 10000
    }
  },
  "limits": { "maxInputChars": 200000 }
}
```

## Credential boundary

- **Agent path**: credentials stay inside the provider CLI/herdr — the
  plugin passes only prompt text.
- **API path**: keys come from env or `<configDir>/keys/<id>.key`, are
  used only as request headers in-process, and never appear in output,
  errors, state, argv, or logs (ADR-0018).
- Endpoint policy: `https:` required; `http:` only for loopback.

## Versioning

`herdr-plugins.textgen/v1` is **stable** as of plugin v0.6.0
(T4/#110): the command surface (`capability`/`generate`/
`git-context`/`watch-next-prompt`/`config`), the task registry and
per-task input allowlists/output shapes, provider resolution order
(`agent:`/`api:`/bare → config default → manifests → known kinds →
enabled API generators), execution-path semantics (dedicated agent
pane per ADR-0017, opt-in API generators per ADR-0018, `cli`
unsupported), pre-execution guards (`requires_opt_in`, manifest
availability, opt-in quota probe), the git/forge adapter contract,
the `watch-next-prompt` JSONL event vocabulary, and the error `kind`
taxonomy are the finalized v1 contract. Additive fields may appear in
any response or in `capability` (`integrations`, `providers`,
`guards`, `config`, `warnings`, `git_context`); clients must ignore
unknown fields.

A breaking change — removing/renaming a command or field, changing an
error `kind`'s meaning, altering task input allowlists, output shapes
or limits, provider-resolution order, guard semantics, marker/output
validation rules, or watch event names — bumps the contract suffix to
`herdr-plugins.textgen/v2`, shipped alongside v1 for at least one
release so consumers can migrate; v1 is then frozen, not deleted. The
plugin keeps no durable organize state, so there is no on-disk schema
covered by this contract.
