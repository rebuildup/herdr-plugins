# Contract `herdr-plugins.textgen/v1`

Text-generation CLI contract for the `rebuildup.textgen` herdr plugin
(Issue #107, parent #29 T1; git/forge integration #108 T2;
release-0-6-0). Same conventions as the other
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
| `review_guide` | agent only | `target` | `string` markdown (≤20 000 chars) |
| `next_prompt` | agent only | `context` | `string` (≤2 000 chars) |

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
