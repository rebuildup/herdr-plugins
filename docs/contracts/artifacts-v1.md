# Contract `herdr-plugins.artifacts/v1` (STABLE)

Structured JSON CLI contract for the `rebuildup.artifacts` herdr
plugin — an artifact registry that registers, validates, indexes,
and delivers references to generated files (HTML pages, images, PDFs,
generic files). Design boundary:
[`docs/adr/0024-artifacts-boundary.md`](../adr/0024-artifacts-boundary.md).
Specification: [`docs/specs/artifacts.md`](../specs/artifacts.md).

**Status: STABLE (v1).** T1 (#136) shipped `capability`/`help`; T2
(#141) implemented the registry core `register`/`list`/`get`/
`search`/`delete`; T3 (#142) added kind-specific validation, richer
search filters, and `verify`; T4 (#143) added `deliver`/`gc`/`export`
and stabilized the contract. From here the contract changes
**additively only** — new commands, new optional fields, new enum
values; removals, renames, and semantic changes require a version
bump (`herdr-plugins.artifacts/v2`).

## Discovery

1. `herdr plugin list --json` → find `plugin_id == "rebuildup.artifacts"` →
   `plugin_root`.
2. `cd <plugin_root> && bun run src/cli.ts capability` → verify
   `contract == "herdr-plugins.artifacts/v1"`, `contract_status ==
   "stable"`, and the commands you need exist.

## Invocation

```bash
cd <plugin_root>
bun run src/cli.ts capability          # implemented (T1)
bun run src/cli.ts help                # implemented (T1)
# --- registry core (T2 #141) + verify (T3 #142) ---
bun run src/cli.ts register --path FILE [--kind KIND] [--storage state_copy|path_ref]
                                 [--title TEXT] [--pane PANE] [--created-by CREATED_BY]
                                 [--ref REF ...] | --stdin
bun run src/cli.ts list    [--kind KIND] [--pane PANE] [--agent SESSION] [--created-by CREATED_BY]
                           [--session NAME] [--limit N]
bun run src/cli.ts get     <artifact_id>
bun run src/cli.ts search  <query> [--kind KIND] [--pane PANE] [--agent SESSION]
                           [--created-by CREATED_BY] [--session NAME]
                           [--since ISO] [--until ISO] [--limit N]
bun run src/cli.ts verify  [<artifact_id>]
bun run src/cli.ts delete  <artifact_id> [--force]
# --- delivery / retention / client export (T4 #143) ---
bun run src/cli.ts deliver --pane PANE|--agent PANE <artifact_id> [--note TEXT]
bun run src/cli.ts gc      --older-than ISO [--dry-run]
bun run src/cli.ts export  [--kind KIND] [--pane PANE] [--agent SESSION]
                           [--created-by CREATED_BY] [--session NAME] [--limit N]
```

- All commands print exactly one JSON document on stdout. Handled
  errors print `{contract, ok:false, error:{code,message,kind?}}` on
  **stderr** and exit 1; usage errors exit 2.
- `capability`/`help` work without a reachable herdr session.
  Session-bound commands (`register`/`list`/`get`/`search`/`verify`/
  `delete`/`deliver`/`export`) resolve the live session via
  `session.snapshot` for host/session/owner identity, `owner_stale`
  reporting, and deliver target staleness; unreachable session →
  `kind:"session_unreachable"` exit 1. `gc` is pure plugin-state work
  and needs no session (it runs offline).
- `register` accepts `--path FILE` or `--stdin` (bytes on stdin;
  `path_ref` storage requires `--path` since stdin has no stable
  ref). `--kind` is inferred from extension then leading-byte MIME
  when omitted. `--ref` is repeatable and lands in `refs` (additive
  back-references). `delete` refuses records with non-empty `refs`
  unless `--force` is passed (`referenced`).
- Kind validation at `register` (T3): `kind:"html"` is the only
  refusal kind — path sources must resolve to a `.html`/`.htm` name
  and the bytes must open like a document (`<!doctype html`/`<html`
  after optional whitespace/BOM, upstream `HtmlRender` rules);
  `image`/`pdf`/`file`/`other` never refuse on content — a concrete
  sniffed MIME that disagrees with the kind family reports
  `mime_mismatch`, and one that disagrees with the filename extension
  reports `extension_mime_mismatch` (generic `text/plain` /
  `application/octet-stream` sniffs report neither). `kind:"html"`
  records carry `meta.render` (`{isolation:"required",policy:"client"}`)
  as the render-time notice; sandbox/CSP remains a client duty.
- `list`/`search` owner filters: `--pane` (exact `owner.pane_id`),
  `--agent` (exact `owner.agent_session`), `--created-by` (exact
  `owner.created_by`), `--session` (record session name). `search`
  adds `--since`/`--until` ISO-8601 bounds on `created_at` (invalid
  values are usage errors) and free-text matching over identity,
  kind/mime, filename, owner fields, host, session, and `refs` —
  metadata only, never payload bytes.
- `deliver` requires exactly one of `--pane` (plain pane →
  `pane.send_text`, literal text, no Enter) or `--agent` (pane hosting
  a live agent → `agent.prompt`, which submits to the agent).
  `--note TEXT` appends a note line to the message. See
  [Delivery](#delivery-deliver) below.
- `gc` requires `--older-than ISO` (invalid → usage error) and
  supports `--dry-run`. See [Retention](#retention-gc) below.
- `export` is the herdr-t3 client read surface: the same annotated
  records as `list`, unfiltered by default (`--limit N` truncates and
  `complete:false` reports it honestly). Metadata + `resolved_path`
  only — never payload bytes.

## `capability`

```json
{
  "contract": "herdr-plugins.artifacts/v1",
  "contract_status": "stable",
  "command": "capability",
  "plugin": "rebuildup.artifacts",
  "version": "0.2.0",
  "read_only": false,
  "mutation_commands": ["register", "delete", "deliver", "gc"],
  "commands": ["capability", "register", "list", "get", "search", "verify", "delete", "deliver", "gc", "export"],
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

`limits.max_bytes` are the per-kind caps in bytes (upstream T3 values:
image 10 MiB, others 25 MiB). For `path_ref` records the cap is not
enforced at register — oversize is reported as `oversize: true` on
`get`/`list` and left to the client.

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
  "warnings": ["optional structured warnings, e.g. mime_mismatch, extension_mime_mismatch, oversize, owner_stale"],
  "meta": {
    "render": { "isolation": "required", "policy": "client" }
  }
}
```

### Cross-plugin references (`refs`, additive)

`refs[]` entries are opaque strings supplied at `register` (`--ref`,
repeatable) by the owning plugin or user. Consumers SHOULD use a
`<plugin>:<kind>/<id>` shape so `search`/`delete` reference detection
stays meaningful across plugins:

- `conversations:session/<session_key>` / `conversations:event/<id>` —
  transcript index entries that produced or consumed the artifact.
- `handoff:record/<handoff_id>` — handoff payload referencing the
  artifact (handoff payload refs may point back via
  `external`/`uri` refs carrying the `artifact_id` or `resolved_path`;
  the relationship is additive in both directions and neither side
  copies the other's state).
- `checkpoints:entry/<id>` — checkpoint diff that produced the
  artifact.

`delete` refuses any record with non-empty `refs` unless `--force`
(`referenced`); `gc` skips referenced records the same way. The plugin
never resolves or validates ref targets — resolution is the consumer's
job through the owning plugin's public contract.

`meta` is optional advisory metadata. It is present only for
`kind:"html"` and records the render-isolation notice: consumers must
render HTML inside an isolated context and own sandbox/CSP/network
policy (`policy:"client"`); the plugin never executes or renders
content (ADR-0024 §4). Malformed persisted `meta` is dropped on read,
never quarantines the record.

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

## Verification (`verify`, T3 #142)

`verify [<artifact_id>]` re-checks records against the filesystem —
entity existence, sha256 re-hash, size, re-sniffed MIME, storage-layout
consistency, and oversize-flag consistency. It is a read-only health
report: per-artifact `status` is `ok`, `corrupt`, or `missing`, and
the command exits 0 even when artifacts are unhealthy (usage/session
errors still exit 1/2).

```json
{
  "contract": "herdr-plugins.artifacts/v1",
  "ok": true,
  "command": "verify",
  "results": [
    {
      "artifact_id": "art-…",
      "status": "ok | corrupt | missing",
      "issues": ["sha256_mismatch", "…"],
      "checks": {
        "payload_exists": true,
        "sha256_match": true,
        "size_match": true,
        "mime_match": true
      },
      "artifact": { "…annotated record, same shape as get…" }
    }
  ],
  "summary": { "total": 1, "ok": 1, "corrupt": 0, "missing": 0 },
  "orphans": [],
  "corrupt": []
}
```

Status rules: `missing` — payload absent, not a regular file, or
unsafe (symlink inside the artifacts tree); issue
`storage_ref_missing`. `corrupt` — payload present but a check failed
or record metadata is inconsistent; issue codes: `sha256_mismatch`,
`size_mismatch`, `mime_drift`, `storage_ref_invalid` (state_copy
`resolved_path` does not match the index layout),
`oversize_flag_inconsistent` (flag disagrees with current size vs the
kind cap). `ok` — all checks pass. Register-time warnings are
historical facts and are not re-reported as verify issues; `path_ref`
drift (the external file changed after register) surfaces as
`corrupt` with `sha256_mismatch`/`size_mismatch`. With no
`artifact_id`, every index record is verified and `summary` counts
the three statuses; `orphans`/`corrupt` report index-level
inconsistencies exactly like `list`/`search`.

## Error model

```json
{ "contract": "herdr-plugins.artifacts/v1", "ok": false,
  "error": { "code": "artifact_not_found", "message": "…", "kind": "not_found" } }
```

on stderr, exit 1. `error.code` is the contract-specific code,
`error.kind` the coarse category (`not_found`/`invalid`/`unavailable`/
`stale`/`warning`/`session_unreachable`):

| code | kind | meaning |
| --- | --- | --- |
| `artifact_not_found` | `not_found` | unknown or malformed artifact_id |
| `target_not_found` | `not_found` | deliver target pane absent from the live session (stale/wrong-session pane) |
| `agent_not_found` | `not_found` | deliver `--agent` target pane has no live agent in the snapshot |
| `missing_ref` | `not_found` | deliver refused: payload absent/unsafe (a dead path is never delivered); on reads it surfaces as `missing_ref: true` + warning instead |
| `delivery_failed` | `unavailable` | deliver send rejected/failed; upstream RPC `code` preserved in `rpc_code` (e.g. `agent_blocked`) |
| `path_outside_root` / `traversal_denied` | `invalid` | path-traversal / symlink escape attempt |
| `too_large` | `invalid` | state_copy exceeds per-kind cap |
| `mime_mismatch` | `invalid` on refusal | sniffed type disagrees with declared kind; refusal only for `kind:"html"`, warning otherwise |
| `invalid_html` | `invalid` | `kind:"html"` path source whose resolved name is not `.html`/`.htm` (upstream `HtmlRender` file rule) |
| `source_not_found` / `source_not_file` / `source_unreadable` | `not_found` / `invalid` / `unavailable` | register source missing, not a regular file, or unreadable |
| `owner_stale` | `stale` | owner identity no longer matches live snapshot (warning, not failure, on reads) |
| `referenced` | `warning` | delete/gc target still referenced by handoff/conversations/checkpoint payloads; requires `--force` |
| `session_unreachable` | `unavailable` | herdr socket unreachable |
| `state_corrupt` | `unavailable` | index/record inconsistent beyond deterministic repair |
| `lock_timeout` | `unavailable` | single-writer lock not acquired |
| `unsupported_kind` | `invalid` | kind outside `kinds` |
| `usage` | — | usage error, exit 2 (missing/invalid flags, bad timestamps) |

## Delivery (`deliver`)

v1 attachment = the artifact's stable absolute path embedded in
`agent.prompt` / `pane.send_text` text assembled by `deliver`. There is
no structured pane/agent attachment API in herdr protocol 22; that gap
is recorded as an upstream Issue candidate (ADR-0024 §3), not worked
around.

```bash
deliver --agent PANE <artifact_id> [--note TEXT]   # agent.prompt to the pane's live agent
deliver --pane  PANE <artifact_id> [--note TEXT]   # pane.send_text (literal text, no Enter)
```

Exactly one of `--pane`/`--agent` is required; `--agent` takes the
pane id hosting the agent (herdr resolves the target). Caveat
(verified live, herdr 0.9.5): `pane.send_text` delivers literal text,
but embedded newlines reach the PTY as Enter — on an interactive
shell pane each message line executes. Prefer `--agent` for agent
panes; `--pane` is for targets where literal text (or per-line
submission) is intended. The message is
deterministic and auditable:

```
[artifacts] art-… — html artifact "title"
path: /absolute/resolved/path
mime: text/html · size: 1234 bytes · sha256: <hex>
note: <optional --note>
```

Success payload:

```json
{
  "contract": "herdr-plugins.artifacts/v1",
  "ok": true,
  "command": "deliver",
  "target": { "kind": "agent | pane", "pane_id": "w1:p1" },
  "method": "agent.prompt | pane.send_text",
  "message": "<exact text sent>",
  "artifact": { "…annotated record, same shape as get…" }
}
```

Refusals (structured, never silent — see error model):

- `artifact_not_found` — unknown/malformed id.
- `missing_ref` — payload absent/unsafe; a dead path is never
  delivered (reads report the same condition as a warning instead).
- `target_not_found` — pane absent from the live `session.snapshot`
  (closed pane, wrong session, stale id). Deliver never types into the
  void.
- `agent_not_found` — `--agent` pane exists but has no live agent.
- `delivery_failed` — herdr rejected the send or the transport failed;
  `rpc_code` preserves the upstream code (e.g. `agent_blocked`).

Delivery is side-effect free on the index: the sent text lives in
pane/agent scrollback, which the plugin does not own, so no `refs`
entry is fabricated. Consumers that need a durable back-reference
register the artifact with `--ref` or record the delivery in their own
state.

## Retention (`gc`)

`gc --older-than ISO [--dry-run]` collects expired artifact records —
same shape as checkpoints `gc`. Candidates are records whose
`created_at` is strictly before `--older-than`; v1 has no default
retention window, so the flag is required.

- Referenced records (`refs` non-empty) are **never** collected:
  reported `skipped`/`reason:"referenced"`; explicit `delete --force`
  remains the only path.
- `state_copy` candidates lose index record + payload dir;
  `path_ref` candidates lose only the index record — external files
  are never deleted by the plugin.
- Records with unparseable `created_at` are skipped
  (`invalid_created_at`), never guessed-expired.
- Orphan payload dirs (no index record) are reported via `orphans`,
  not collected — without a record there is no honest age/ownership
  evidence.
- `--dry-run` performs the full evaluation with zero mutation.

```json
{
  "contract": "herdr-plugins.artifacts/v1",
  "ok": true,
  "command": "gc",
  "policy": { "older_than": "ISO-8601" },
  "dry_run": false,
  "evaluated": 12,
  "expired": 3,
  "entries": [
    { "artifact_id": "art-…", "action": "deleted", "storage_mode": "state_copy", "removed_payload": true },
    { "artifact_id": "art-…", "action": "skipped", "reason": "referenced", "storage_mode": "state_copy" },
    { "artifact_id": "art-…", "action": "would_delete", "storage_mode": "path_ref" }
  ],
  "totals": { "evaluated": 12, "expired": 3, "deleted": 2, "would_delete": 0,
              "skipped_referenced": 1, "skipped_other": 0, "kept": 9, "errors": 0 },
  "orphans": [],
  "corrupt": []
}
```

`action` is `deleted` | `would_delete` (dry-run) | `skipped`;
`reason` is `referenced` | `invalid_created_at` | `delete_failed`
(per-entry `error` carries the message; `totals.errors` counts them —
one failed deletion never aborts the rest).

## Export (`export`)

`export` is the stable read surface herdr-t3 and other clients consume:
one JSON document with every annotated artifact record (same shape and
read-time annotations as `list`/`get`), the `orphans`/`corrupt`
index-level fields, and filter echo. It carries **metadata +
`resolved_path` only — never payload bytes**; opening/rendering the
payload is the client's responsibility under the safety boundary
below. `--limit N` truncates the page; `complete:false` +
`returned < total` report the truncation honestly (default: complete).

## Safety boundary (normative)

The plugin **never executes, renders, or proxies artifact content**.
For `kind:"html"` it performs shape validation only (extension +
`<!doctype html>`/`<html>` leading bytes, upstream `HtmlRender`
rules). Render-time sandboxing, CSP, and network isolation are
**herdr-t3/client requirements**; consumers must not assume the plugin
sanitized content beyond the metadata it reports.
