# Contract `herdr-plugins.artifacts/v1` (DRAFT)

Structured JSON CLI contract for the `rebuildup.artifacts` herdr
plugin — an artifact registry that registers, validates, indexes,
and delivers references to generated files (HTML pages, images, PDFs,
generic files). Design boundary:
[`docs/adr/0024-artifacts-boundary.md`](../adr/0024-artifacts-boundary.md).
Specification: [`docs/specs/artifacts.md`](../specs/artifacts.md).

**Status: DRAFT.** T1 (#136) shipped `capability`/`help`; T2 (#141)
implements the registry core `register`/`list`/`get`/`search`/`delete`;
`verify`/`deliver`/`gc` remain planned for T3–T4 (#142/#143). The
contract is versioned `herdr-plugins.artifacts/v1` from the start;
fields may be added additively, removals/renames require a version
bump.

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
# --- registry core (implemented T2 #141) ---
bun run src/cli.ts register --path FILE [--kind KIND] [--storage state_copy|path_ref]
                                 [--title TEXT] [--pane PANE] [--created-by CREATED_BY]
                                 [--ref REF ...] | --stdin
bun run src/cli.ts list    [--kind KIND] [--pane PANE] [--session NAME] [--limit N]
bun run src/cli.ts get     <artifact_id>
bun run src/cli.ts search  <query> [--kind KIND] [--pane PANE] [--session NAME] [--since ISO] [--limit N]
bun run src/cli.ts delete  <artifact_id> [--force]
# --- planned (T3 #142 / T4 #143) ---
bun run src/cli.ts verify  [<artifact_id>]
bun run src/cli.ts deliver --pane PANE|--agent PANE <artifact_id>
bun run src/cli.ts gc      [--older-than ISO] [--dry-run]
```

- All commands print exactly one JSON document on stdout. Handled
  errors print `{contract, ok:false, error:{code,message,kind?}}` on
  **stderr** and exit 1; usage errors exit 2.
- `capability`/`help` work without a reachable herdr session.
  Registry commands (`register`/`list`/`get`/`search`/`delete`) resolve
  the live session via `session.snapshot` for host/session/owner
  identity and `owner_stale` reporting; unreachable session →
  `kind:"session_unreachable"` exit 1.
- `register` accepts `--path FILE` or `--stdin` (bytes on stdin;
  `path_ref` storage requires `--path` since stdin has no stable
  ref). `--kind` is inferred from extension then leading-byte MIME
  when omitted. `--ref` is repeatable and lands in `refs` (additive
  back-references). `delete` refuses records with non-empty `refs`
  unless `--force` is passed (`referenced`).

## `capability`

```json
{
  "contract": "herdr-plugins.artifacts/v1",
  "contract_status": "draft",
  "command": "capability",
  "plugin": "rebuildup.artifacts",
  "version": "0.1.0",
  "read_only": false,
  "mutation_commands": ["register", "delete"],
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

### Read surfaces (T2)

`list`/`get`/`search` return records annotated at read time:
`missing_ref: true` + `storage_ref_missing` warning when the payload
is gone, unsafe (symlink inside the artifacts tree), or the recorded
`resolved_path` does not match the index layout; `owner_stale: true` +
`owner_stale` warning when `owner.pane_id` is absent from the live
snapshot. `oversize` is recomputed for `path_ref` (a file that grew
past the cap after register is reported, not hidden). `list`/`search`
also report top-level `orphans` (payload dirs with no index record)
and `corrupt` (index ids whose records failed parsing). None of these
are failures — they are honest degradation, per AGENTS §4.

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
| `mime_mismatch` | `invalid` on refusal | sniffed type disagrees with declared kind; refusal only for `kind:"html"`, warning otherwise |
| `source_not_found` / `source_not_file` / `source_unreadable` | `not_found` / `invalid` / `unavailable` | register source missing, not a regular file, or unreadable |
| `storage_ref_missing` (`missing_ref`) | reported on reads (`missing_ref: true` + `storage_ref_missing` warning) | path_ref target vanished/unreadable, or state_copy payload missing/symlinked |
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
