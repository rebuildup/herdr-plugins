# rebuildup.textgen

Text generation for herdr (`herdr-plugins.textgen/v1`) — Issue #107,
parent #29 T1.

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

## Usage

```bash
cd <plugin_root>
bun run src/cli.ts capability
bun run src/cli.ts generate --task commit_message --provider agent:claude \
  --input payload.json          # {"diff": "...", "conventions": "..."}
bun run src/cli.ts generate --task thread_title \
  --provider api:openai --input - < input.json --raw
bun run src/cli.ts config show
bun run src/cli.ts config add-api-generator --id openai --kind openai \
  --endpoint https://api.openai.com --model gpt-4o-mini --key-env OPENAI_API_KEY --enable
```

See `docs/contracts/textgen-v1.md` for the full contract and
`docs/specs/textgen.md` for the design.
