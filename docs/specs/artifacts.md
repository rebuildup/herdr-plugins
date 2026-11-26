# Artifacts plugin (`rebuildup.artifacts`) — specification

Scope: T1 foundation (#136) — upstream inventory confirmation,
responsibility boundary, storage policy, v1 attachment definition, and
the contract skeleton `herdr-plugins.artifacts/v1`. T2 (#141)
implements the registry core: `register`/`list`/`get`/`search`/`delete`
with identity, traversal guards, size caps, leading-byte MIME sniff,
sha256, and honest missing/stale reporting. T3 (#142) deepens
kind-specific validation (upstream `HtmlRender`/`attachmentStore`
rules), extends search filters, and adds `verify` integrity checks.
T4 (#143) adds `deliver` (v1 path-in-prompt attachment), `gc`
retention, `export` (client read surface), cross-plugin `refs`
conventions, live verification, and **stabilizes the contract**.
Design: ADR-0024. Contract: `docs/contracts/artifacts-v1.md`
(**stable**).

## Purpose

Give agents and clients a durable, honest registry for generated
artifacts — HTML pages, images, PDFs, and generic files — with stable
identity (`Host/Session/Artifact`), validation, search, and delivery
references, without the plugin ever executing or rendering content.

## Upstream inventory (confirmed, T3Code `9cc4018c`)

| Surface | Upstream location | herdr mapping |
| --- | --- | --- |
| Thread attachment store | `apps/server/src/attachmentStore.ts`, `attachmentPaths.ts` | plugin state index + `artifacts/` store; two-phase `pending`→claim collapses to synchronous `register` (single-writer lock makes the intermediate state unnecessary) |
| Path-traversal-safe resolution | `resolveAttachmentPath(ById)` | artifact_id-only retrieval; `realpath` + lstat symlink rejection (contract §identity) |
| MIME/leading-byte sniff + per-kind size caps | attachmentStore | register-time validation; caps image 10 MiB / html·pdf·file·other 25 MiB (draft) |
| HTML validation + isolated render | `apps/server/src/htmlRender/` (`HtmlRender.ts`, `headlessChrome.ts`, `publicProxy.ts`) | **split**: plugin keeps shape validation + metadata; isolated render/screenshot/public-proxy is herdr-t3 |
| MCP Apps `ui://` snapshots | `apps/server/src/mcpApps/` (`McpAppSnapshot`) | **upstream-blocked**: needs #30 MCP surface + client rendering; not implemented |
| SnapShots (OS window capture) | `docs/user/snap-shot.md`, `docs/internals/linux-snap-shot.md` | **not-feasible** for plugin → herdr-t3/desktop |
| browser-import | `docs/user/browser-import.md` | **out-of-scope** (GUI) |
| question-attachments | `docs/user/question-attachments.md` | v1 = path reference inside prompt text; structured attachment API is an upstream gap candidate |

## Responsibility boundary (ADR-0024 §1)

- **Plugin owns**: registration, identity, kind classification,
  MIME/leading-byte validation, size enforcement, list/get/search/
  delete/verify, delivery references (stable absolute path), honest
  stale/missing reporting.
- **herdr-t3 / GUI owns**: isolated rendering, screenshot measurement,
  network/CSP policy for rendered HTML, SnapShots capture,
  browser import, MCP Apps UI.
- **Upstream gap**: structured pane/agent attachment API (protocol 22
  has none). v1 delivers paths in prompt text; a structured API is an
  Issue candidate only if providers require non-path attachment parts.

## Storage policy (ADR-0024 §2)

- `state_copy` (default): bytes copied under
  `HERDR_PLUGIN_STATE_DIR/artifacts/<artifact_id>/`; per-kind cap
  enforced at copy (`too_large` refusal). Durable against source
  deletion — mirrors upstream attachmentStore ownership.
- `path_ref` (opt-in): record stores the `realpath` of an external
  file; size via `stat`; over-cap → `oversize: true` warning, not
  refusal. Vanished target → `missing_ref` on read, never success.
- Symlinks inside the artifacts tree are never followed; `path_ref`
  sources are stored resolved. Total-budget enforcement is `gc`
  retention (T4), not a v1 quota.

## Attachment definition (ADR-0024 §3)

v1 "attach" = stable absolute artifact path embedded in
`agent.prompt`/`pane.send_text` text (`deliver`, T4). No structured
attachment API exists in protocol 22; none is fabricated.

## Safety boundary (ADR-0024 §4)

The plugin validates HTML *shape* — upstream `HtmlRender` rules:
resolved `.html`/`.htm` file name for path sources plus document-start
bytes (`<!doctype html`/`<html>` after optional whitespace/BOM,
anchored; a doctype buried mid-document does not qualify) — and
records metadata only, including `meta.render`
(`{isolation:"required",policy:"client"}`) as the render-isolation
notice. It never executes, renders, or proxies content. Render-time
sandbox/CSP/network isolation is a herdr-t3 requirement; contract
notes state this normatively.

## Kind validation (T3 #142)

- `html` is the only refusal kind: non-`.html`/`.htm` path names fail
  `invalid_html`; non-document leading bytes fail `mime_mismatch`
  (both `kind:"invalid"`). `--stdin` html is judged on content alone.
- `image`/`pdf`/`file`/`other` never refuse on content. A concrete
  sniffed MIME (not `text/plain`/`application/octet-stream`) that
  disagrees with the kind family → `mime_mismatch` warning; one that
  disagrees with the filename extension → `extension_mime_mismatch`
  warning. Both are structured strings in `warnings[]`, surfaced on
  `get`/`list`/`search`/`verify`.

## Verification (`verify`, T3 #142)

`verify [<artifact_id>]` re-checks entity existence, sha256 re-hash,
size, re-sniffed MIME, storage-layout consistency, and oversize-flag
consistency. Per-artifact `status` is `ok`/`corrupt`/`missing` with
structured `issues` (`sha256_mismatch`, `size_mismatch`, `mime_drift`,
`storage_ref_invalid`, `oversize_flag_inconsistent`,
`storage_ref_missing`); the command exits 0 — it is a report, not a
gate. No id verifies the whole index and returns `summary` counts plus
the same `orphans`/`corrupt` index-level fields as `list`/`search`.

## Search (T3 #142)

`search <query>` filters by kind, owner (`--pane`, `--agent` =
`owner.agent_session`, `--created-by`), record `--session`, and
`--since`/`--until` ISO-8601 period bounds (invalid timestamps are
usage errors). Free text matches metadata only — artifact id, title,
kind, mime, filename, owner fields, host, session, `refs`
(conversation/handoff back-references) — never payload bytes. `list`
shares the kind/owner/session filters.

## Identity, traversal, and limits (acceptance criteria)

- Identity: `artifact_id` (`art-*`, unique in the index) + `host` +
  `session` + optional `owner{pane_id, agent_session, created_by}`;
  stale owner → `owner_stale` warning, never silent reuse.
- Traversal: retrieval accepts only validated `artifact_id`; state
  layout `artifacts/<id>/<sanitized-name>`; symlink escape rejected.
- Limits: `state_copy` hard cap per kind (draft: image 10 MiB, others
  25 MiB); `path_ref` oversize → warning flag.

## State and concurrency

State lives only under `HERDR_PLUGIN_STATE_DIR` (AGENTS §4):
`state.json` index + `artifacts/` payloads. Single-writer lock file +
tmp+rename commits; concurrent CLI invocations cannot interleave.
Index/record inconsistencies (missing entity, orphan file) are
resolved deterministically at read and reported (`missing_ref`,
`state_corrupt`) — never as success.

## Plugin surface

`plugins/artifacts/` is a CLI-only plugin: no `[[actions]]` /
`[[events]]` in v1 (registry is explicit CLI invocation; a lazy drain
or hook can be added once consumers define trigger semantics — same
convention as `rebuildup.conversations`).

- T1 (#136): `capability`/`help`, contract skeleton.
- T2 (#141): `register` (`--path` or `--stdin`; `state_copy` default /
  `path_ref` opt-in; kind inference ext→MIME; html shape refusal;
  per-kind caps; sha256), `list`/`get`/`search` (kind/pane/session/
  since/limit filters; `missing_ref`/`owner_stale`/`oversize`
  annotation; `orphans`/`corrupt` reporting), `delete` (`refs` →
  `referenced` unless `--force`; payload cleanup for `state_copy`;
  external files never removed for `path_ref`). All registry commands
  resolve `session.snapshot` and fail `session_unreachable` when the
  socket is down.
- T3 (#142): kind-specific validation (anchored html document-start +
  `.html`/`.htm` path rule → `invalid_html`/`mime_mismatch` refusals;
  `mime_mismatch`/`extension_mime_mismatch` warnings for other kinds;
  `meta.render` isolation notice on html records), search filters
  (`--agent`/`--created-by`/`--until`, ISO-validated bounds, metadata
  free-text incl. `refs`), and `verify` (`ok`/`corrupt`/`missing`
  integrity re-check: existence, sha256, size, mime, storage-layout
  and oversize-flag consistency).
- T4 (#143): `deliver`, `gc`, `export` — contract **stable**.

## Delivery (`deliver`, T4 #143)

`deliver --agent PANE|--pane PANE <artifact_id> [--note TEXT]` sends
the artifact's stable absolute path inside delivery text:
`--agent` → `agent.prompt` to the pane's live agent (submits);
`--pane` → `pane.send_text` (literal text, no Enter). The message is
`[artifacts] <id> — <kind> artifact "<title>"` + `path:`/`mime:`/
`size:`/`sha256:` lines (+ optional `note:`). Refusals: stale/unknown
pane (`target_not_found`), agentless pane for `--agent`
(`agent_not_found`), missing payload (`missing_ref` — a dead path is
never delivered), upstream send rejection (`delivery_failed` with
`rpc_code`, e.g. `agent_blocked`). Delivery writes nothing to the
index — scrollback is not plugin-owned state.

## Retention (`gc`, T4 #143)

`gc --older-than ISO [--dry-run]` (checkpoints-gc shape; no default
retention window, offline-capable): expired = `created_at` strictly
before the bound. Referenced records are skipped (`referenced`),
`path_ref` externals are never deleted, unparseable `created_at` is
skipped not guessed, orphan payload dirs are reported not collected.

## Export (`export`, T4 #143)

`export` is the herdr-t3 read surface: the complete annotated index
(same records/annotations as `list`/`get`) + `orphans`/`corrupt` +
filter echo, metadata + `resolved_path` only. `--limit N` truncates
with `complete:false`.

## Cross-plugin references (T4 #143)

`refs[]` uses `<plugin>:<kind>/<id>` (`conversations:session/…`,
`handoff:record/…`, `checkpoints:entry/…`); consumers MAY point back
through their own payload refs (additive both directions). `delete`
and `gc` honor non-empty `refs` via `referenced`/skip — never silent.
