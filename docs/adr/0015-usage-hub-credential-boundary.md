# ADR-0015: Quota hub (CLIProxyAPI-equivalent) credential boundary

Status: Accepted (release-0-5-0 candidate, Issue #92 / parent #28 T3)

## Context

Issue #92 adds an HTTP quota source to `rebuildup.usage`: the
CLIProxyAPI-equivalent path proven by T3 Code's
`apps/server/src/usage/cliproxyApi.ts` + `UsageLimitSources.ts`. A
user-configured "hub" speaks the CLIProxyAPI management API
(`GET /v0/management/auth-files`, `POST /v0/management/api-call`) and
holds the provider credentials itself; the plugin asks the hub to call
each account's provider quota endpoint.

This introduces a new credential shape ADR-0014 did not cover: a
user-supplied *hub management key* (not a provider OAuth token). ADR-0014
rule "any new credential-reading source must extend this ADR (or a
successor)" applies — this ADR is that successor for hub sources.

## Decision

The plugin may hold **exactly one** credential for hub sources: the
hub management key, read from an environment variable per invocation.

| Item | Rule |
| --- | --- |
| Key location | Env var named by `config.json` `quotaHubs[].keyEnv` (default `HERDR_USAGE_QUOTA_HUB_KEY`). The key value is **never** written to `config.json`, state, cache, logs, stdout/stderr, or error details. |
| Key transport | Sent only as `Authorization: Bearer <key>` to the configured hub origin over http(s). `hubBaseUrl` normalizes the URL (strips `management.html`, query, hash) and rejects non-http(s) schemes; the key is never sent anywhere else. |
| Provider tokens | Never enter this process. `api-call` requests carry `Authorization: Bearer $TOKEN$` — the hub substitutes the account's real token server-side. Only whitelisted `id_token` claims (`chatgpt_account_id`) are read for request headers, mirroring ADR-0014. |
| Hub responses | Treated as untrusted. Output carries account ids, provider ids, plan labels, and quota windows only — never raw response bodies, auth-file contents, or token material. Error `detail` strings carry HTTP status or transport summaries only. |
| Cache | `<state>/quota-cache/hub-<id>.json` stores `{checked_at, accounts:[{account, provider, plan, windows, reset_credits_available}]}` for the shared TTL — quota numbers and timestamps, never the management key, never `$TOKEN$`-resolved material, never auth-file payloads. |
| Mutation boundary | The plugin issues `GET auth-files` and `POST api-call` with upstream `method: "GET"` only. Reset-credit redemption and any other hub mutation remain out of scope (same as ADR-0014 rule 3). |
| Failure honesty | Missing key env → `no_credential`; hub 401/403 → `unauthorized`; other HTTP/transport/parse failure → `request_failed` (or last good reading flagged `stale: true`). Per-account failures are per-account statuses; they never fail the whole report. Disabled auth-files are skipped, not reported as successes. |

## Consequences

- Hub quota works without provider credentials on the local machine —
  the hub is the credential boundary, which is the point of the
  integration.
- A hub account cannot be proven to be the same subscription as the
  locally indexed transcripts, so `divergence` reports hub readings
  under `hubs` but excludes them from `comparisons` (documented in the
  contract).
- If the hub management API changes shape, the failure mode is a
  structured non-`ok` status — detectable, not silent.
- Configuring a hub requires editing `config.json` (URL + `keyEnv`
  name) **and** exporting the key — the secret never touches a file
  the plugin owns.
