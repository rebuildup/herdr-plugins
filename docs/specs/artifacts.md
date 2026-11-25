# Artifacts plugin (`rebuildup.artifacts`) — specification

Scope: T1 foundation (#136) — upstream inventory confirmation,
responsibility boundary, storage policy, v1 attachment definition, and
the draft contract skeleton `herdr-plugins.artifacts/v1`. Registry
implementation lands in T2 (#141), kind validation/search in T3
(#142), delivery/integration in T4 (#143). Design:
ADR-0024. Contract: `docs/contracts/artifacts-v1.md` (**draft**).

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

The plugin validates HTML *shape* (extension + `<!doctype html>`/
`<html>` prefix, upstream `HtmlRender` rules) and records metadata
only. It never executes, renders, or proxies content. Render-time
sandbox/CSP/network isolation is a herdr-t3 requirement; contract
notes state this normatively.

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

## Plugin surface (T1 scaffold)

`plugins/artifacts/` is a CLI-only plugin: no `[[actions]]` /
`[[events]]` in v1 (registry is explicit CLI invocation; a lazy drain
or hook can be added once consumers define trigger semantics — same
convention as `rebuildup.conversations`). `capability` reports
`contract_status: "draft"` and the full planned command list;
registry commands return `contract_draft` until implemented.
