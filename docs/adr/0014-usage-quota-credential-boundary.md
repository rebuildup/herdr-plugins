# ADR-0014: Subscription quota credential boundary

Status: Accepted (release-0-5-0 candidate, Issue #91 / parent #28 T2)

## Context

Issue #91 adds subscription quota/reset surfacing to
`rebuildup.usage`. #28's research established that provider quota data
is only available behind provider-owned credential artifacts (OAuth
tokens, ChatGPT session tokens). Reading them makes the plugin a
credential consumer, which the repo invariants treat carefully:

- Config and durable state live only under herdr-provided plugin
  directories; nothing credential-shaped may be persisted there.
- "No ambient secret inheritance or logging" is a root invariant.
- The `secrets-management` skill forbids agents/workers from dumping
  environments, transcribing secret values into artifacts, or logging
  secrets for debugging — the same discipline applies to plugin code.

Two providers have a real, read-only quota artifact today:

- **claude** — `GET https://api.anthropic.com/api/oauth/usage` with the
  Claude Code OAuth access token (`$CLAUDE_CONFIG_DIR/.credentials.json`
  `claudeAiOauth.accessToken`, default `~/.claude`; macOS Keychain item
  `Claude Code-credentials` as fallback **only when `CLAUDE_CONFIG_DIR`
  is unset** — an explicit config dir is an explicit credential
  location). Response: `five_hour` / `seven_day` / model-scoped weekly
  windows, `extra_usage`, `spend`.
- **codex** — `GET https://chatgpt.com/backend-api/wham/usage` (plus
  `…/rate-limit-reset-credits`) with the ChatGPT `access_token` from
  `$CODEX_HOME/auth.json` (`tokens.access_token`; `id_token` claims
  supply `chatgpt_account_id` / plan). API-key auth has no subscription
  quota artifact.

`opencode` stores per-provider API keys in `auth.json` and has no
subscription quota endpoint → `unsupported`. Unknown providers are
`unsupported` with a recorded reason, never fabricated.

## Decision

The plugin may read **exactly** the credential fields needed to
authenticate the provider's own read-only quota endpoint, in memory,
per invocation:

| Provider | Artifact | Fields read | Never read/emitted |
| --- | --- | --- | --- |
| claude | `$CLAUDE_CONFIG_DIR/.credentials.json` (`~/.claude` default); macOS Keychain `Claude Code-credentials` fallback only when `CLAUDE_CONFIG_DIR` is unset | `claudeAiOauth.accessToken`, `expiresAt`, `subscriptionType` | `refreshToken`, scopes detail, file contents |
| codex | `$CODEX_HOME/auth.json` (`~/.codex` default) | `tokens.access_token`, whitelisted `id_token` claims (`chatgpt_account_id`, `plan_type`/`chatgpt_plan_type`), `auth_mode` | `refresh_token`, `OPENAI_API_KEY`, raw token strings |

Rules:

1. **Use, don't hold.** The access token exists only inside the fetch
   closure as an `Authorization` header for the provider's own quota
   endpoint(s). It is never returned, logged, written to state or
   config, or passed to any subprocess (the Keychain lookup uses the
   platform `security` CLI with stdout captured in-process only).
2. **Output carries presence, not values.** `quota` results contain
   plan labels, window percentages, reset instants, and statuses —
   never tokens, token fragments, credential file paths' contents, or
   account identifiers beyond what the provider plan label implies.
   Error `detail` strings name the artifact path and failure kind only.
3. **No credential mutation.** The plugin never refreshes tokens,
   never invokes `claude`/`codex login`, never writes credential
   files, and never redeems reset credits (that is a mutation; T3/#92
   scope if ever). An expired Claude token reports
   `credential_expired` rather than attempting a refresh.
4. **Endpoint allowlist.** Tokens are sent only to the provider's own
   quota endpoints (defaults above). `HERDR_USAGE_QUOTA_*_URL` env vars
   and `config.json` `quotaEndpoints` exist as test/proxy hooks
   (documented in the contract); they are not a general credential
   exfiltration path because the same boundary rules apply regardless
   of endpoint.
5. **Cache contains no secrets.** The short-term quota cache
   (`<state>/quota-cache/<provider>.json`) stores only
   `{checked_at, plan, windows, reset_credits_available}` — quota
   numbers and timestamps, never credential material.
6. **Env passthrough.** Quota probes run in-process via `fetch`; no
   provider CLI is spawned, so no ambient environment (API keys,
   tokens) is inherited by a child. The only subprocess is the
   read-only macOS `security find-generic-password` lookup, spawned
   with a fixed argv and no shell.
7. **Failure honesty.** Missing store → `no_credential`; expired
   token → `credential_expired`; API-key-only auth → `unsupported`;
   HTTP/transport/parse failure → `request_failed` (or the last good
   reading flagged `stale: true`). A failed or absent probe is never
   reported as `used_percent: 0`.

## Consequences

- `quota` works without a reachable herdr session and without the
  conversations index — it is an independent read surface.
- macOS Claude users whose credentials live only in Keychain are
  covered by the `security` fallback; non-macOS users without
  `.credentials.json` get `no_credential`.
- Codex quota requires ChatGPT-account auth; `codex login --api-key`
  users see `unsupported` with the reason recorded.
- If a provider rotates its credential file format or quota endpoint,
  the failure mode is a structured non-`ok` status — detectable, not
  silent.
- T3 (#92) HTTP/CLIProxyAPI sources inherit this boundary: any new
  credential-reading source must extend this ADR (or a successor)
  before merging.
