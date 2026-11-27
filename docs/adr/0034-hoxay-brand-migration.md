# ADR-0034: hoxay brand migration — product brand, stable identifiers, and runtime-infrastructure names

## Status

Accepted (design foundation for #275 / #276; execution boundary: first
work item of v0.12.0 development, after the v0.11.0 release)

## Context

herdr-t3's successor product brand is decided as **hoxay**
(rebuildup/herdr-t3#490, design originals in rebuildup/herdr-t3 PR #491).
The plugin repository `rebuildup/herdr-plugins` becomes an independent
**Hoxay Plugins** product: repository rename to `rebuildup/hoxay-plugins`,
updated distribution/install references, and coordinated updates in
depending repositories (herdr-t3, dotfiles, pc-setup).

Constraints from the program issue (#275):

- Git history, versions, Issues/PRs, and existing Releases must be
  preserved (GitHub rename redirect).
- No gratuitous breaking changes and no new hard dependency on the
  herdr-t3 product; **herdr runtime compatibility is not dropped** —
  herdr remains the execution substrate.
- The rename, public-identifier switch, and release→main merge are
  explicit-approval boundaries; this ADR fixes *what* changes and *what
  deliberately does not*.

## Decision

### 1. Three namespaces, three different fates

The migration distinguishes three identifier layers that are easy to
conflate:

| layer | examples | fate |
| --- | --- | --- |
| **Product brand** | repo `herdr-plugins` → `hoxay-plugins`; product-facing name "Hoxay Plugins"; README/marketing/docs voice | **Renamed** at the v0.12.0 boundary |
| **Stable technical identifiers** | plugin IDs `rebuildup.<name>` (25 plugins); capability contract names `herdr-plugins.<name>/vN`; plugin state/config dir keys; install path slug | **Preserved** (see §2–§3) |
| **Runtime-infrastructure names** | `herdr` binary, `herdr.sock`, `HERDR_*` env vars, `herdr plugin install`/manifest spec, pane/agent/socket APIs, `herdr-t3` sibling references | **Unchanged** — these belong to the herdr runtime and herdr-t3, not to this product |

Rationale: plugin IDs and contract names are *wire identifiers* consumed
by herdr (`plugin_id` in `herdr plugin list`), by persisted state
directories, by cross-plugin references (`rebuildup.handoff` records
naming `rebuildup.checkpoints`), and by herdr-t3's `plugin_call`
invocations. Renaming them would break every existing install, every
persisted state dir, and every external caller — a breaking change with
zero user benefit. The brand lives in the repository, documentation,
and distribution surface; identity lives in the identifiers.

### 2. Repository rename

- GitHub rename `rebuildup/herdr-plugins` → `rebuildup/hoxay-plugins`
  executed as the first v0.12.0 work item, under explicit maintainer
  approval (boundary per #275).
- Canonical remote, `AGENTS.md` project identity, README, and all
  in-repo references to `rebuildup/herdr-plugins` are updated in the
  same change. `herdr plugin install rebuildup/hoxay-plugins/plugins/<name>`
  becomes the documented install path.
- Git history, tags, versions, Issues, PRs, Releases, and Actions history
  are preserved by the rename. Local clones update via
  `git remote set-url` (old URL keeps working through the redirect, but
  new references use only the new name).

### 3. What the GitHub rename redirect does and does not guarantee

Verified against GitHub's rename documentation:

**Redirected (old name keeps working):**

- Web UI, Issues, Pull Requests, Wikis, Releases (incl. release asset
  URLs), repo settings.
- `git clone` / `git fetch` / `git push` to the old `github.com/
  rebuildup/herdr-plugins.git` URL.
- REST API v3 requests to `/repos/rebuildup/herdr-plugins/...`
  (HTTP redirect since 2015).

**NOT guaranteed — must be handled explicitly:**

- **GitHub Actions `uses:` references.** Workflows that consume actions
  hosted *in this repo* (`uses: rebuildup/herdr-plugins/...`) fail with
  `repository not found` after rename — actions are not redirected.
  Audit required: this repo currently hosts no published actions, but
  sibling repos (herdr-t3, dotfiles) must be checked for `uses:` pins.
- **A future repo created under the old name.** If anyone later creates
  `rebuildup/herdr-plugins` again, all redirects to `hoxay-plugins`
  silently break. Policy: the old name stays reserved/unused; if a
  legacy mirror is ever needed it must not reuse the name.
- **GitHub Pages sites** are not redirected (not used by this repo).
- **Third-party stored URLs** (bookmarks, CI caches keyed by repo,
  external docs, chat links) keep working only through the redirect —
  cosmetic staleness, not breakage; updated opportunistically.
- **Submodules** pointing at the old URL follow the redirect but should
  be repointed (none known in this repo; sibling repos checked in T3).

### 4. Install path and distribution

- Install path changes with the repo: `herdr plugin install
  rebuildup/hoxay-plugins/plugins/<name>`. The old path continues to
  resolve through the redirect during the transition; documentation and
  contracts record only the new path once the rename lands.
- Plugin IDs (`rebuildup.<name>`) do **not** change, so:
  - `herdr plugin list` `plugin_id` values are stable;
  - managed checkouts under herdr's plugin dir and persisted
    `state.json`/config keyed by plugin ID are preserved across the
    rename — **no user state migration**;
  - `herdr plugin install` of the new path updates the same plugin ID
    in place.
- The capability contract names `herdr-plugins.<name>/vN` are preserved
  as wire identifiers. They describe the contract family, not the
  repository; renaming them would break `contract` field checks in
  every consumer without changing any behavior. A future contract
  revision MAY introduce `hoxay-plugins.*` names only with a
  dual-accept transition — out of scope for the initial migration.
- Other persisted wire namespaces are likewise preserved: git ref
  prefix `refs/herdr-plugins/checkpoints/` (checkpoints plugin),
  systemd `Description=` labels are cosmetic and may adopt the new
  product name, and unpublished workspace package scope
  `@herdr-plugins/*` is renamed to `@hoxay-plugins/*` (private,
  workspace-only, no external consumers).

### 5. Explicit non-goals

- No herdr compatibility drop: manifest spec, socket API, pane/action
  model, `HERDR_*` env contract all unchanged.
- No plugin ID, contract name, state-dir, or CLI binary rename.
- No new dependency on herdr-t3 or any hoxay-branded component.
- No version renumbering: the migration rides the normal release
  train; Git tags and plugin versions continue.
- No rewrite of git history, Issues, or Releases.

### 6. Execution sequencing (v0.12.0 first work item)

1. **T1 (#276, this ADR)** — contract fixed.
2. **T2 (#277)** — repo rename + in-repo reference update (AGENTS.md,
   README, docs/contracts, docs/program, plugin READMEs, CI if any
   self-references exist). Single PR under explicit approval.
3. **T3 (#278)** — sibling-repo updates via their own Issues:
   herdr-t3 (`plugin_call` targets, install-path docs, machines-v1
   contract consumption notes), dotfiles/pc-setup (install procedures),
   portfolio-assets and any other referencing repos found by grep.
   `uses:` action pins audited repo-wide in step T3 before rename if
   any exist (none known at ADR time — re-verify).
4. Post-rename verification: fresh `herdr plugin install` from the new
   path, plugin ID/state continuity check, sibling-repo install-path
   smoke.

## Consequences

- Users see "Hoxay Plugins" as the product/repo name while every
  technical identifier stays `rebuildup.*`/`herdr-plugins.*` — an
  intentional, documented split between brand and wire identity.
- The old repo URL remains a working redirect indefinitely *unless* the
  old name is ever reused — recorded as a standing policy.
- herdr-t3 and other consumers need only documentation/path updates;
  no contract or ID migration on their side.
- If a future decision ever requires renaming plugin IDs or contract
  names, it must be a separate ADR with an explicit dual-accept
  migration plan — this ADR deliberately keeps them stable.
