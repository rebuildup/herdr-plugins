# Verification evidence — textgen agent-pane path (Issue #107 / #29 T1)

Live verification of `rebuildup.textgen`'s `agent` execution path
(ADR-0017) against an **isolated named herdr session**
(`verify107`, socket
`~/.config/herdr/sessions/verify107/herdr.sock`, started via
`herdr session attach` in a PTY and stopped/deleted afterward). The
user's live sessions were never touched; all plugin state/config lived
under `/var/tmp/herdr-107/`.

Environment: herdr 0.9.5 (protocol 22), provider agent `codex`
(v0.171.0, ChatGPT auth present on the machine).

## Command

```bash
cd plugins/textgen
echo '{"context":"Planning the herdr-plugins 0.6.0 release: …"}' \
  | HERDR_SOCKET_PATH=~/.config/herdr/sessions/verify107/herdr.sock \
    HERDR_PLUGIN_CONFIG_DIR=/var/tmp/herdr-107/plugin-config \
    HERDR_PLUGIN_STATE_DIR=/var/tmp/herdr-107/plugin-state \
    bun run src/cli.ts generate --task thread_title \
    --provider agent:codex --cwd /Users/rebui/work --timeout 240000
```

Result (ok):

```json
{
  "contract": "herdr-plugins.textgen/v1",
  "command": "generate",
  "ok": true,
  "task": "thread_title",
  "provider": "agent:codex",
  "path": "agent",
  "result": "herdr-plugins 0.6.0 Textgen Release Planning",
  "elapsed_ms": 15021
}
```

Observed socket sequence (matches the contract):
`server.agent_manifests` → `workspace.create` → `agent.start` →
`agent.prompt` (wait until idle/done/blocked) → `agent.read` →
`workspace.close`. The dedicated workspace was closed on every run,
including failures.

## Findings that shaped the implementation

1. **Shell-readiness race.** `agent.start` immediately after
   `workspace.create` can fail `agent_pane_busy: … not an available
   shell`. The executor retries that specific error (~10 s budget);
   other start errors are never retried (a retry could spawn a second
   agent process).
2. **Name-registration race.** `agent.prompt` right after
   `agent.start` can fail `agent_not_ready: … not an active named
   agent`. Retried briefly; `agent_blocked` is never retried.
3. **Provider trust prompts.** `claude` blocks on the folder-trust
   dialog in untrusted cwds → surfaces as `agent_blocked`/unmarked
   output honestly. `--cwd` (or `review_guide` input `cwd`) selects a
   trusted directory.
4. **claude subscription unavailable** on this machine at verification
   time (billing notice in-pane) — `agent:claude` produced
   `output_unmarked`, an honest structured failure, not a fabricated
   result.
5. **TUI marker decoration.** Codex renders replies behind `• `
   bullets with 2-space indentation, so naive line-start marker
   matching failed (`output_unmarked`). Extraction now tolerates
   leading `[ \t>*•\-–—]*` decoration and dedents the captured block;
   markers quoted *inline* by the model (echoing the instruction) are
   still rejected — covered by unit tests.
6. **Agent names** must match `[a-z0-9_-]{1,32}` starting lowercase —
   task kinds contain `_`, so generated names hyphenate them.

## Not verified here

- `api` path against a real provider endpoint (covered by contract
  tests with a fake HTTP server; real-provider matrix is #110/T4).
- `review_guide`/`next_prompt` long-running flows (#109/T3).
- Linux/Windows herdr sessions.
