// Real VS Code host entry. Core (extension.ts) stays editor-agnostic behind
// the Vscode seam; this file binds the real `vscode` module, wraps the core
// list providers as real TreeDataProviders, exposes the standard
// activate/deactivate exports, and registers the workspace-analyze commands
// (git diff → core panels) that make the extension usable standalone.
// Built to dist/vscode/host.js (package.json main).
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
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

/**
 * Working-tree diff of the first workspace folder (argv, no shell; `--`
 * separates the pathspec). Null = not a git repo, git missing, or no changes.
 * Shell-free by construction — the folder path never reaches a shell string.
 */
function workspaceDiff(staged: boolean): string | null {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) return null;
  try {
    const out = execFileSync("git", ["diff", staged ? "--staged" : "HEAD", "--"], {
      cwd: folders[0].uri.fsPath,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return out || null;
  } catch {
    return null;
  }
}

export function activate(context: vscode.ExtensionContext): void {
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
      // Live getter: decorations must track the CURRENT active editor, not
      // whatever was active at activate() time.
      get activeTextEditor() {
        const e = vscode.window.activeTextEditor;
        if (!e) return undefined;
        return {
          document: { uri: { fsPath: e.document.uri.fsPath }, lineCount: e.document.lineCount },
          // Core emits editor-agnostic { line, character } points; the real
          // API requires vscode.Range instances — translate here, at the seam.
          setDecorations: (kind: unknown, ranges: unknown[]) => {
            const vsRanges = (ranges as Array<{ line: number; character: number }>).map(
              (r) => new vscode.Range(r.line, r.character, r.line, r.character),
            );
            e.setDecorations(kind as vscode.TextEditorDecorationType, vsRanges);
          },
        };
      },
      createTextEditorDecorationType: (options: unknown) =>
        vscode.window.createTextEditorDecorationType(options as vscode.DecorationRenderOptions),
    },
    workspace: {
      getConfiguration: (section: string) => vscode.workspace.getConfiguration(section),
      fs: {
        exists: (p: string) => existsSync(p),
        read: (p: string) => readFileSync(p, "utf8"),
      },
    },
    languages: {
      registerHoverProvider: vscode.languages.registerHoverProvider?.bind(vscode.languages),
    },
    commands: vscode.commands,
  } as unknown as Parameters<typeof activateCore>[0];
  const { providers } = activateCore(seam, {
    storageDir: `${context.globalStorageUri.fsPath}/chat`,
    workspaceRoot: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
    openDocument: async (path: string, line: number | null) => {
      const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "";
      const doc = await vscode.workspace.openTextDocument(
        vscode.Uri.file(root ? `${root}/${path}` : path),
      );
      const editor = await vscode.window.showTextDocument(doc);
      if (line !== null && Number.isFinite(line) && line > 0) {
        const pos = new vscode.Position(Math.max(0, line - 1), 0);
        editor.selection = new vscode.Selection(pos, pos);
        editor.revealRange(new vscode.Range(pos, pos));
      }
    },
  });
  for (const [id, core] of Object.entries(providers)) {
    context.subscriptions.push(
      vscode.window.registerTreeDataProvider(id, new DeciTreeProvider(core)),
    );
  }

  // Primary in-editor flow: git diff → Review Map + Decisions panels. The
  // core-registered commands do the full wiring (sidebar providers, history,
  // gutter decorations); the host only supplies the diff. Failures are shown,
  // never swallowed: a silent no-op is worse than an honest error.
  const analyze = (staged: boolean): void => {
    let diff: string | null;
    try {
      diff = workspaceDiff(staged);
    } catch (err) {
      vscode.window.showErrorMessage(`Deci: could not read git diff — ${(err as Error).message}`);
      return;
    }
    if (!diff || !diff.trim()) {
      vscode.window.showInformationMessage(
        `Deci: no ${staged ? "staged" : "working-tree"} changes to analyze.`,
      );
      return;
    }
    void vscode.commands.executeCommand("deci.showReviewMap", diff).then(
      undefined,
      (err) => vscode.window.showErrorMessage(`Deci: review failed — ${(err as Error)?.message ?? err}`),
    );
    void vscode.commands.executeCommand("deci.showDecisions", diff).then(
      undefined,
      (err) => vscode.window.showErrorMessage(`Deci: decisions failed — ${(err as Error)?.message ?? err}`),
    );
  };
  context.subscriptions.push(
    vscode.commands.registerCommand("deci.analyzeWorkspace", () => analyze(false)),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("deci.analyzeStaged", () => analyze(true)),
  );
}

export function deactivate(): void {}
