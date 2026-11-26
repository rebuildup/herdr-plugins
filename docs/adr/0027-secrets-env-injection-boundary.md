# ADR-0027: Secrets reference resolution and env-injection boundary

Status: Accepted (release-0-8-0 candidate, Issue #34 / parent #160 —
secrets residual of `secrets-remote-devices`)

## Context

#34's canonized inventory
(`docs/research/secrets-remote-devices-inventory.md`, t3code
`9cc4018c`, herdr 0.9.5 / protocol 22) assigns the secret-provider
residual to a plugin ticket (#160): T3Code stores provider references
(`op://vault/item/field`) in credential fields and resolves them at
use time; herdr-plugins needs the equivalent reference-resolution +
injection path for Infisical (canonical per the binding
`secrets-management` skill) so project scripts, controls/handoff agent
launch surfaces, and textgen API-key resolution share one contract.

The binding constraints:

- Credential boundary family: ADR-0014 (use-don't-hold OAuth tokens),
  ADR-0015 (hub management key env-var only), ADR-0018-textgen
  (`<config>/keys/<id>.key`). Each new credential source must extend
  this ADR or a successor — this ADR is that successor for provider
  secret *references*.
- Repo invariants: no ambient secret inheritance or logging; config
  and durable state only under herdr-provided plugin dirs; unsupported
  or unverifiable outcomes are never reported as success.
- herdr 0.9.5 reality (live-verified): `agent start` accepts no env;
  the only env injection points are `workspace create --env`,
  `tab create --env`, `pane split --env` (API `env:
  HashMap<String,String>` in the create/split params). Secret values
  therefore transit herdr API parameters — inside the herdr server
  process and into the launched surface's process environment. That
  transit is the intended injection, and it defines the boundary.
- `.agents/skills/secrets-management/SKILL.md` is binding: Infisical
  (`https://secrets.rebuildup.dev`) is the canonical provider;
  least-privilege identity scoping; secret values never in
  Git/logs/Issue/PR/checkpoint; honest failure, no silent fallback.

## Decision

### 1. Provider scope: Infisical only in v1

The v1 contract (`herdr-plugins.secrets/v1`, implemented by #160)
resolves **Infisical references only**. Reference syntax is
provider-namespaced (`infisical:<env>:<path>:<secret>` — exact grammar
fixed in the #160 spec). `op://` references are **not** resolved in
v1: 1Password is optional compatibility under the skill, not canonical;
supporting it adds a second CLI dependency and a second credential
authority path for zero current consumer. If a consumer later requires
it, a successor ADR extends the provider enum — the namespaced scheme
already leaves room.

Resolution uses the official `infisical` CLI (`infisical secrets get`
/ `infisical run` equivalent paths) per invocation; the plugin never
stores Infisical tokens, service tokens, or machine-identity
credentials. Auth material stays wherever the user/CI already put it
(`infisical login` session, env vars the user exported); the plugin
inherits the caller's environment for the child `infisical` process —
same trust domain as running the CLI directly — and adds nothing.

### 2. Consent model: declared bindings + explicit per-invocation selection

Consent has two layers, both explicit and reviewable:

- **Declaration (standing consent).** `config.json` holds named
  *bindings*: `{name, env, ref}` where `ref` is an Infisical reference
  and `env` is the target environment variable name. A binding is the
  only thing the plugin will ever resolve or inject. There is no
  wildcard, no "inject everything", no project-file auto-discovery
  (`t3.json`-style declarations are rejected — the plugin config dir
  is the single declaration point per AGENTS §4).
- **Invocation (per-use consent).** Every action names its bindings:
  `run --binding <name> -- <cmd>`, `inject --binding <name> --surface
  …`, `resolve --binding <name>` (metadata only, see §3). Nothing is
  injected implicitly; `capability` lists binding *metadata* (name,
  env, ref, provider reachability) and never values.

Ambient environment is never harvested: the plugin does not scan
`process.env` for secret-shaped variables, does not forward ambient
secrets into injected surfaces beyond what the user’s own shell already
did, and strips nothing silently — it simply never *adds* undeclared
values.

### 3. Transit boundary: values exist only between provider and sink

A resolved secret value has exactly two legal sinks:

1. **Child process environment** — `run` executes the wrapped command
   with the resolved env map (equivalent to `infisical run -- <cmd>`).
2. **herdr surface-creation `env` params** — `inject` calls
   `workspace create` / `tab create` / `pane split` with `--env`
   entries for the declared binding only.

Rules:

- **Never persisted.** Values are never written to plugin
  config/state/logs, never cached (not even TTL caches — resolution is
  per-invocation), never placed in argv (the `infisical` CLI is spawned
  with fixed argv; values move via env/stdin contracts only).
- **Never emitted.** No CLI surface prints a resolved value. `resolve`
  returns `{name, env, resolved: true|false, status}` metadata only.
  There is no `--emit-env`/eval escape hatch in v1; a consumer that
  needs shell-eval ergonomics must add it via successor ADR.
- **Env-name hygiene.** Binding `env` names colliding with the
  `HERDR_*` reserved prefix are rejected at declaration time (plugins
  must not shadow herdr session context). Names are otherwise the
  user's contract — including conventional `*_KEY`/`*_TOKEN` names,
  since the *name* is not secret.
- **Sink honesty.** `inject` reports the created surface id and the env
  *names* injected — never values. Because values transit the herdr
  API, they are visible to the herdr server process and the target
  pane's process env by design; the plugin does not claim otherwise
  and does not extend that visibility (no injection into
  `agent.start` args, prompts, pane titles, or metadata tokens).
- **Failure honesty.** Unresolvable reference → structured
  `unresolved`/`provider_unreachable`/`auth_missing` per binding;
  partial multi-binding resolution reports per-binding status and
  never a fabricated all-or-nothing success. No fallback to ambient
  env, config-dir key files, or another provider (skill §13: no silent
  second canonical store).

### 4. Relationship to existing credential surfaces

- textgen API generators (ADR-0018-textgen) keep their own
  `<config>/keys/<id>.key` / env-var path in v1; #160 may later offer
  Infisical resolution as an *additional* key source, which would be a
  textgen-contract amendment, not a change here.
- usage quota/hub credentials (ADR-0014/0015) are provider-owned
  artifacts read in-process; secrets-plugin references are a
  different class (user-declared env injection) and do not merge.

## Consequences

- #160 implements `resolve` (metadata) / `run` (wrapped exec) /
  `inject` (surface env) / `capability` against fake-`infisical`
  contract tests, then live-verifies env delivery into a pane on an
  isolated herdr session.
- The boundary is auditable: every value flow is provider → memory →
  one of two sinks; everything else is metadata.
- `op://` support, eval-style emission, and ambient-env harvesting are
  explicitly deferred/rejected — each needs a successor ADR.
- If Infisical is unreachable, consumers degrade to structured errors;
  per skill §13 there is no managed-cloud fallback and no plaintext
  `.env` materialization in v1.
