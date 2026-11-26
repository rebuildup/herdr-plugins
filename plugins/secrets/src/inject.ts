/**
 * Surface-injection sink for rebuildup.secrets (ADR-0027 §3, sink 2).
 *
 * Resolved binding values are placed into the `env` map of herdr
 * surface-creation calls (`workspace.create` / `tab.create` /
 * `pane.split`, protocol 22). `agent.start` accepts no env, so this is
 * the only herdr-side injection point. Only env *names* are reported —
 * never values.
 */

import {
  type CallOptions,
  paneSplit,
  tabCreate,
  workspaceCreate,
} from "../../../packages/herdr-client/src/index";

export type SurfaceKind = "workspace" | "tab" | "pane";

export interface InjectParams {
  surface: SurfaceKind;
  /** pane.split: split direction (default "right"). */
  direction?: "right" | "down";
  /** pane.split: existing pane to split. */
  targetPaneId?: string;
  /** tab.create / pane.split: existing workspace. */
  workspaceId?: string;
  cwd?: string;
  label?: string;
  focus?: boolean;
  ratio?: number;
}

export interface InjectResult {
  surface: SurfaceKind;
  /** Created surface identifiers (pane always present; others when returned). */
  pane_id?: string | undefined;
  tab_id?: string | undefined;
  workspace_id?: string | undefined;
  /** Env names injected — never values. */
  env_names: string[];
  /** Raw surface payload for callers that need it (contains no secrets). */
  detail?: Record<string, unknown>;
}

/**
 * Create a herdr surface with the resolved env map. The env map contains
 * secret values in memory; it is forwarded to herdr exactly once inside
 * the API params and is never logged or persisted by this plugin.
 */
export async function injectEnv(
  env: Record<string, string>,
  params: InjectParams,
  call: CallOptions = {},
): Promise<InjectResult> {
  const envNames = Object.keys(env).sort();
  const surfaceParams = {
    ...(params.cwd !== undefined ? { cwd: params.cwd } : {}),
    ...(params.label !== undefined ? { label: params.label } : {}),
    ...(params.focus !== undefined ? { focus: params.focus } : {}),
    env,
  };

  if (params.surface === "workspace") {
    const result = await workspaceCreate(surfaceParams, call);
    return {
      surface: "workspace",
      pane_id: result.root_pane?.pane_id,
      tab_id: result.tab?.tab_id,
      workspace_id: result.workspace?.workspace_id,
      env_names: envNames,
      detail: {
        workspace: result.workspace,
        tab: result.tab,
        root_pane: result.root_pane,
      },
    };
  }

  if (params.surface === "tab") {
    const result = await tabCreate(
      {
        ...surfaceParams,
        ...(params.workspaceId !== undefined ? { workspace_id: params.workspaceId } : {}),
      },
      call,
    );
    return {
      surface: "tab",
      pane_id: result.root_pane?.pane_id,
      tab_id: result.tab?.tab_id,
      workspace_id: result.tab?.workspace_id ?? params.workspaceId,
      env_names: envNames,
      detail: { tab: result.tab, root_pane: result.root_pane },
    };
  }

  // pane split
  const result = await paneSplit(
    {
      ...surfaceParams,
      direction: params.direction ?? "right",
      ...(params.targetPaneId !== undefined ? { target_pane_id: params.targetPaneId } : {}),
      ...(params.workspaceId !== undefined ? { workspace_id: params.workspaceId } : {}),
      ...(params.ratio !== undefined ? { ratio: params.ratio } : {}),
    },
    call,
  );
  return {
    surface: "pane",
    pane_id: result.pane?.pane_id,
    workspace_id: result.pane?.workspace_id ?? params.workspaceId,
    env_names: envNames,
    detail: { pane: result.pane },
  };
}
