# rebuildup.textgen

Text generation for herdr (`herdr-plugins.textgen/v1`, stable at
plugin v0.6.0) — Issues #107–#110, parent #29 (T1 core, T2 git/forge
adapter, T3 agent-task guards + watch, T4 contract finalization +
real-provider verification).

## Install

```bash
herdr plugin install rebuildup/hoxay-plugins/plugins/textgen
```

Prerequisites: herdr ≥ 0.9.0, Bun on `PATH`. The `agent` path needs a
herdr agent kind installed (e.g. `claude`, `codex` — see
`capability` → `providers.agent`); the `api` path is opt-in via
`config add-api-generator … --enable` (ADR-0018).

## What it does

Generates candidate text for six tasks — `thread_title`,
`branch_name`, `commit_message`, `pr_content`, `review_guide`,
`next_prompt` — over two execution paths:

- **agent** (default): a dedicated herdr pane runs the provider agent
  (`agent.start` → prompt → read → cleanup). Visible and interruptible;
  herdr stays the sole PTY authority (ADR-0017).
- **api**: opt-in HTTPS calls to configured OpenAI / Anthropic /
  OpenAI-compatible generators, with a strict credential boundary —
  keys come from env vars or `<config>/keys/<id>.key` and are never
  logged or persisted by the plugin (ADR-0018).

Input is a strict per-task JSON allowlist with a credential-pattern
guard; output is validated (empty/length/control-char/fence checks)
before return. The plugin never runs git/forge operations — callers
adopt results explicitly, and manual specification always works.

For the git tasks (`branch_name`, `commit_message`, `pr_content`) the
plugin can gather repository context itself through the
`rebuildup.git` plugin's read-only `herdr-plugins.git/v1` CLI
(`--git-pane`): staged/unstaged diffs, commit lists, compare patches,
forge PR state, and repository convention files. Collection is
read-only; explicit `--input` fields override collected ones.

## Usage

```bash
cd <plugin_root>
bun run src/cli.ts capability
bun run src/cli.ts generate --task commit_message --provider agent:claude \
  --input payload.json          # {"diff": "...", "conventions": "..."}
bun run src/cli.ts generate --task commit_message --git-pane w1:p1 \
  --provider agent:claude       # diff/conventions collected via rebuildup.git
bun run src/cli.ts git-context --task pr_content --git-pane w1:p1
bun run src/cli.ts generate --task thread_title \
  --provider api:openai --input - < input.json --raw
bun run src/cli.ts config show
bun run src/cli.ts config add-api-generator --id openai --kind openai \
  --endpoint https://api.openai.com --model gpt-4o-mini --key-env OPENAI_API_KEY --enable
```

See `docs/contracts/textgen-v1.md` for the full contract and
`docs/specs/textgen.md` for the design.

## Agent-task guards and next-prompt watch (#109)

`review_guide` requires opt-in — it runs a multi-step read-only
investigation in the agent pane (largest subscription cost):

```bash
bun run src/cli.ts generate --task review_guide --allow-expensive \
  --input '{"target": "PR #42"}' --cwd /path/to/checkout
# or permanently: config.json → "guards": {"expensiveTaskOptIn": true}
```

Optional quota guard (`guards.quota.enabled` in config.json) probes
`rebuildup.usage`'s read-only `quota` command before spawning a pane
and blocks at `maxUsedPercent` (default 95); an absent/unreachable
usage plugin degrades to a warning, never a hard dependency.

`watch-next-prompt` generates a predicted next prompt whenever a
watched pane's agent finishes a turn:

```bash
bun run src/cli.ts watch-next-prompt --pane w1:p2 [--once] [--max-triggers 5]
```

It emits JSONL events (`next_prompt.triggered|generated|error`) and
records each result as pane metadata `textgen_next_prompt`; composer
insertion is the caller's job.

## Interactive TUI (#246)

The plugin ships a tab-placed pane entrypoint plus an `open` action
(`herdr-plugins.tui/v1`; ADR-0031/0032/0033):

```toml
# herdr-plugin.toml (already declared)
[[panes]] id = "main"  placement = "tab"  command = ["bun","run","src/tui.ts","main"]
[[actions]] id = "open" contexts = ["pane","workspace"]  command = ["bun","run","src/tui.ts","open"]
```

- `open` pins the origin context (workspace/tab/focused pane/cwd) once
  and calls `plugin.pane.open` with `placement = "tab"`, forwarding the
  pins as `HERDR_TUI_*` env vars. `HERDR_PANE_ID` inside the UI is the
  UI pane's own surface identity — never a target.
- The UI consumes this plugin's own CLI (`src/cli.ts`) for `capability`,
  `git-context`, and `generate`, so the public contract stays the single
  source of truth. Opening performs reads only.
- Flow: pick a task → fill the contract `input_fields` (required fields
  marked; `@/path/to/file` reads a file for long/multiline values such
  as diffs) → optional provider/model override → optional `--git-pane`
  repo-context collection for the git tasks (with a read-only
  `git-context` preview) → confirm → `generate`.
- `generate` is gated on `capability`/`mutation_commands` (fail closed
  when unavailable), confirm-gated with the exact run parameters, and
  runs with the contract timeout + grace. `review_guide` asks for a
  per-run `--allow-expensive` opt-in. Cancelling detaches rather than
  kills the CLI so the agent-path workspace cleanup still runs; the
  result is discarded and reported honestly.
- Results render per output shape (text / candidate list / PR
  title+body) with provider, elapsed, warnings, and git-context
  provenance. `c` copies the raw result to the clipboard. The view
  states plainly that **results are not retained** — the contract
  persists nothing (#249) — and there is deliberately no apply/adopt
  action: generation and application stay separated.
- Provider problems (`provider_unavailable`, `no_credential`,
  `no_provider`, `task_not_opted_in`, `quota_exceeded`,
  `input_secret_detected`, …) render their real error kind — never a
  fabricated success. `watch-next-prompt` stays a CLI/daemon surface;
  `config` writes stay on the CLI.
- Non-TTY stdin degrades to a plain-text task list; the non-
  interactive CLI is unchanged.

Opt-in keybind (user-owned; plugins never write herdr config):

```toml
[[keys.command]]
key = "prefix+G"
type = "plugin_action"
command = "rebuildup.textgen.open"
description = "open textgen TUI"
```
