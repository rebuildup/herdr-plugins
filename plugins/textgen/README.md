# rebuildup.textgen

Text generation for herdr (`herdr-plugins.textgen/v1`, stable at
plugin v0.6.0) — Issues #107–#110, parent #29 (T1 core, T2 git/forge
adapter, T3 agent-task guards + watch, T4 contract finalization +
real-provider verification).

## Install

```bash
herdr plugin install rebuildup/herdr-plugins/plugins/textgen
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
