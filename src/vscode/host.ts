// Real VS Code host entry. Core (extension.ts) stays editor-agnostic behind
// the Vscode seam; this file binds the real `vscode` module, wraps the core
// list providers as real TreeDataProviders, and exposes the standard
// activate/deactivate exports. Built to dist/vscode/host.js (package.json main).
import * as vscode from "vscode";
import { activate as activateCore } from "./extension.js";
import type { PanelNode } from "../panels.js";

interface CoreListProvider {
  getChildren(): PanelNode[];
  set(nodes: PanelNode[]): void;
}

/** Adapter: core in-memory list → real TreeDataProvider with refresh. */
class DeciTreeProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private readonly core: CoreListProvider;
  private readonly changed = new vscode.EventEmitter<vscode.TreeItem | undefined>();
  readonly onDidChangeTreeData = this.changed.event;

  constructor(core: CoreListProvider) {
    this.core = core;
    const set = core.set.bind(core);
    core.set = (nodes: PanelNode[]): void => {
      set(nodes);
      this.changed.fire(undefined);
    };
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(): vscode.TreeItem[] {
    return this.core.getChildren().map((n) => {
      const item = new vscode.TreeItem(n.label);
      item.description = n.detail;
      item.tooltip = n.detail;
      if (n.command) {
        item.command = { command: n.command, title: n.label, arguments: n.args ?? [] };
      }
      return item;
    });
  }
}

export function activate(context: vscode.ExtensionContext): void {
  // Keep core's self-registration off (its plain-object providers are not
  // real TreeItems); the host registers wrapped providers below instead.
  const seam = {
    window: {
      createWebviewPanel: (viewType: string, title: string, column: number, options: unknown) =>
        vscode.window.createWebviewPanel(
          viewType,
          title,
          column as vscode.ViewColumn,
          options as vscode.WebviewPanelOptions,
        ),
      showQuickPick: (items: string[], options?: unknown) =>
        vscode.window.showQuickPick(items, options as vscode.QuickPickOptions),
      showInputBox: (options?: unknown) =>
        vscode.window.showInputBox(options as vscode.InputBoxOptions),
    },
    workspace: vscode.workspace,
    commands: vscode.commands,
  } as unknown as Parameters<typeof activateCore>[0];
  const { providers } = activateCore(seam);
  for (const [id, core] of Object.entries(providers)) {
    context.subscriptions.push(
      vscode.window.registerTreeDataProvider(id, new DeciTreeProvider(core)),
    );
  }
}

export function deactivate(): void {}
