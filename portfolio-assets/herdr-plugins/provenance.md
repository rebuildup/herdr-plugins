# Portfolio asset provenance — `herdr-plugins`

Supervisor issue: rebuildup/my-web-2026#1225
Child issue: rebuildup/herdr-plugins#117
Captured: 2026-11-25 (JST)

## Files

| Role | File | Dimensions | Format |
| --- | --- | --- | --- |
| main | `inbox-tui-main.png` | 2172 × 1248 px | PNG (truecolor) |
| supplement | `inbox-tui-sidebar.png` | 340 × 1248 px | PNG (crop of main, left sidebar region) |

Aspect ratio of main: ≈ 1.74:1 (16:9 目安に準拠)。

## What is shown

herdr 0.9.5 (stable) の TUI に、公開リリース版 `rebuildup.inbox` v0.1.0
プラグインを導入し、4 つの agent pane に settle / snooze / restore の
organize 状態を適用した実画面。

- 左サイドバー "agents" セクション: `claude` = **settled**、
  `codex` = **snoozed**、`pi` = blocked (organize なし・attention は隠れない)、
  `opencode` = organize なし、のバッジ表示
  (`$inbox_state` メタデータトークンを `[ui.sidebar.agents]` の
  カスタムトークン行で表示するユーザー設定を使用)。
- メイン領域 2×2 pane:
  - `capability` JSON コマンド出力 (plugin contract `herdr-plugins.inbox/v1`)
  - 公開リポジトリ clone での `git log --oneline` (`v0.1.0` tag 表示)
  - GitHub API による最新リリース (v0.1.0) ノート表示
  - `bun run src/cli.ts list` の organize 状態 JSON
    (`"kind": "snoozed"`, `"in_inbox": false` など)

## Captured product versions

- herdr: **0.9.5** (stable channel, `/Users/rebui/.local/share/mise/installs/herdr/0.9.5`)
- plugin: `rebuildup.inbox` **v0.1.0**
  - install ref: tag `v0.1.0`
  - commit: `f370b00c44277d2fb8000dfeaa701d86607fb371`
    (`Merge pull request #10 from rebuildup/release-0-1-0`)
  - source: `rebuildup/herdr-plugins/plugins/inbox` (public, MIT)
- upstream clone for pane content: `https://github.com/rebuildup/herdr-plugins`
  @ `f370b00` (tag `v0.1.0`)

## Reproduction steps

1. Isolated herdr environment (does not touch the user's live session):

   ```bash
   export XDG_CONFIG_HOME=/var/tmp/herdr-p1225/xdg
   export XDG_STATE_HOME=/var/tmp/herdr-p1225/xdg-state
   # config.toml: [experimental] allow_nested = true
   #              + [ui.sidebar.agents] rows に { token = "$inbox_state" } 行
   herdr plugin install rebuildup/herdr-plugins/plugins/inbox --ref v0.1.0
   ```

2. Named session `repro-inbox-p1225` をネスト起動
   (`env -u HERDR_SOCKET_PATH -u HERDR_CLIENT_SOCKET_PATH -u HERDR_SESSION
   -u HERDR_WORKSPACE_ID -u HERDR_TAB_ID -u HERDR_PANE_ID herdr --session
   repro-inbox-p1225`)。workspace `inbox-demo` に 4 pane を split。

3. 各 pane で公開データのコマンドを実行後、公式 API で agent lifecycle を報告:

   ```bash
   herdr pane report-agent <pane> --source portfolio-demo \
     --agent <claude|codex|pi|opencode> --state <working|idle|blocked>
   ```

   ※ pane の表示名・状態は `pane report-agent` (herdr 公開 API) による
   デモデータ。pane 内のコマンド出力はすべて実実行結果で、UI の捏造はない。
   実 agent CLI の起動・課金は行っていない。

4. 公開プラグイン CLI で organize を適用
   (`HERDR_SESSION=repro-inbox-p1225` + 上記 XDG 変数下で
   `<plugin_root>/src/cli.ts` を `bun run`):

   ```bash
   bun run src/cli.ts settle w2:p1
   bun run src/cli.ts snooze w2:p2 --until +2h
   bun run src/cli.ts restore w2:p3   # blocked pane は attention のため inbox に残る実挙動も確認
   bun run src/cli.ts list            # w2:p4 pane 内で実行・表示
   ```

5. 撮影: ネスト TUI を収めた外側 pane を
   `herdr pane read <pane> --source visible --format ansi` で取得し、
   SGR (色・bold・dim) を解釈して PNG 化 (Pillow + OsakaMono)。
   加工はトリミング/レンダリングのみで、画面内容の改変はしていない。

## alt / caption (案)

- alt: `herdr TUI のスクリーンショット。サイドバーの agent 一覧に
  settled / snoozed バッジが表示され、各 pane で rebuildup.inbox
  プラグインの list JSON が実行結果として見えている。`
- caption: `rebuildup.inbox v0.1.0 — herdr の agent pane を
  settle / snooze / restore で整理するプラグイン。`

## Rights / publication boundary

- すべて自作のスクリーンショット。製品・リポジトリは公開 (MIT)。
- 写っているのは公開リポジトリの公開情報と `/var/tmp` 以下の
  再現用デモ環境のみ。秘密情報・個人情報・非公開プロジェクト名・
  許諾不明の第三者素材は含まない。
- `pane report-agent` で付けた agent 名 (claude/codex/pi/opencode) は
  herdr の対応 agent kind 名であり、各社製品の画面ではない。
- プロンプトの `rebui@mac` は撮影者自身の環境表記。
