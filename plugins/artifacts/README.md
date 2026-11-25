# rebuildup.artifacts

Artifact registry for herdr: registers, validates, indexes, and
delivers references to generated files (HTML pages, images, PDFs,
generic files). Contract: `herdr-plugins.artifacts/v1` — **draft**;
see [`docs/contracts/artifacts-v1.md`](../../docs/contracts/artifacts-v1.md),
the specification
[`docs/specs/artifacts.md`](../../docs/specs/artifacts.md), and the
design boundary
[`docs/adr/0022-artifacts-boundary.md`](../../docs/adr/0022-artifacts-boundary.md).

## What it does (planned)

`register` snapshots a file into plugin state (`state_copy`, default)
or records an external `path_ref`; `list`/`get`/`search`/`verify` read
the index; `delete`/`gc` remove artifacts with reference warnings;
`deliver` sends an artifact's stable absolute path to an agent/pane
inside prompt text (v1 attachment definition — no structured
attachment API exists in herdr protocol 22).

## What it does NOT do

- It never executes, renders, or proxies artifact content. Isolated
  HTML rendering, screenshots, and network/CSP policy are herdr-t3
  responsibilities (ADR-0022 §4).
- SnapShots (OS window capture) and browser import are out of scope
  (desktop/GUI). MCP Apps UI is upstream-blocked on #30.

## Status

T1 scaffold (#136): only `capability` and `help` are implemented;
registry commands return `contract_draft` until T2–T4
(#141/#142/#143). CLI-only plugin — no `[[actions]]`/`[[events]]`.

## Usage

```bash
cd <plugin_root>
bun run src/cli.ts capability
bun run src/cli.ts help
```

Prerequisite: Bun on PATH (same as every plugin here).
