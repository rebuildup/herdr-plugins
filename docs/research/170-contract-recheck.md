# Contract/security re-check — issue #170 (release-safety gate)

Audit trail for the #170 release-safety re-evaluation of the four
highest-risk plugin surfaces on `release-0-8-0` @ `83c4b37`
("merge: propagate #83/#96 fixes from release-0-7-0"). Method: source
read of every resolution/delivery/restore path plus the existing test
suites; one throwaway negative probe for the secrets provider-stderr
path (not committed — see finding S-1). No branch switches, no merges;
verification ran in a dedicated worktree.

Test evidence (all run with ambient `HERDR_*` stripped):

| Suite | Result |
| --- | --- |
| `tests/secrets.test.ts`, `tests/herdr-target.test.ts`, `tests/git-env.test.ts` | 62 pass / 0 fail |
| `tests/mcp*.test.ts` (4 files) | 43 pass / 0 fail |
| `tests/checkpoints*.test.ts`, `tests/automations*.test.ts` (6 files) | 123 pass / 0 fail |
| `tests/secrets-stderr-sanitization.test.ts` (new, skipped negative fixture) | 1 skip / 0 fail |

## 1. rebuildup.secrets — value containment — PASS with one finding

Sinks verified:

- `run` child env = `process.env` + resolved bindings, spawned once with
  `stdio: "inherit"` (`plugins/secrets/src/cli.ts:411-414`). Values never
  enter argv, parent env is not mutated, nothing is persisted — the only
  `writeFile` in the plugin is the declarations-only `config --init`
  (`plugins/secrets/src/config.ts:156-170`).
- `inject` forwards the env map exactly once inside herdr surface-create
  params and reports env *names* only (`plugins/secrets/src/inject.ts:51-62`,
  `cli.ts:487-501`).
- `resolve`/`capability`/`config` emit metadata only — no `env`/values
  section exists in the output shape (`cli.ts:369-383, 536-557`).
- Provider child env is the caller's env plus optional declared
  `tokenEnv → INFISICAL_TOKEN`; the token value never appears in argv
  (`plugins/secrets/src/provider.ts:114-125`).
- Resolution failures abort `run`/`inject` before any side effect
  (`cli.ts:394-408, 460-474`); spawn errors carry `err.message` only.
- No state dir, run records, delivered artifacts, or hook payloads exist
  in this plugin — nothing to leak into.

**Finding S-1 (low–medium, defense-in-depth): provider stderr is echoed
verbatim into emitted output.** `classifyFailure`
(`plugins/secrets/src/provider.ts:55-58`) embeds up to 300 chars of raw
provider stderr into `detail`, which lands in `resolve` stdout JSON
(`cli.ts:259-266`), the `run`/`inject` stderr error envelopes
(`cli.ts:395-406, 461-472`), and `capability --probe` reachability
(`cli.ts:323-327`). Verified empirically: a fake `infisical` printing
`LEAKED-PROVIDER-STDERR-SECRET-9f8e7d` to stderr and exiting 9 produced
`"detail": "provider error: token=LEAKED-PROVIDER-STDERR-SECRET-9f8e7d
request dump"` in the `resolve` document. Under normal operation the
Infisical CLI does not print resolved values, but a hostile
`--domain`/`--infisical-bin`, verbose error paths, or a token echo would
leak secret-shaped material into plugin output, weakening the ADR-0027
§3 "never emitted" boundary. Recommendation: classify failures into
fixed strings (or scrub stderr of env/token values) instead of quoting
provider output. Negative fixture added:
`tests/secrets-stderr-sanitization.test.ts` — `test.skip` until the
redaction lands (un-skipping reproduces the leak).

## 2. rebuildup.mcp — access-level enforcement — PASS

- Gate is before dispatch for every tool, implemented or not:
  `ACCESS_RANK[def.spec.access] > ACCESS_RANK[ctx.accessLevel]` →
  `capability_denied` (`plugins/mcp/src/tools.ts:1815-1828`). Default
  level is `read-only` (`model.ts:36`); unknown `--access-level` is a
  usage error (`cli.ts:54-59`).
- TOOL_TABLE audit (`model.ts:57-232`): every mutation tool is
  `supervised`+ (`agent_prompt`, `agent_interrupt`, `agent_start`,
  `workspace_create`, `handoff_invoke`); `agent_wait` is read-only and
  backs onto `agent.wait`, a server-side blocking read (no mutation —
  `plugins/controls/src/cli.ts:378-405`, `packages/herdr-client/src/
  agents.ts:100-108`). `usage_report` deliberately omits `--refresh`
  (`tools.ts:1337-1339`). No handler performs a mutation under a
  read-only spec; no bypass path exists outside `callTool`.
- `agent_start` additionally caps provider `permission_mode` by access
  level and pins the cap when unspecified (`tools.ts:1463-1489`).
- Stale-generation guards: `resolveAgent` re-reads the live snapshot +
  `agent.get` and applies `expect_state_seq`/`expect_agent_session`/
  `expect_pane` before any side effect (`tools.ts:234-303`); the pane's
  presence in the live snapshot is verified; `agent_start` requires the
  pane in the live snapshot before launch (`tools.ts:1491-1494`) and
  forwards `--expect-*` to controls.
- Sibling-plugin spawn env (`plugincli.ts:227-239`): all ambient
  `HERDR_PLUGIN_*` and pane-scoped vars are stripped, then the target
  plugin's state/config dirs, `HERDR_PLUGIN_ID`, and resolved
  `HERDR_SOCKET_PATH` are pinned; `--socket` is appended to argv.
  Non-HERDR ambient env (incl. user auth tokens) is inherited — same
  trust domain as the sibling CLIs themselves (ADR-0013 pattern);
  noted, not a leak.
- `herdr plugin list` discovery spawn inherits env with stderr ignored
  (`plugincli.ts:88-101`) — read-only probe, no secret surface.

## 3. rebuildup.checkpoints — restore safety — PASS

- Pre-restore capture is mandatory and persisted BEFORE any mutation:
  `attemptRestore` captures `kind:"pre_restore"` and writes it to state
  before `restoreWorktree` runs (`plugins/checkpoints/src/cli.ts:907-920`);
  capture failure refuses the restore with nothing touched.
- Shared-worktree refusal: `assertRestoreIsolation` counts live panes
  whose cwd is inside the repo root; ≥2 sharing panes → `shared_worktree`
  unless `--force`; unreachable session also refuses (fail-closed)
  (`cli.ts:761-790`). `restore-group` members get the same check.
- User index: capture never touches it — scratch `GIT_INDEX_FILE` under
  the git common dir, removed in `finally`
  (`plugins/checkpoints/src/capture.ts:240-310`, test "create captures
  worktree state without touching the user index" green). Restore
  intentionally syncs index+worktree via `git restore --source --staged`
  and post-verifies both sides plus a `git clean -dn` sweep
  (`plugins/checkpoints/src/restore.ts:184-271`) — documented upstream
  T3 Code parity, recoverable via the pre-restore ref.
- Hidden refs live under `refs/herdr-plugins/checkpoints/<repoKey>/<id>`
  with `repoKey` = sha256 of the canonical root and random ids
  (`capture.ts:30,75-86`); restore resolves the ref to an OID via
  `verifyRef` then restores by OID (`cli.ts:886-920`); `deleteRef` uses
  `--no-deref` (`capture.ts:332-343`). No user-ref collision path.
- Foreign repo: `--repo` must share the checkpoint's git common dir
  (realpath-compared); otherwise `repo_mismatch` (`cli.ts:676-701`);
  covered by test "restore rejects … foreign --repo" (green).
- State writes: single-writer lock + tmp+rename
  (`plugins/checkpoints/src/state.ts:190-235`).

## 4. rebuildup.automations — delivery safety — PASS

- Honest failure: `deliverRun` never fabricates success — transport
  errors → `socket_unavailable`, destination resolution failures →
  `destination_unavailable`/`unsupported_destination`, server rejections
  mapped by code (`plugins/automations/src/execute.ts:120-135,259-366`).
  `handoff-execute` is schema-reserved and fails `unsupported_destination`
  rather than silently delivering (`execute.ts:289-297`). Preflight
  (`session.snapshot`) runs BEFORE any run record is created
  (`cli.ts:420-427`) — unreachable herdr yields no fabricated run.
- Idempotency: key `task_id + scheduled_for`; blocking statuses
  (`scheduled|running|success|failed`) return the existing record;
  `skipped`/`missed`/`cancelled` don't block legitimate retries
  (`registry.ts:92-142, 482-565`). `prepareFire` re-validates the
  instant against the schedule, enabled window, and future bound;
  `createOccurrenceRun` dedups under the single-writer lock
  (`registry.ts:573-589`). Event bursts reuse the same key
  (`registry.ts:854-903`).
- Scheduler adapters: argv-array `execFile`/plist/unit-file writes, no
  shell interpolation; tick argv carries only bun + cli path + absolute
  socket (`plugins/automations/src/scheduler.ts:42-44,75-95,113-124,
  206-247,297-318`); unsupported platforms report `unsupported_platform`
  honestly. Tick inherits ambient env — same trust domain; no secret
  material is placed in argv or unit files.
- Event marks: hooks only append `{event, received_at, data}` marks —
  no socket work, capped at `MAX_PENDING_EVENTS` with counted drops
  (`plugins/automations/src/hook.ts:42-75`, `registry.ts:702-710`).
  `tick` drains marks against `on`+`filter` inside the task's enabled
  window (`registry.ts:785-912`); delivery always re-resolves the
  destination live (`agentGet` before `agentPrompt`,
  `execute.ts:267-285`), so a mark can never act on a stale recorded
  generation — it fires against current pane state only. There is no
  agent_session dimension in v1 event filters; noted as a contract
  property, not a gap.
- Run status observation folds only hook-observed `agent_status` into
  `result.agent_status` of the latest delivered run on that pane —
  observed values only, never a fabricated completion
  (`registry.ts:722-747`).

## 5. #83/#96 fix completeness on this branch — PASS

- `resolveTarget` (`packages/herdr-client/src/socket.ts:414-503`):
  precedence `--socket` > `--session` > `HERDR_SOCKET_PATH` >
  `HERDR_SESSION` > default; every contradiction (flag↔flag,
  flag↔env, env↔env, socket↔session mismatch) throws
  `target_conflict`; `mutation:true` rejects the implicit default with
  `target_required` (`socket.ts:495-501`). `ambientIdentity` fails
  closed on env-vs-context pane contradiction (`socket.ts:628-644`) and
  `assertAmbientPaneIdentity` on workspace/tab mismatch or unverifiable
  fields (`socket.ts:654-680`).
- Routing: `plugins/git` sets `options.mutation = true` at the top of
  every mutation handler before any `sessionSnapshot`/`reportPaneMetadata`
  call (`plugins/git/src/cli.ts:719,748,821,855,879,910,1035,1222`;
  `reportPaneMetadata` at :1274 inherits it); `plugins/inbox` does the
  same for organize/wake/reconcile/watch (`plugins/inbox/src/cli.ts:
  318,484,499,517`) and the hook pins `mutation:true`
  (`plugins/inbox/src/hook.ts:53,65,93`); `plugins/projects` sets it for
  `scripts run`/`scripts stop` before `runnerDeps` →
  `sessionKeyFor({mutation})` + transport (`plugins/projects/src/cli.ts:
  925,967,811-815`; `runner.ts:88-101`).
- Env hygiene: every git/gh spawn site uses the sanitized env —
  `packages/git-core/src/index.ts:47-56` (`runGit`) and `:224-229`
  (`runGitBounded`), `plugins/git/src/git.ts:655-661`,
  `plugins/git/src/gh.ts:44-51` (`ghChildEnv`). Repo-wide grep for
  `spawn(`/`spawnSync(`/`execFile(`/`Bun.spawn` found no other
  git/gh spawn site; remaining spawns are herdr/plugin-CLI/infisical
  children outside the GIT_*/GH_* scope (inbox `_wake` re-invokes its
  own CLI with explicit `--socket`/`--session`, `cli.ts:462-476`).
  `sanitizedChildEnv` strips the full retarget/injection GIT_* set +
  prefixes and preserves auth/identity config deliberately
  (`packages/git-core/src/git-env.ts:70-205`); `tests/git-env.test.ts`
  green.

## Verdict

PASS on all four surfaces and on the #83/#96 propagation, with one
recorded finding: **S-1** — provider stderr passthrough into emitted
`detail` (low–medium; negative fixture committed as
`tests/secrets-stderr-sanitization.test.ts`, skipped pending a
redaction fix). Recommend a follow-up issue to sanitize
`classifyFailure` detail strings; it does not block the 0-8.0 contract
as written because resolved values themselves never traverse stderr —
but the boundary is weaker than "never emitted" under adversarial
provider output.
