# ADR-0018: textgen API-generator credential boundary

Status: Accepted (release-0-6-0 candidate, Issue #107 / parent #29 T1)

## Context

`rebuildup.textgen` can call third-party text-generation APIs
(OpenAI, Anthropic, OpenAI-compatible endpoints) when the user opts in.
That makes the plugin an API-key consumer — the same credential class
ADR-0014 (provider OAuth tokens, quota probes) and ADR-0015 (hub
management keys) bound for `rebuildup.usage`. Those ADRs' rules apply
by extension: "any new credential-reading source must extend this ADR
(or a successor)". This ADR is that successor for generation API keys.

Threats specific to generation (vs. quota reads):

- Prompts carry user content (diffs, conventions, thread context) to a
  third-party endpoint — the *destination* must be explicit and
  user-configured, never ambient.
- Keys are long-lived bearer secrets; a leak into logs, state, argv,
  or error text is unrecoverable.
- Per-token billing means accidental calls cost money — opt-in must be
  structural, not advisory.

## Decision

1. **Opt-in is structural.** An API generator exists only as an
   `apiGenerators[]` entry in `config.json` with `enabled: true`.
   `config add-api-generator` writes entries *disabled* unless `--enable`
   is passed. Disabled generators are inert: they cannot be resolved as
   providers and appear in `capability` as `enabled: false`.
2. **Key location: env var or config-dir key file — never config.json.**
   Resolution order per invocation:
   - env var named by `keyEnv` (default
     `HERDR_TEXTGEN_<ID>_API_KEY`), then
   - `<HERDR_PLUGIN_CONFIG_DIR>/keys/<id>.key` (trimmed, single value).
   The value is used only inside the request closure as the
   `Authorization: Bearer` (OpenAI-compatible) or `x-api-key`
   (Anthropic) header. It is never written to state, never logged,
   never included in error `detail`/`message`, never placed in argv
   (the plugin makes HTTPS requests in-process via `fetch`).
3. **Endpoint allowlist = configured endpoints only.** Keys are sent
   only to the `endpoint` configured for that generator. `endpoint`
   must be `https:`; plain `http:` is permitted only for loopback
   hosts (`localhost`, `127.0.0.1`, `::1`) to support local
   OpenAI-compatible servers. Other schemes/hosts are rejected with
   `provider_endpoint_insecure` before the key is even read.
4. **Remote environment disclosure.** The configured `endpoint` *is*
   the disclosure: task input leaves the machine only to that origin.
   `capability` reports each enabled generator's endpoint so the
   destination is inspectable; `generate` results record the provider
   id (`api:<id>`), never the key.
5. **No caching of prompts or responses.** Generation is per-invocation;
   nothing is persisted under the state dir. (If caching is ever added
   it must store outputs only — never keys, and with the same TTL/GC
   discipline as ADR-0016.)
6. **Failure honesty.** Missing credential → `no_credential`
   (structured, per-generator). HTTP/transport failure →
   `api_request_failed` carrying status only — provider error bodies
   are not echoed (they can reflect request context). Non-JSON or
   textless responses → `api_bad_response`. None of these paths
   include credential material.
7. **Input boundary applies unchanged.** The same task input
   allowlist and credential-pattern guard (`input_secret_detected`)
   run before any API call — an API generator must never receive
   secrets embedded in the payload either.

## Consequences

- API generation cannot happen accidentally: no config entry, no call;
  entry without `enabled: true`, no call; no key, structured
  `no_credential` — never a silent fallback to another credential.
- The user's existing subscription agent CLIs remain the zero-marginal-
  cost default (ADR-0017 resolution order).
- Self-hosted OpenAI-compatible endpoints (Ollama, LM Studio, internal
  gateways) work over loopback http or https without weakening the
  boundary for remote hosts.
- If a future need arises for stored keys (e.g. OS keychain), it
  requires a successor ADR — config-dir key files are the v1 maximum.
