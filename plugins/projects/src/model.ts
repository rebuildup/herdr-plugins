/**
 * Read model for rebuildup.projects v1: registry entries plus repo
 * discovery candidates derived from the herdr session snapshot.
 */

import { realpathSync } from "node:fs";
import path from "node:path";
import { GitError, repoRemoteIdentity, resolveRepo } from "../../../packages/git-core/src/index";
import type { ProjectsState } from "./state";

export interface DiscoveredRepo {
  /** Pane cwd the repo was discovered from. */
  cwd: string;
  /** Resolved worktree root. */
  root: string;
  /** Normalized remote identity, null when the repo has no remote. */
  remote: string | null;
  /** Registry project id already containing this repo root, if any. */
  registered_project_id: string | null;
}

export interface SkippedCwd {
  cwd: string;
  reason: string;
}

function canonicalRoot(root: string): string {
  try {
    return realpathSync(root);
  } catch {
    return path.resolve(root);
  }
}

/** Index of repo root → project id across the whole registry. */
export function repoIndex(state: ProjectsState): Map<string, string> {
  const index = new Map<string, string>();
  for (const project of Object.values(state.projects)) {
    for (const repo of project.repos) {
      index.set(canonicalRoot(repo.root), project.id);
    }
  }
  return index;
}

/**
 * Enumerate git repositories reachable from herdr pane cwds. Non-git,
 * bare, and unreachable cwds are reported in `skipped`, never fabricated.
 */
export async function discoverRepos(
  cwds: string[],
  state: ProjectsState,
  options: { timeoutMs?: number } = {},
): Promise<{ repos: DiscoveredRepo[]; skipped: SkippedCwd[] }> {
  const index = repoIndex(state);
  const byRoot = new Map<string, DiscoveredRepo>();
  const skipped: SkippedCwd[] = [];

  for (const cwd of cwds) {
    let root: string;
    try {
      root = (await resolveRepo(cwd, options)).root;
    } catch (err) {
      if (err instanceof GitError) {
        skipped.push({ cwd, reason: err.kind });
        continue;
      }
      throw err;
    }
    const key = canonicalRoot(root);
    if (byRoot.has(key)) continue;
    let remote: string | null = null;
    try {
      remote = await repoRemoteIdentity(root, options);
    } catch (err) {
      if (!(err instanceof GitError)) throw err;
      // A repo without a readable remote list still registers by root.
    }
    byRoot.set(key, {
      cwd,
      root,
      remote,
      registered_project_id: index.get(key) ?? null,
    });
  }
  return { repos: [...byRoot.values()], skipped };
}

/** Derive a stable project id candidate from a repo root basename. */
export function projectIdFromRoot(root: string): string {
  const base = path
    .basename(root)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return base || "project";
}
