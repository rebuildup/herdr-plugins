# ADR-0022: Artifacts plugin responsibility boundary, storage policy, and v1 attachment definition

Status: Accepted (release-0-7-0 candidate, Issue #136 / parent #31 T1 —
first ticket of the #31 Artifacts/Snapshots decomposition; T2–T4 are
#141/#142/#143)

## Context

#31 asks for the T3Code artifact surface (attachments, HTML renders,
MCP Apps, SnapShots, browser import) mapped onto herdr. The #31
research comment (pinned T3Code revision `9cc4018c`, herdr 0.9.5 /
protocol 22) produced this upstream inventory:

- **attachmentStore / attachmentPaths** (`apps/server/src/`):
  thread-scoped attachment ids (`pending` → claim two-phase),
  `resolveAttachmentPath(ById)` path-traversal guards, MIME/leading-byte
  sniffing, per-kind size caps (image 10 MiB / HTML page 25 MiB), stale
  pending sweep. Attachments persist as durable references on chat
  messages.
- **htmlRender** (`apps/server/src/htmlRender/`): HTML document
  validation (extension + `<!doctype html>`/`<html>` prefix), size cap,
  theme fragment injection, isolated `headlessChrome.ts` screenshot
  measurement, `publicProxy.ts` allowing only public resources and
  blocking private IPs. Agents can screenshot-verify their own HTML
  before publish.
- **mcpApps** (`apps/server/src/mcpApps/`): MCP Apps standard
  (`modelcontextprotocol/ext-apps`) `ui://` resources snapshot into
  thread attachments (`McpAppSnapshot`) with CSP injection,
  permissions meta, size caps; tool results carry interactive apps that
  web/desktop/mobile render.
- **SnapShots** (`docs/user/snap-shot.md`,
  `docs/internals/linux-snap-shot.md`): OS window capture
  (macOS/Windows/Wayland, accessibility data) → image attachment to a
  draft. Desktop-app-only, OS-specific.
- **browser-import** (`docs/user/browser-import.md`): cookie import
  into the desktop preview browser. GUI responsibility.
- **question-attachments** (`docs/user/question-attachments.md`):
  prompt attachments (image/file) — provider-capability dependent.

Measured herdr capability (protocol 22): there is **no** attachment /
preview / render API. `agent.prompt` / `pane.send_text` carry text;
there is no structured file-attachment path to a pane or agent. Plugin
durable state is confined to `HERDR_PLUGIN_CONFIG_DIR` /
`HERDR_PLUGIN_STATE_DIR` (AGENTS §4).

## Decision

### 1. Responsibility boundary

`rebuildup.artifacts` owns **artifact registry concerns only**:

- registration with identity, kind classification, MIME/leading-byte
  validation, and per-kind size enforcement;
- identity `Host/Session/Artifact` (+ optional owner pane/agent
  reference) so stale organize/ownership state can never alias a
  different generation (AGENTS §4 identity invariant);
- list/get/search/delete over plugin state;
- delivery references: producing a stable absolute path other plugins
  and clients can consume;
- honest reporting of missing/corrupt/orphaned storage
  (`missing_ref`, `owner_stale`, …) — never reported as success.

`herdr-t3` / GUI clients own everything that executes, captures, or
renders:

- isolated HTML rendering, screenshot measurement, `publicProxy`-style
  network policy — the plugin ships **metadata only** and never
  executes or renders artifact content;
- SnapShots (OS window capture) — not feasible for a headless plugin;
- browser import — GUI-only;
- MCP Apps UI — additionally depends on #30 (MCP surface) which does
  not exist yet; recorded as upstream-blocked, not implemented here.

### 2. Storage policy: bounded state-copy default + opt-in external reference

Two storage modes, decided per artifact at `register` time:

- **`state_copy` (default)**: the artifact bytes are copied into
  `HERDR_PLUGIN_STATE_DIR/artifacts/<artifact_id>/`. This mirrors
  upstream `attachmentStore` (the store owns the bytes, so deleting or
  moving the source cannot break a durable reference). Hard per-kind
  caps apply at copy time; exceeding → `too_large` refusal.
- **`path_ref` (opt-in, `--storage path_ref`)**: the record stores the
  resolved `realpath` of an external file; no bytes are copied. Used
  for artifacts that are already durable and large (build outputs,
  repo files). Size is recorded via `stat`; oversize is a structured
  `oversize` flag + warning, not a refusal — the client decides at
  render/delivery time. A vanished or unreadable target is reported as
  `missing_ref` on read, never as success.

Rationale: copy-by-default gives the identity/stability guarantees the
contract promises; path-ref avoids duplicating large immutable
artifacts while keeping honest degradation. The per-kind caps follow
the upstream T3 values (image 10 MiB, HTML/pdf/file/other 25 MiB) as
draft defaults; the total artifacts budget is bounded by `gc`
(retention, T4 #143) rather than a hard quota in v1.

Symlink policy: `state_copy` sources are read through `realpath` and
the *resolved* size/MIME are validated; symlinks *inside* the plugin
state artifacts tree are never followed (lstat check) so a corrupted
or hostile state dir cannot escape the root.

### 3. Attachment definition for v1: path reference in prompt text

"Attach an artifact to an agent" in v1 means: deliver the artifact's
stable absolute path inside `agent.prompt` / `pane.send_text` text
(e.g. `deliver --pane <id>` assembles path + short description; the
send itself is delegated to the herdr API). Providers already accept
filesystem paths in prompts, and the pane runs on the same host, so a
structured attachment API is **not required for v1**.

Upstream gap assessment: a structured pane/agent attachment API
(protocol 22 has none) would only be needed if providers require
non-path attachment parts (inline images, provider-specific upload
APIs). That is recorded as an **upstream Issue candidate**, deferred —
not worked around by fabricating attachment state.

### 4. Safety boundary for HTML artifacts

The plugin validates shape only (extension + `<!doctype html>`/`<html>`
leading bytes, per upstream `HtmlRender` rules) and records metadata
(`kind`, `size`, `mime`, `created_by`, `storage_ref`). It never
executes, renders, or proxies artifact content; render-time sandbox /
CSP / network isolation is a **herdr-t3 requirement**, stated in the
spec and contract notes so consumers cannot assume the plugin sanitized
beyond metadata.

### 5. Feature classification (feature-ledger `artifacts-snapshots`)

| Upstream surface | Classification | Reason / resolution |
| --- | --- | --- |
| Artifact registry (register/list/get/search/delete/verify/deliver/gc) | **plugin** (#136→#143) | Feasible headless; owns state + validation only |
| HTML render / screenshot / public proxy | **gui-integration** (herdr-t3) | Requires isolated browser runtime; plugin provides metadata + path only |
| question-attachments delivery | **plugin** (v1 = path-in-prompt) | Structured API is upstream gap candidate, deferred |
| SnapShots (OS window capture) | **not-feasible** for plugin → herdr-t3/desktop | OS-specific capture APIs; no plugin runtime for it |
| browser-import | **out-of-scope** (GUI) | Desktop preview browser concern |
| MCP Apps (`ui://` resources, interactive tool results) | **upstream-blocked** | Depends on #30 MCP surface + client rendering; revisit after #30 |

## Consequences

- Contract `herdr-plugins.artifacts/v1` starts as **draft**; T2–T4
  (#141/#142/#143) implement registry, validation/search, and
  delivery/export against this boundary.
- Consumers must treat `storage_ref` paths as opaque handles resolved
  through the contract; raw-path retrieval is not part of the API.
- `path_ref` artifacts can disappear; all read surfaces must surface
  `missing_ref` honestly (AGENTS §4).
