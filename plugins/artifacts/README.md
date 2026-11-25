# rebuildup.artifacts

Artifact registry for herdr: registers, validates, indexes, and
delivers references to generated files (HTML pages, images, PDFs,
generic files). Contract: `herdr-plugins.artifacts/v1` — **draft**;
see [`docs/contracts/artifacts-v1.md`](../../docs/contracts/artifacts-v1.md),
the specification
[`docs/specs/artifacts.md`](../../docs/specs/artifacts.md), and the
design boundary
[`docs/adr/0024-artifacts-boundary.md`](../../docs/adr/0024-artifacts-boundary.md).

## What it does

`register` snapshots a file into plugin state (`state_copy`, default)
or records an external `path_ref` (opt-in); `list`/`get`/`search` read
the index with honest `missing_ref`/`owner_stale`/`oversize` reporting;
`delete` removes artifacts (`--force` required when `refs` exist).
Planned: `verify`, `deliver` (stable absolute path in prompt text —
v1 attachment definition; no structured attachment API exists in
herdr protocol 22), `gc` retention.

## What it does NOT do

- It never executes, renders, or proxies artifact content. Isolated
  HTML rendering, screenshots, and network/CSP policy are herdr-t3
  responsibilities (ADR-0024 §4).
- SnapShots (OS window capture) and browser import are out of scope
  (desktop/GUI). MCP Apps UI is upstream-blocked on #30.

## Status

T1 scaffold (#136) + T2 registry core (#141): `capability`, `help`,
`register`, `list`, `get`, `search`, `delete` are implemented;
`verify`/`deliver`/`gc` return `contract_draft` until T3–T4
(#142/#143). Contract `herdr-plugins.artifacts/v1` is still **draft**.
CLI-only plugin — no `[[actions]]`/`[[events]]`. Registry commands
need a reachable herdr session (`session.snapshot`) for identity and
staleness reporting.

## Usage

```bash
cd <plugin_root>
bun run src/cli.ts capability
bun run src/cli.ts register --path report.html --title "Weekly report"
bun run src/cli.ts list --kind html
bun run src/cli.ts get art-<id>
bun run src/cli.ts search "weekly" --kind html
bun run src/cli.ts delete art-<id> [--force]
```

Prerequisite: Bun on PATH (same as every plugin here).
