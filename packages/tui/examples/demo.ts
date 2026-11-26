/**
 * packages/tui smoke demo — exercises the shared core end to end:
 * select list + filter + detail pane, help overlay, confirm dialog,
 * async task with progress/cancel, status line, untrusted-text safety.
 *
 * Run inside a real PTY:
 *   bun run packages/tui/examples/demo.ts
 * or under `script` for a captured smoke run:
 *   script -q /dev/null bun run packages/tui/examples/demo.ts </dev/null
 *
 * Keys: ↑/↓ or j/k move · / filter · Enter select · d detail · t task ·
 * x delete (confirm) · ? help · q quit · Ctrl-C cancel task / exit.
 */

import { DetailView, type SelectItem, SelectList, TuiApp } from "../src/index";

interface DemoItem {
  id: string;
  name: string;
  kind: string;
  dirty: boolean;
  // intentionally includes escape-looking text to prove sanitization
  note: string;
}

const ITEMS: DemoItem[] = [
  {
    id: "w1",
    name: "alpha",
    kind: "feature",
    dirty: true,
    note: "clean except \x1b[31mred\x1b[0m injection",
  },
  { id: "w2", name: "beta", kind: "bugfix", dirty: false, note: "日本語と絵文字 🚀 のテスト" },
  {
    id: "w3",
    name: "gamma",
    kind: "chore",
    dirty: true,
    note: "osc \x1b]8;;http://evil\x07link\x1b]8;;\x07 attempt",
  },
  {
    id: "w4",
    name: "delta-long-name-for-truncation",
    kind: "docs",
    dirty: false,
    note: "wide chars 界界界界界界界界界界",
  },
  { id: "w5", name: "epsilon", kind: "feature", dirty: true, note: "plain" },
];

async function main(): Promise<void> {
  const app = await TuiApp.create({
    title: "tui demo — packages/tui",
    alternateScreen: true,
    keymap: [{ keys: "t", description: "run demo task" }],
    farewell: ["demo exited cleanly"],
  });

  const toItem = (d: DemoItem): SelectItem<DemoItem> => ({
    value: d,
    label: `${d.dirty ? "*" : " "} ${d.name}`,
    detail: `${d.kind} · ${d.id}\n${d.note}`,
  });

  const list = new SelectList<DemoItem>({
    items: ITEMS.map(toItem),
    filterable: true,
    emptyText: "no matches",
  });

  list.onSelect = (item) => {
    void (async () => {
      const ok = await app.confirm({
        title: "Open item?",
        target: [`id: ${item.value.id}`, `name: ${item.value.name}`],
        consequence: "opens a read-only detail view",
        confirmLabel: "Open",
        cancelLabel: "Skip",
      });
      if (ok) {
        app.push(
          new DetailView({
            title: `Detail: ${item.value.name}`,
            lines: [
              `id=${item.value.id} kind=${item.value.kind} dirty=${item.value.dirty}`,
              `note: ${item.value.note}`,
              "",
              "This text is untrusted-sample data; the renderer strips",
              "CSI/OSC sequences so it cannot inject terminal controls.",
            ],
            onClose: () => app.pop(),
          }),
        );
      }
    })();
  };
  list.onCancel = () => void app.close();

  // Extra keys handled at app level via a thin wrapper view.
  const base = list;
  app.setView({
    render: (w, h) => base.render(w, h),
    handleKey: (ev) => {
      if (ev.kind === "key" && !ev.ctrl && !ev.alt) {
        if (ev.key === "x") {
          const cur = base.current ?? listItemsCurrent();
          void (async () => {
            const ok = await app.confirm({
              title: "Delete item?",
              target: [`id: ${cur.value.id}`, `name: ${cur.value.name}`],
              consequence: "permanently removes the item (demo)",
              danger: true,
            });
            if (ok) {
              app.setStatus(`deleted ${cur.value.id} (demo)`);
            }
          })();
          return true;
        }
        if (ev.key === "t") {
          void runDemoTask(app);
          return true;
        }
      }
      return base.handleKey(ev);
    },
    keymap: () => [
      { keys: ["↑", "k", "↓", "j"], description: "move" },
      { keys: "/", description: "filter" },
      { keys: "enter", description: "open / confirm" },
      { keys: "x", description: "delete (confirm)" },
      { keys: "t", description: "demo task" },
      { keys: ["esc", "q"], description: "quit" },
    ],
  });

  app.setStatus("demo ready — ? for help");
  await app.closed;
}

function listItemsCurrent(): SelectItem<DemoItem> {
  // fallback for 'x' before any selection: first item
  return { value: ITEMS[0] as DemoItem, label: (ITEMS[0] as DemoItem).name };
}

async function runDemoTask(app: TuiApp): Promise<void> {
  app.setStatus("task running…");
  const result = await app.tasks.run(
    { label: "demo task", timeoutMs: 15_000, total: 5 },
    async (signal, report) => {
      for (let i = 1; i <= 5; i++) {
        await Bun.sleep(400);
        if (signal.aborted) throw new Error("aborted");
        report({ done: i, message: `step ${i}` });
      }
      return "done";
    },
  );
  if (result.status === "ok") {
    app.setStatus(`task ${result.status} in ${result.elapsedMs}ms`);
  } else {
    app.setStatus(
      `task ${result.status}${result.partial ? " (partial)" : ""}: ${result.error ?? ""}`,
    );
  }
}

main().catch((err) => {
  console.error("demo failed:", err);
  process.exit(1);
});
