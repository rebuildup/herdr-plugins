# Contract `herdr-plugins.artifacts/v1` (DRAFT)

Structured JSON CLI contract for the `rebuildup.artifacts` herdr
plugin — an artifact registry that registers, validates, indexes,
and delivers references to generated files (HTML pages, images, PDFs,
generic files). Design boundary:
[`docs/adr/0024-artifacts-boundary.md`](../adr/0024-artifacts-boundary.md).
Specification: [`docs/specs/artifacts.md`](../specs/artifacts.md).

**Status: DRAFT (T1, Issue #136).** Only `capability` and `help` are
implemented in this revision; the registry commands below are the
committed skeleton that T2–T4 (#141/#142/#143) implement. The contract
is versioned `herdr-plugins.artifacts/v1` from the start; fields may
be added additively, removals/renames require a version bump.

## Discovery

1. `herdr plugin list --json` → find `plugin_id == "rebuildup.artifacts"` →
   `plugin_root`.
2. `cd <plugin_root> && bun run src/cli.ts capability` → verify
   `contract == "herdr-plugins.artifacts/v1"`, `contract_status ==
   "draft"`, and the commands you need exist.

## Invocation

```bash
cd <plugin_root>
bun run src/cli.ts capability          # implemented (T1)
bun run src/cli.ts help                # implemented (T1)
# --- planned registry surface (T2 #141 / T3 #142 / T4 #143) ---
bun run src/cli.ts register --path FILE [--kind KIND] [--storage state_copy|path_ref]
                                 [--title TEXT] [--pane PANE] [--session NAME]
bun run src/cli.ts list    [--kind KIND] [--pane PANE] [--session NAME] [--limit N]
bun run src/cli.ts get     <artifact_id>
bun run src/cli.ts search  <query> [--kind KIND] [--pane PANE] [--since ISO] [--limit N]
bun run src/cli.ts verify  [<artifact_id>]
bun run src/cli.ts delete  <artifact_id> [--force]
bun run src/cli.ts deliver --pane PANE|--agent PANE <artifact_id>
bun run src/cli.ts gc      [--older-than ISO] [--dry-run]
```

- All commands print exactly one JSON document on stdout. Handled
  errors print `{contract, ok:false, error:{code,message,kind?}}` on
  **stderr** and exit 1; usage errors exit 2.
- `capability`/`help` work without a reachable herdr session.
  Registry commands resolve the live session via `session.snapshot`
  unless `--offline`-style read-only operation is documented per
  command; unreachable session → `kind:"session_unreachable"` exit 1.

## `capability`

```json
{
  "contract": "herdr-plugins.artifacts/v1",
  "contract_status": "draft",
  "command": "capability",
  "plugin": "rebuildup.artifacts",
  "version": "0.1.0",
  "read_only": false,
  "mutation_commands": ["register", "delete", "gc"],
  "commands": ["capability", "register", "list", "get", "search", "verify", "delete", "deliver", "gc"],
  "kinds": ["html", "image", "pdf", "file", "other"],
  "storage_modes": ["state_copy", "path_ref"],
  "limits": {
    "max_bytes": { "html": 26214400, "image": 10485760, "pdf": 26214400, "file": 26214400, "other": 26214400 },
    "path_ref_oversize": "warn"
  },
  "notes": ["…"],
  "generated_at": "…"
}
```

`limits.max_bytes` are the draft per-kind caps in bytes (upstream T3
values: image 10 MiB, others 25 MiB; tunable before stable). For
`path_ref` records the cap is not enforced at register — oversize is
reported as `oversize: true` on `get`/`list` and left to the client.

## Artifact record

Every artifact is one JSON record in the plugin state index
(`HERDR_PLUGIN_STATE_DIR`), committed under the single-writer lock +
atomic-rename discipline (AGENTS §4):

```json
{
  "contract": "herdr-plugins.artifacts/v1",
  "artifact_id": "art-<unique>",
  "kind": "html | image | pdf | file | other",
  "title": "optional display name",
  "host": "<host identity of the registering herdr installation>",
  "session": "<herdr session name>",
  "owner": {
    "pane_id": "optional",
    "agent_session": "optional provider session value",
    "created_by": "pane | agent | handoff | script | cli | unknown"
  },
  "storage": {
    "mode": "state_copy | path_ref",
    "ref": "state-relative path under artifacts/ OR resolved absolute path",
    "resolved_path": "absolute path consumers may open (state_copy: inside state dir; path_ref: the realpath)"
  },
  "size": 12345,
  "mime": "text/html",
  "sha256": "<hex>",
  "oversize": false,
  "created_at": "ISO-8601",
  "refs": ["optional back-references: conversations event, handoff payload, checkpoint — additive"],
  "warnings": ["optional structured warnings, e.g. mime_mismatch, owner_stale"]
}
```

### Identity and scoping

- `artifact_id` is unique within the plugin state index; records are
  always addressed by id, never by raw path. Identity carries
  `host` + `session` + optional `owner` so consumers can detect stale
  generation (a record whose owner pane/agent no longer matches the
  live snapshot is `owner_stale`, not deleted or hidden).
- **Path-traversal policy**: retrieval commands accept only
  `artifact_id` matching `^art-[A-Za-z0-9_-]+$`; state files are stored
  under `artifacts/<artifact_id>/<sanitized-filename>`; symlinks inside
  the artifacts tree are rejected (lstat); `path_ref` sources are stored
  as `realpath` results. No contract command accepts an arbitrary
  filesystem path for reading artifact content.
- **Size policy**: `state_copy` refuses `size > limits.max_bytes[kind]`
  with `too_large`; `path_ref` records `oversize: true` + warning when
  over the kind cap.

## Error model

```json
{ "contract": "herdr-plugins.artifacts/v1", "ok": false,
  "error": { "code": "artifact_not_found", "message": "…", "kind": "not_found" } }
```

on stderr, exit 1. Planned `error.code` values (draft):

| code | kind | meaning |
| --- | --- | --- |
| `artifact_not_found` | `not_found` | unknown or malformed artifact_id |
| `path_outside_root` / `traversal_denied` | `invalid` | path-traversal / symlink escape attempt |
| `too_large` | `invalid` | state_copy exceeds per-kind cap |
| `mime_mismatch` | `warning`-class; refusal only for `html` kind per spec | sniffed type disagrees with declared kind |
| `storage_ref_missing` (`missing_ref`) | `unavailable` | path_ref target vanished/unreadable |
| `owner_stale` | `stale` | owner identity no longer matches live snapshot (warning, not failure, on reads) |
| `referenced` | `warning` | delete/gc target still referenced by handoff/conversations/checkpoint payloads; requires `--force` |
| `session_unreachable` | `unavailable` | herdr socket unreachable |
| `state_corrupt` | `unavailable` | index/record inconsistent beyond deterministic repair |
| `lock_timeout` | `unavailable` | single-writer lock not acquired |
| `unsupported_kind` | `invalid` | kind outside `kinds` |
| `contract_draft` | `unavailable` | command not yet implemented in draft revisions (until stable) |

## Safety boundary (normative)

The plugin **never executes, renders, or proxies artifact content**.
For `kind:"html"` it performs shape validation only (extension +
`<!doctype html>`/`<html>` leading bytes, upstream `HtmlRender`
rules). Render-time sandboxing, CSP, and network isolation are
**herdr-t3/client requirements**; consumers must not assume the plugin
sanitized content beyond the metadata it reports.

## Delivery (`deliver`, planned T4)

v1 attachment = the artifact's stable absolute path embedded in
`agent.prompt` / `pane.send_text` text assembled by `deliver`. There is
no structured pane/agent attachment API in herdr protocol 22; that gap
is recorded as an upstream Issue candidate (ADR-0024 §3), not worked
around.
