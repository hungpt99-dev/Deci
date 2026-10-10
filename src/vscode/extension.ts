// VS Code host: Review Map webview (US-001) + ranked decision queue with
// gutter icons + hover cards + Accept/Reject/Investigate commands (US-004).
// Core stays pure in decisions.ts; this file is the thin editor adapter.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  buildManualDiff,
  renderInputsMarkdown,
  resolveRefInput,
  type DiffSpec,
} from "../inputs.js";
import { buildReviewMap, parseUnifiedDiff, renderMarkdown } from "../reviewMap.js";
import { analyzeSemantics } from "../semantic.js";
import {
  acceptDecision,
  buildDecisions,
  gutterIconFor,
  gutterMarksFor,
  hoverMarkdownFor,
  investigateDecision,
  REJECT_REASONS,
  rejectDecision,
  renderDecisionsMarkdown,
  type DecisionPoint,
  type RejectReason,
  type Severity,
} from "../decisions.js";
import {
  generateAlternatives,
  pickAlternative,
  planForAlternative,
  renderAlternativesMarkdown,
  renderPlanMarkdown,
  type AlternativeSet,
} from "../alternatives.js";
import {
  generatePatch,
  implementAndReverify,
  memFs,
  renderImplementResultMarkdown,
  renderPatchMarkdown,
  type ImplementResult,
  type PatchFs,
} from "../implement.js";
import { applyVerification, renderVerifyMarkdown, runFullVerify, type VerifyReport } from "../verify.js";
import {
  buildOutputBundle,
  renderBundleMarkdown,
  type OutputBundle,
} from "../bundle.js";
import {
  collectQueueEvidence,
  emptyContext,
  renderQueueEvidenceMarkdown,
  type EvidenceBundle,
} from "../evidence.js";
import {
  describeConfig,
  resolveProviderConfig,
  validateConfig,
  type LlmConfig,
} from "../llm.js";
import {
  PANEL_VIEWS,
  appendHistory,
  buildAlternativeNodes,
  buildDecisionNodes,
  buildEvidenceNodes,
  buildHistoryNodes,
  buildReviewNodes,
  historyEntryFor,
  renderHistoryMarkdown,
  type HistoryEntry,
  type PanelNode,
  type PanelViewId,
} from "../panels.js";
import { buildChatHtml } from "../chatView.js";
import {
  addMessage,
  createConversation,
  newMessageId,
  renameConversation,
  updateContextFlags,
  type BlockSelection,
  type ChatMessageItem,
  type Conversation,
  type ConversationMeta,
} from "../chat.js";
import { ACTION_REGISTRY, type ActionName } from "../blocks.js";
import { applyFixAfterApproval, executeTool, proposeFixStructured } from "../chatTools.js";
import { FileConversationStore } from "../chatStore.js";
import { ChatEngine } from "../chatEngine.js";

type Vscode = {
  window: {
    createWebviewPanel(viewType: string, title: string, column: number, options: unknown): {
      webview: {
        html: string;
        onDidReceiveMessage?(cb: (msg: Record<string, unknown>) => void): unknown;
        postMessage?(msg: unknown): void;
      };
    };
    showQuickPick?(items: string[], options?: unknown): Thenable<string | undefined>;
    showInputBox?(options?: unknown): Thenable<string | undefined>;
    activeTextEditor?: {
      document: { uri: { fsPath: string }; lineCount: number };
      setDecorations?(kind: unknown, ranges: unknown[]): void;
    };
    createTextEditorDecorationType?(options: unknown): unknown;
    registerTreeDataProvider?(viewId: string, provider: unknown): unknown;
  };
  workspace: {
    getConfiguration(section: string): { get<T>(key: string): T | undefined };
    /** Real-fs adapter for ref reads (host injects; tests omit). */
    fs?: { exists: (path: string) => boolean; read: (path: string) => string };
  };
  languages?: {
    registerHoverProvider?(selector: unknown, provider: unknown): unknown;
  };
  commands: { registerCommand(id: string, cb: (...args: unknown[]) => unknown): unknown };
  TreeItem?: new (label: string) => { label: string; description?: string; command?: unknown };
};

type Thenable<T> = { then(onFulfilled: (v: T) => unknown): unknown };

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Diff → ranked queue. Pure core; exported for CLI/tests. */
export function decisionsForDiff(diffText: string): DecisionPoint[] {
  return buildDecisions(analyzeSemantics(diffText));
}

/**
 * US-011: manual file/folder pick fallback for the no-git-repo case. The
 * host supplies picked paths + contents; core synthesizes a unified diff
 * that parses back via parseUnifiedDiff. Pure, no fs.
 */
export function manualDiffForFiles(files: Array<{ path: string; content: string }>): string {
  return buildManualDiff(files);
}

/** US-011: `## Inputs` summary panel (diff source + ticket/doc marks). */
export function showInputsPanel(
  vscode: Vscode,
  spec: DiffSpec,
  ticketRaw: string | null,
  docRaw: string | null,
): void {
  const io = vscode.workspace.fs ?? { exists: () => false, read: () => "" };
  const ticket = resolveRefInput(ticketRaw, io);
  const doc = resolveRefInput(docRaw, io);
  const panel = vscode.window.createWebviewPanel("deci.inputs", "Inputs", 1, {});
  panel.webview.html = `<html><body><pre>${escapeHtml(renderInputsMarkdown(spec, ticket, doc))}</pre></body></html>`;
}

/**
 * US-011: prompt diff source + optional ticket + doc. Ticket/doc are
 * optional (empty = skip); unreachable refs mark missing downstream and
 * never block. `files` lets the host inject manual-pick contents; when a
 * manual spec is picked without files, returns the spec so the host can
 * collect paths next.
 */
export async function promptReviewInputs(
  vscode: Vscode,
  opts: { manualFiles?: Array<{ path: string; content: string }> } = {},
): Promise<{ spec: DiffSpec; ticket: string | null; doc: string | null; manualDiff: string | null }> {
  const choice = await vscode.window.showQuickPick?.(
    ["working tree (git diff HEAD)", "staged (git diff --staged)", "branch-vs-base range…", "manual file/folder pick…"],
    { placeHolder: "Diff source (local git only; manual pick when no repo)" },
  );
  let spec: DiffSpec = { kind: "working" };
  if (choice?.startsWith("staged")) spec = { kind: "staged" };
  else if (choice?.startsWith("branch")) {
    const range = await vscode.window.showInputBox?.({ prompt: "Branch-vs-base range (e.g. main...HEAD)" });
    spec = { kind: "range", range: range?.trim() ? range.trim() : "main...HEAD" };
  } else if (choice?.startsWith("manual")) {
    if (opts.manualFiles) {
      const paths = opts.manualFiles.map((f) => f.path);
      return {
        spec: { kind: "file", path: paths.length > 1 ? `${paths.length} files` : (paths[0] ?? "manual pick") },
        ticket: null,
        doc: null,
        manualDiff: buildManualDiff(opts.manualFiles),
      };
    }
    const picked = await vscode.window.showInputBox?.({ prompt: "File or folder path (no-git fallback)" });
    spec = { kind: "file", path: picked?.trim() ? picked.trim() : "." };
  }
  const ticket = (await vscode.window.showInputBox?.({ prompt: "Ticket URL/ID (optional, empty = skip)" }))?.trim() || null;
  const doc = (await vscode.window.showInputBox?.({ prompt: "Design doc path/URL (optional, empty = skip)" }))?.trim() || null;
  return { spec, ticket, doc, manualDiff: null };
}

export function showReviewMap(vscode: Vscode, diffText: string): void {
  const report = runFullVerify(diffText, { runCommands: false });
  const map = applyVerification(buildReviewMap(diffText), report.verifiedPaths);
  const queue = decisionsForDiff(diffText);
  const body = `${renderMarkdown(map)}\n${renderDecisionsMarkdown(queue)}\n${renderVerifyMarkdown(report)}`;
  const panel = vscode.window.createWebviewPanel("deci.review", "Review Map", 1, {});
  panel.webview.html = `<html><body><pre>${escapeHtml(body)}</pre></body></html>`;
  applyDecisionDecorations(vscode, queue);
}

/** US-009: read `deci.provider` + model/baseURL/key settings. Env wins over editor settings. */
export function providerForHost(
  vscode: Vscode,
  env: Record<string, string | undefined> = {},
): LlmConfig {
  const cfg = vscode.workspace.getConfiguration("deci");
  const get = (key: string): string | undefined => {
    try {
      const v = cfg.get<string>(key);
      return typeof v === "string" && v.trim() ? v : undefined;
    } catch {
      return undefined;
    }
  };
  return resolveProviderConfig(
    {
      provider: get("provider"),
      openaiBaseURL: get("openai.baseURL"),
      openaiApiKey: get("openai.apiKey"),
      openaiModel: get("openai.model"),
      ollamaBaseURL: get("ollama.baseURL"),
      ollamaModel: get("ollama.model"),
      vscodeLmModel: get("vscodeLm.model"),
    },
    env,
  );
}

/** US-009: provider status panel (redacted key). Returns config for host wiring. */
export function showProviderStatus(vscode: Vscode): LlmConfig {
  const config = providerForHost(vscode);
  const v = validateConfig(config);
  const body = `## LLM Provider\n\n${describeConfig(config)} — ${v.ok ? "ready" : `missing: ${v.missing.join(", ")}`}.\n`;
  const panel = vscode.window.createWebviewPanel("deci.provider", "LLM Provider", 1, {});
  panel.webview.html = `<html><body><pre>${escapeHtml(body)}</pre></body></html>`;
  return config;
}

/** Evidence panel: per-decision ✓ present / ✗ missing (US-005). */
export function showEvidence(
  vscode: Vscode,
  queue: DecisionPoint[],
  changedFiles: string[] = [...new Set(queue.map((d) => d.file))],
): EvidenceBundle[] {
  const bundles = collectQueueEvidence(queue, emptyContext({ changedFiles }));
  const panel = vscode.window.createWebviewPanel("deci.evidence", "Evidence", 1, {});
  panel.webview.html = `<html><body><pre>${escapeHtml(renderQueueEvidenceMarkdown(bundles))}</pre></body></html>`;
  return bundles;
}

/**
 * Alternative Studio panel: A/B/C compare + trade-off table for a rejected
 * decision, plus implementation plan preview for the picked (or first)
 * option. Returns the set so the host can keep it for pick commands.
 */
export function showAlternatives(vscode: Vscode, decision: DecisionPoint): AlternativeSet {
  const set = generateAlternatives(decision);
  const body = `${renderAlternativesMarkdown(set)}\n${renderPlanMarkdown(planForAlternative(set))}`;
  const panel = vscode.window.createWebviewPanel("deci.alternatives", "Alternatives", 1, {});
  panel.webview.html = `<html><body><pre>${escapeHtml(body)}</pre></body></html>`;
  return set;
}

/** Pick one alternative, re-render Studio with plan preview. Throws on unknown id. */
export function pickStudioAlternative(
  vscode: Vscode,
  set: AlternativeSet,
  alternativeId: string,
): AlternativeSet {
  const next = pickAlternative(set, alternativeId);
  const body = `${renderAlternativesMarkdown(next)}\n${renderPlanMarkdown(planForAlternative(next))}`;
  const panel = vscode.window.createWebviewPanel("deci.alternatives", "Alternatives", 1, {});
  panel.webview.html = `<html><body><pre>${escapeHtml(body)}</pre></body></html>`;
  return next;
}

/**
 * US-007: implementation plan preview for the picked (or first) option:
 * file steps + +/-LOC estimate + patch diff preview. No writes.
 */
export function previewImplementation(
  vscode: Vscode,
  set: AlternativeSet,
  alternativeId?: string,
): void {
  const plan = planForAlternative(set, alternativeId ?? set.pickedId ?? undefined);
  const body = `${renderPlanMarkdown(plan)}\n${renderPatchMarkdown(generatePatch(plan))}`;
  const panel = vscode.window.createWebviewPanel("deci.implement", "Implementation", 1, {});
  panel.webview.html = `<html><body><pre>${escapeHtml(body)}</pre></body></html>`;
}

/**
 * US-007: Generate patch via Local Agent Adapter only → full re-verify on
 * the post-apply diff → re-queue affected decisions only. `fs` injects the
 * host file system (defaults to memory for dry runs); `postApplyDiff` is
 * the fresh diff after the write. Renders the result bundle panel.
 */
export function applyPickedAlternative(
  vscode: Vscode,
  set: AlternativeSet,
  queue: DecisionPoint[],
  postApplyDiff: string,
  opts: { fs?: PatchFs; alternativeId?: string } = {},
): ImplementResult {
  const result = implementAndReverify(set, queue, opts.fs ?? memFs(), postApplyDiff, {
    adapterId: "local",
    alternativeId: opts.alternativeId ?? set.pickedId ?? undefined,
    verify: { runCommands: false },
  });
  const panel = vscode.window.createWebviewPanel("deci.implement", "Implementation", 1, {});
  panel.webview.html = `<html><body><pre>${escapeHtml(renderImplementResultMarkdown(result))}</pre></body></html>`;
  return result;
}

/**
 * US-008: full output bundle panel (impact / risk / test plan / rollback
 * text only). Thin adapter: builds the map + verify inside, renders the
 * pure bundle markdown. No revert execution exists in MVP.
 */
export function showOutputBundle(
  vscode: Vscode,
  diffText: string,
  queue: DecisionPoint[],
  report: VerifyReport | null = null,
  evidence: EvidenceBundle[] = [],
): OutputBundle {
  const verified = report ?? runFullVerify(diffText, { runCommands: false });
  const map = applyVerification(buildReviewMap(diffText), verified.verifiedPaths);
  const bundle = buildOutputBundle(map, queue, verified, {
    evidence,
    changedFiles: [...new Set(queue.map((d) => d.file))],
  });
  const panel = vscode.window.createWebviewPanel("deci.bundle", "Output Bundle", 1, {});
  panel.webview.html = `<html><body><pre>${escapeHtml(renderBundleMarkdown(bundle))}</pre></body></html>`;
  return bundle;
}

/** Decisions panel: ranked queue with Accept / Reject / Investigate actions. */
export function showDecisions(vscode: Vscode, diffText: string): DecisionPoint[] {
  const queue = decisionsForDiff(diffText);
  const panel = vscode.window.createWebviewPanel("deci.decisions", "Decisions", 1, {});
  panel.webview.html = `<html><body><pre>${escapeHtml(renderDecisionsMarkdown(queue))}</pre></body></html>`;
  applyDecisionDecorations(vscode, queue);
  return queue;
}

/**
 * Impact report webview: renders prebuilt interactive HTML (from the CLI
 * `analyze --html` pipeline or host-assembled snapshots). This function
 * only displays; analysis stays in the pure core / CLI path.
 */
export function showImpactReport(vscode: Vscode, html: string): void {
  const panel = vscode.window.createWebviewPanel("deci.impact", "Impact Report", 1, {});
  panel.webview.html = html;
}

const SEVERITIES: Severity[] = ["Critical", "High", "Medium", "Low"];

// The hover provider is registered once per extension host; every decoration
// call refreshes `hoverQueue` so the card always matches the latest analysis.
let hoverBound = false;
let hoverQueue: DecisionPoint[] = [];

/**
 * Gutter icons + hover cards for the ranked queue. Creates one decoration
 * kind per severity (gutter icon), maps each decision to its file's line via
 * `lineOfFile`, and registers a hover provider with the Accept/Reject/
 * Investigate card. No-ops gracefully when the host lacks editor APIs.
 */
export function applyDecisionDecorations(
  vscode: Vscode,
  queue: DecisionPoint[],
  lineOfFile: (file: string) => number = () => 1,
): void {
  hoverQueue = queue;
  const editor = vscode.window.activeTextEditor;
  const createKind = vscode.window.createTextEditorDecorationType;
  if (!editor || !createKind) return;
  const marks = gutterMarksFor(queue, lineOfFile);
  for (const severity of SEVERITIES) {
    const kind = createKind({
      gutterIconPath: undefined,
      gutterIconSize: "contain",
      overviewRulerColor: undefined,
      // Host renders the icon text in the gutter via `before` content.
      before: { contentText: gutterIconFor(severity), margin: "0 4px 0 0" },
    });
    const ranges = marks
      .filter((m) => m.severity === severity)
      .map((m) => ({ line: m.line, character: 0 }));
    editor.setDecorations?.(kind, ranges);
  }
  if (hoverBound || !vscode.languages?.registerHoverProvider) return;
  vscode.languages.registerHoverProvider("*", {
    provideHover(document: { uri: { fsPath: string } }) {
      const hit = hoverQueue.find((d) => document.uri.fsPath.endsWith(d.file));
      return hit ? { contents: [hoverMarkdownFor(hit)] } : null;
    },
  });
  hoverBound = true;
}

async function promptReject(vscode: Vscode): Promise<{ reason: RejectReason; constraint: string } | null> {
  const reason = (await vscode.window.showQuickPick?.(REJECT_REASONS as string[], {
    placeHolder: "Reject reason (required)",
  })) as RejectReason | undefined;
  if (!reason) return null;
  const constraint = await vscode.window.showInputBox?.({
    prompt: 'Free-text constraint (required, e.g. "payment must remain strongly consistent")',
  });
  if (!constraint?.trim()) return null;
  return { reason, constraint: constraint.trim() };
}

/**
 * Registers deci.decision{Accept,Reject,Investigate} commands over a
 * live queue. `onChange` receives the queue after every transition so the
 * host can re-render decorations + panels. Reject prompts for reason +
 * constraint and aborts when either is missing.
 */
export function registerDecisionCommands(
  vscode: Vscode,
  initial: DecisionPoint[],
  onChange: (queue: DecisionPoint[]) => void = () => {},
): { get(): DecisionPoint[] } {
  let queue = initial;
  const set = (next: DecisionPoint[]) => {
    queue = next;
    onChange(queue);
  };
  vscode.commands.registerCommand("deci.decisionAccept", (id: unknown) => {
    if (typeof id === "string") set(acceptDecision(queue, id));
  });
  vscode.commands.registerCommand("deci.decisionInvestigate", (id: unknown) => {
    if (typeof id === "string") set(investigateDecision(queue, id));
  });
  vscode.commands.registerCommand("deci.decisionReject", async (id: unknown) => {
    if (typeof id !== "string") return;
    const answer = await promptReject(vscode);
    if (!answer) return;
    set(rejectDecision(queue, id, answer.reason, answer.constraint));
  });
  // NOTE: deci.showDecisions is registered once in activate() alongside the
  // other show* commands. Registering it here too killed activation outright:
  // the real API throws on duplicate registration ("already exists"), which
  // failed the whole extension with no tree data and no working commands.
  return { get: () => queue };
}

/**
 * US-012: in-memory sidebar list provider. Host calls `set()` after each
 * analysis; `getChildren`/`getTreeItem` satisfy the VS Code API shape.
 * No backend, no persistence beyond the session (local-first).
 */
export function createListProvider(initial: PanelNode[] = []): {
  nodes: PanelNode[];
  set(nodes: PanelNode[]): void;
  getChildren(): PanelNode[];
  getTreeItem(n: PanelNode): { label: string; description?: string; command?: unknown };
} {
  let nodes = [...initial];
  return {
    get nodes(): PanelNode[] {
      return nodes;
    },
    set(next: PanelNode[]): void {
      nodes = [...next];
    },
    getChildren(): PanelNode[] {
      return nodes;
    },
    getTreeItem(n: PanelNode): { label: string; description?: string; command?: unknown } {
      return {
        label: n.label,
        description: n.detail,
        command: n.command ? { command: n.command, title: n.label, arguments: n.args ?? [] } : undefined,
      };
    },
  };
}

/** US-012: History panel (local in-memory entries, newest last). */
export function showHistory(vscode: Vscode, entries: HistoryEntry[]): HistoryEntry[] {
  const panel = vscode.window.createWebviewPanel("deci.history", "History", 1, {});
  panel.webview.html = `<html><body><pre>${escapeHtml(renderHistoryMarkdown(entries))}</pre></body></html>`;
  return entries;
}

/** US-012: pure history append for a completed analysis. Exported for tests. */
export function noteReview(
  entries: HistoryEntry[],
  label: string,
  diffText: string,
  queue: DecisionPoint[],
  at?: string,
): HistoryEntry[] {
  return appendHistory(entries, historyEntryFor(label, buildReviewMap(diffText), queue, at));
}

export function viewIds(): PanelViewId[] {
  return PANEL_VIEWS.map((v) => v.id);
}

/**
 * US-012: Activity Bar wiring — registers the sidebar views
 * (Review | Decisions | Alternatives | Evidence | History | Chat) plus the full
 * command set: Review Map, Decisions, Alternative Studio A/B/C,
 * implementation plan preview, Generate patch, Verify output, Evidence,
 * output bundle, provider status, History, Chat. All local-first, no backend.
 */
/**
 * Activity Bar wiring — registers the sidebar views
 * (Review | Decisions | Alternatives | Evidence | History | Chat) plus the full
 * command set. Chat uses a file-backed store under the host-provided
 * storage dir (or cwd fallback in tests) and a ChatEngine over the same
 * provider/tool/context core as the CLI.
 */
export function activate(
  vscode: Vscode,
  opts: {
    storageDir?: string;
    workspaceRoot?: string;
    /** Navigate to a workspace file. Host implements with the real editor; omitted = copy-path fallback. */
    openDocument?: (path: string, line: number | null) => Promise<void>;
  } = {},
): {
  providers: Record<PanelViewId, ReturnType<typeof createListProvider>>;
  history: { list(): HistoryEntry[]; note(label: string, diffText: string, queue: DecisionPoint[]): void };
  chat: {
    store(): FileConversationStore;
    engine(): ChatEngine;
    getActive(): Conversation | null;
    refresh(): Promise<ConversationMeta[]>;
    /** Execute a registered block action against the real backend. Exported for tests. */
    doAction(action: string, params: Record<string, unknown>, approved: boolean): Promise<{ ok: boolean; detail: string }>;
  };
} {
  const workspaceRoot =
    opts.workspaceRoot ??
    (vscode as unknown as { workspace?: { workspaceFolders?: Array<{ uri: { fsPath: string } }> } }).workspace?.workspaceFolders?.[0]?.uri?.fsPath ??
    process.cwd();
  const storageDir = opts.storageDir ?? join(workspaceRoot, ".deci", "chat");

  const fsIo = {
    async readFile(p: string): Promise<string | null> {
      try {
        return readFileSync(p, "utf8");
      } catch {
        return null;
      }
    },
    async writeFile(p: string, c: string): Promise<void> {
      mkdirSync(join(p.split("/").slice(0, -1).join("/") || "."), { recursive: true });
      writeFileSync(p, c, "utf8");
    },
    async deleteFile(p: string): Promise<void> {
      try {
        const { unlinkSync } = await import("node:fs");
        unlinkSync(p);
      } catch {
        /* already gone */
      }
    },
    async listFiles(d: string): Promise<string[]> {
      try {
        const { readdirSync } = await import("node:fs");
        return readdirSync(d);
      } catch {
        return [];
      }
    },
    async mkdir(d: string): Promise<void> {
      mkdirSync(d, { recursive: true });
    },
  };
  const chatStore = new FileConversationStore(fsIo, storageDir);

  const gitRun = async (args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> => {
    try {
      const out = execFileSync("git", args, { cwd: workspaceRoot, encoding: "utf8", maxBuffer: 10 * 1024 * 1024 }) as string;
      return { stdout: out, stderr: "", exitCode: 0 };
    } catch (e: unknown) {
      const err = e as { stdout?: string; stderr?: string; status?: number };
      return { stdout: err.stdout ?? "", stderr: err.stderr ?? "", exitCode: err.status ?? 1 };
    }
  };
  const execRun = async (
    cmd: string,
    args: string[],
    runOpts: { cwd?: string; timeoutMs?: number } = {},
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> => {
    try {
      const out = execFileSync(cmd, args, {
        cwd: runOpts.cwd ?? workspaceRoot,
        encoding: "utf8",
        timeout: runOpts.timeoutMs ?? 60000,
        maxBuffer: 10 * 1024 * 1024,
      }) as string;
      return { stdout: out, stderr: "", exitCode: 0 };
    } catch (e: unknown) {
      const err = e as { stdout?: string; stderr?: string; status?: number };
      return { stdout: err.stdout ?? "", stderr: err.stderr ?? "", exitCode: err.status ?? 1 };
    }
  };
  const readText = async (p: string): Promise<string | null> => {
    try {
      return readFileSync(p.startsWith("/") ? p : join(workspaceRoot, p), "utf8");
    } catch {
      return null;
    }
  };
  const listWorkspace = async (root: string): Promise<string[] | null> => {
    try {
      const { readdirSync, statSync, lstatSync: lstat } = await import("node:fs");
      const { join: joinPath } = await import("node:path");
      const out: string[] = [];
      const walk = (dir: string, rel: string, depth: number): void => {
        if (depth > 6 || out.length >= 400) return;
        let entries: string[];
        try {
          entries = readdirSync(dir);
        } catch {
          return;
        }
        for (const e of entries) {
          if (e === "node_modules" || e === ".git" || e === "dist") continue;
          const abs = joinPath(dir, e);
          const rp = rel ? `${rel}/${e}` : e;
          try {
            if (lstat(abs).isSymbolicLink()) continue;
            if (statSync(abs).isDirectory()) walk(abs, rp, depth + 1);
            else {
              out.push(rp);
              if (out.length >= 400) return;
            }
          } catch {
            continue;
          }
        }
      };
      walk(root, "", 0);
      return out;
    } catch {
      return null;
    }
  };

  const contextIo = {
    workspaceRoot,
    readFile: readText,
    exists: async (p: string): Promise<boolean> => existsSync(p.startsWith("/") ? p : join(workspaceRoot, p)),
    listFiles: listWorkspace,
    git: gitRun,
    exec: execRun,
  };
  const toolContext = {
    workspaceRoot,
    readFile: readText,
    writeFile: async (p: string, c: string): Promise<void> => {
      writeFileSync(p.startsWith("/") ? p : join(workspaceRoot, p), c, "utf8");
    },
    exists: async (p: string): Promise<boolean> => existsSync(p.startsWith("/") ? p : join(workspaceRoot, p)),
    listFiles: listWorkspace,
    git: gitRun,
    exec: execRun,
  };
  const providerSettings = (): Record<string, string | undefined> => {
    try {
      const cfg = vscode.workspace.getConfiguration("deci");
      const get = (k: string): string | undefined => {
        try {
          const v = cfg.get<string>(k);
          return typeof v === "string" && v.trim() ? v : undefined;
        } catch {
          return undefined;
        }
      };
      void get;
    } catch {
      /* tests omit settings */
    }
    return {};
  };
  void providerSettings;
  type ChatPanel = { webview: { postMessage?(msg: unknown): void } };
  const panelHolder: { panel: ChatPanel | null } = { panel: null };
  const streamHolder: { id: string | null } = { id: null };
  const postToChat = (msg: unknown): void => {
    try {
      panelHolder.panel?.webview.postMessage?.(msg);
    } catch {
      /* webview gone */
    }
  };
  const chatEngine = new ChatEngine({
    store: chatStore,
    contextIo,
    providerInput: {},
    env: { ...process.env },
    toolContext,
    onStream: (chunk) => {
      const id = streamHolder.id;
      if (id) postToChat({ type: "messageChunk", chunk, messageId: id });
    },
    onToolEvent: (event, invocation, result) => {
      if (event === "start") postToChat({ type: "streamingState", streaming: true });
      else if (result?.error) postToChat({ type: "toolResult", result });
      else if (result) postToChat({ type: "toolResult", result });
    },
    onApprovalNeeded: async (invocation) => {
      postToChat({ type: "toolApproval", invocation });
      const answer = await vscode.window.showQuickPick?.(["Approve", "Reject"], {
        placeHolder: `Approve tool ${invocation.name}?`,
      });
      return answer === "Approve";
    },
  });

  const providers = {
    "deci.review": createListProvider(buildReviewNodes(buildReviewMap(""))),
    "deci.decisions": createListProvider(buildDecisionNodes([])),
    "deci.alternatives": createListProvider(buildAlternativeNodes(null)),
    "deci.evidence": createListProvider(buildEvidenceNodes([])),
    "deci.history": createListProvider(buildHistoryNodes([])),
    "deci.chat": createListProvider([]),
  } as Record<PanelViewId, ReturnType<typeof createListProvider>>;
  for (const view of PANEL_VIEWS) {
    vscode.window.registerTreeDataProvider?.(view.id, providers[view.id]);
  }
  let entries: HistoryEntry[] = [];
  const syncHistory = (): void => {
    providers["deci.history"].set(buildHistoryNodes(entries));
  };
  const queue = decisionsForDiff("");
  registerDecisionCommands(vscode, queue, (next) => {
    applyDecisionDecorations(vscode, next);
    providers["deci.decisions"].set(buildDecisionNodes(next));
  });

  let activeConv: Conversation | null = null;
  const syncChatList = async (): Promise<ConversationMeta[]> => {
    const conversations = await chatStore.list();
    providers["deci.chat"].set(
      conversations.map((c) => ({
        label: c.title,
        detail: `${c.messageCount} msgs`,
        command: "deci.openChat",
        args: [c.id],
      })),
    );
    return conversations;
  };
  // Fire-and-forget initial sync; tests call refresh() explicitly.
  void syncChatList();

  const pushChat = async (): Promise<void> => {
    const conversations = await chatStore.list();
    postToChat({ type: "updateConversations", conversations, activeId: activeConv?.id ?? null });
    if (activeConv) {
      const fresh = await chatStore.get(activeConv.id);
      if (fresh) activeConv = fresh;
      postToChat({
        type: "updateMessages",
        messages: activeConv.messages,
        contextFlags: activeConv.contextFlags,
        providerStatus: describeConfig(resolveProviderConfig({}, process.env)),
      });
    }
    await syncChatList();
  };

  const appendToolMessage = async (name: string, output: string, error?: string): Promise<void> => {
    if (!activeConv) return;
    const toolMsg: ChatMessageItem = {
      role: "tool",
      content: error ? `Error: ${error}` : output,
      timestamp: new Date().toISOString(),
      id: newMessageId(),
      toolResult: { callId: newMessageId(), name, output, error },
    };
    await chatStore.update(addMessage(activeConv, toolMsg));
    activeConv = await chatStore.get(activeConv.id);
  };

  /** Registered block actions → real backend operations. Backend re-validates
   *  everything; approval-gated actions refuse without approved=true. */
  const doAction = async (
    action: string,
    params: Record<string, unknown>,
    approved: boolean,
  ): Promise<{ ok: boolean; detail: string }> => {
    if (!(action in ACTION_REGISTRY)) return { ok: false, detail: `Unknown action: ${action}` };
    const reg = ACTION_REGISTRY[action as ActionName];
    if (reg.requiresApproval && !approved) {
      return { ok: false, detail: `Refused: action ${action} requires explicit approval. Nothing was changed.` };
    }
    try {
      switch (action as ActionName) {
        case "run_tests": {
          const paths = typeof params.paths === "string" ? params.paths : "";
          const res = await executeTool("run_tests", paths ? { paths } : {}, toolContext);
          if (res.error) {
            await appendToolMessage("run_tests", "", res.error);
            await pushChat();
            return { ok: false, detail: res.error };
          }
          await appendToolMessage("run_tests", res.output);
          await pushChat();
          return { ok: true, detail: res.output.slice(0, 500) };
        }
        case "propose_fix": {
          const testPath = typeof params.testPath === "string" ? params.testPath : "";
          if (!testPath) return { ok: false, detail: "propose_fix needs testPath." };
          const res = await executeTool("propose_fix", { testPath }, toolContext);
          if (res.error) {
            await appendToolMessage("propose_fix", "", res.error);
            await pushChat();
            return { ok: false, detail: res.error };
          }
          await appendToolMessage("propose_fix", res.output);
          await pushChat();
          return { ok: true, detail: res.output.slice(0, 500) };
        }
        case "apply_fix": {
          const testPath = typeof params.testPath === "string" ? params.testPath : "";
          if (!testPath) return { ok: false, detail: "apply_fix needs testPath." };
          const proposal = await proposeFixStructured(testPath, toolContext);
          if (!proposal.patch) {
            const detail = `No mechanical patch for \`${proposal.testPath}\` — fix must be human-authored.`;
            await appendToolMessage("apply_fix", detail);
            await pushChat();
            return { ok: false, detail };
          }
          const detail = await applyFixAfterApproval(proposal.patch, proposal.guardLines, toolContext);
          await appendToolMessage("apply_fix", detail);
          await pushChat();
          return { ok: true, detail };
        }
        case "explain":
        case "ask": {
          const q = typeof params.question === "string" && params.question.trim()
            ? params.question.trim()
            : typeof params.label === "string" && params.label.trim()
              ? `Explain: ${params.label.trim()}`
              : "Explain the selected item.";
          const sel: BlockSelection = {
            kind: typeof params.kind === "string" ? params.kind : "item",
            label: typeof params.label === "string" ? params.label : q,
            file: typeof params.file === "string" ? params.file : undefined,
            line: typeof params.line === "number" ? params.line : null,
          };
          if (!activeConv) return { ok: false, detail: "No active conversation." };
          streamHolder.id = null;
          await chatEngine.sendMessage(activeConv.id, q, { selection: sel });
          activeConv = await chatStore.get(activeConv.id);
          await pushChat();
          return { ok: true, detail: "Asked with selection context." };
        }
        case "open_file": {
          const r = await openFile(
            typeof params.path === "string" ? params.path : "",
            typeof params.line === "number" ? params.line : null,
          );
          return r;
        }
      }
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      await appendToolMessage(action, "", detail);
      await pushChat();
      return { ok: false, detail };
    }
    return { ok: false, detail: `Unhandled action: ${action}` };
  };

  const openFile = async (path: string, line: number | null): Promise<{ ok: boolean; detail: string }> => {
    const clean = path.trim().replace(/\\/g, "/");
    if (!clean || clean.includes("\0") || clean.startsWith("/") || /^[A-Za-z]:\//.test(clean) || clean.split("/").includes("..")) {
      return { ok: false, detail: `Refused: \`${path}\` is outside the workspace.` };
    }
    if (!opts.openDocument) return { ok: false, detail: `Open \`${clean}${line ? `:${line}` : ""}\` in your editor (navigation hook unavailable in this host).` };
    await opts.openDocument(clean, line);
    return { ok: true, detail: `Opened ${clean}${line ? `:${line}` : ""}.` };
  };

  vscode.commands.registerCommand("deci.openChat", async (convId: unknown) => {
    const conversations = await chatStore.list();
    const providerConfig = resolveProviderConfig({}, process.env);
    const target = typeof convId === "string" ? await chatStore.get(convId) : null;
    activeConv = target ?? (conversations.length > 0 ? await chatStore.get(conversations[0]?.id ?? "") : null);
    const panel = vscode.window.createWebviewPanel("deci.chat", "Deci Chat", 1, { enableScripts: true });
    panelHolder.panel = panel as unknown as ChatPanel;
    panel.webview.html = buildChatHtml(
      conversations,
      activeConv?.id ?? null,
      activeConv?.messages ?? [],
      activeConv?.contextFlags ?? { activeFile: true, diff: true, impact: true, tests: true, apiContracts: true, docs: true },
      providerConfig,
    );
    panel.webview.onDidReceiveMessage?.(async (raw) => {
      const msg = (raw ?? {}) as Record<string, unknown>;
      try {
        switch (msg.type) {
          case "selectConversation": {
            if (typeof msg.conversationId === "string") {
              activeConv = await chatStore.get(msg.conversationId);
              await pushChat();
            }
            break;
          }
          case "newConversation": {
            const conv = createConversation(typeof msg.title === "string" && msg.title.trim() ? msg.title.trim() : "New conversation");
            await chatStore.create(conv);
            activeConv = conv;
            await pushChat();
            break;
          }
          case "sendMessage": {
            if (typeof msg.text === "string" && activeConv) {
              postToChat({ type: "streamingState", streaming: true });
              const res = await chatEngine.sendMessage(activeConv.id, msg.text);
              streamHolder.id = null;
              activeConv = await chatStore.get(activeConv.id);
              if (res.message.blocks?.length) {
                postToChat({ type: "blockUpdate", messageId: res.message.id, blocks: res.message.blocks, warnings: res.message.blockWarnings ?? [] });
              }
              await pushChat();
            }
            break;
          }
          case "askAbout": {
            if (activeConv && msg.selection && typeof msg.selection === "object") {
              const s = msg.selection as Record<string, unknown>;
              const sel: BlockSelection = {
                kind: typeof s.kind === "string" ? s.kind : "item",
                label: typeof s.label === "string" ? s.label.slice(0, 200) : "selected item",
                file: typeof s.file === "string" ? s.file : undefined,
                line: typeof s.line === "number" ? s.line : null,
              };
              postToChat({ type: "streamingState", streaming: true });
              await chatEngine.sendMessage(activeConv.id, `Explain this ${sel.kind}: ${sel.label}`, { selection: sel });
              activeConv = await chatStore.get(activeConv.id);
              await pushChat();
            }
            break;
          }
          case "doAction": {
            if (typeof msg.action === "string" && msg.params && typeof msg.params === "object") {
              await doAction(msg.action, msg.params as Record<string, unknown>, msg.approved === true);
            }
            break;
          }
          case "openFile": {
            if (typeof msg.path === "string") {
              const r = await openFile(msg.path, typeof msg.line === "number" || typeof msg.line === "string" && msg.line !== "" ? Number(msg.line) : null);
              if (!r.ok) postToChat({ type: "error", error: r.detail });
            }
            break;
          }
          case "toggleContextFlag": {
            if (activeConv && typeof msg.flag === "string") {
              const updated = updateContextFlags(activeConv, { [msg.flag]: msg.active === true });
              await chatStore.update(updated);
              activeConv = updated;
              await pushChat();
            }
            break;
          }
          case "retry": {
            if (activeConv) {
              postToChat({ type: "streamingState", streaming: true });
              await chatEngine.retry(activeConv.id);
              activeConv = await chatStore.get(activeConv.id);
              await pushChat();
            }
            break;
          }
          case "cancel": {
            chatEngine.cancel();
            postToChat({ type: "streamingState", streaming: false });
            break;
          }
          case "approveTool": {
            chatEngine.resolveApproval(true);
            break;
          }
        }
      } catch (err) {
        postToChat({ type: "error", error: err instanceof Error ? err.message : String(err) });
        postToChat({ type: "streamingState", streaming: false });
      }
    });
    await pushChat();
  });
  vscode.commands.registerCommand("deci.chat.new", async (title: unknown) => {
    const name = typeof title === "string" && title.trim()
      ? title.trim()
      : await vscode.window.showInputBox?.({ prompt: "Conversation title" });
    const conv = createConversation((name ?? "").trim() || "New conversation");
    await chatStore.create(conv);
    activeConv = conv;
    await syncChatList();
  });
  vscode.commands.registerCommand("deci.chat.delete", async (convId: unknown) => {
    if (typeof convId !== "string") return;
    await chatStore.delete(convId);
    if (activeConv?.id === convId) activeConv = null;
    await syncChatList();
  });
  vscode.commands.registerCommand("deci.chat.rename", async (convId: unknown, title: unknown) => {
    if (typeof convId !== "string") return;
    const next = typeof title === "string" && title.trim()
      ? title.trim()
      : await vscode.window.showInputBox?.({ prompt: "New title" });
    if (!next?.trim()) return;
    const conv = await chatStore.get(convId);
    if (!conv) return;
    await chatStore.update(renameConversation(conv, next.trim()));
    await syncChatList();
  });
  vscode.commands.registerCommand("deci.chat.send", async (text: unknown) => {
    if (typeof text !== "string" || !activeConv) return;
    postToChat({ type: "streamingState", streaming: true });
    await chatEngine.sendMessage(activeConv.id, text);
    activeConv = await chatStore.get(activeConv.id);
    await pushChat();
  });
  vscode.commands.registerCommand("deci.chat.retry", async () => {
    if (!activeConv) return;
    postToChat({ type: "streamingState", streaming: true });
    await chatEngine.retry(activeConv.id);
    activeConv = await chatStore.get(activeConv.id);
    await pushChat();
  });
  vscode.commands.registerCommand("deci.chat.toggleFlag", async (flag: unknown, on: unknown) => {
    if (!activeConv || typeof flag !== "string") return;
    const updated = updateContextFlags(activeConv, { [flag]: on === true });
    await chatStore.update(updated);
    activeConv = updated;
  });
  vscode.commands.registerCommand("deci.chat.approve", async (approved: unknown) => {
    chatEngine.resolveApproval(approved === true);
  });
  vscode.commands.registerCommand("deci.chat.cancel", () => {
    chatEngine.cancel();
  });

  vscode.commands.registerCommand("deci.showReviewMap", (diffText: unknown) => {
    const diff = typeof diffText === "string" ? diffText : "";
    const q = decisionsForDiff(diff);
    providers["deci.review"].set(buildReviewNodes(buildReviewMap(diff)));
    providers["deci.decisions"].set(buildDecisionNodes(q));
    providers["deci.evidence"].set(
      buildEvidenceNodes(
        collectQueueEvidence(
          q,
          emptyContext({ changedFiles: [...new Set(q.map((d) => d.file))] }),
        ),
      ),
    );
    entries = noteReview(entries, `review ${entries.length + 1}`, diff, q);
    syncHistory();
    return showReviewMap(vscode, diff);
  });
  vscode.commands.registerCommand("deci.showDecisions", (diffText: unknown) =>
    showDecisions(vscode, typeof diffText === "string" ? diffText : ""),
  );
  vscode.commands.registerCommand("deci.showHistory", () => showHistory(vscode, entries));
  vscode.commands.registerCommand("deci.showEvidenceFor", (queueArg: unknown) => {
    const q = Array.isArray(queueArg) ? (queueArg as DecisionPoint[]) : decisionsForDiff("");
    return showEvidence(vscode, q);
  });
  vscode.commands.registerCommand("deci.showBundleFor", (diff: unknown, queueArg: unknown) =>
    showOutputBundle(
      vscode,
      typeof diff === "string" ? diff : "",
      Array.isArray(queueArg) ? (queueArg as DecisionPoint[]) : [],
    ),
  );
  vscode.commands.registerCommand("deci.showProvider", () => showProviderStatus(vscode));
  vscode.commands.registerCommand("deci.showImpactReport", (html: unknown) => {
    if (typeof html === "string" && html) showImpactReport(vscode, html);
  });
  return {
    providers,
    history: {
      list: () => entries,
      note: (label: string, diffText: string, q: DecisionPoint[]) => {
        entries = noteReview(entries, label, diffText, q);
        syncHistory();
      },
    },
    chat: {
      store: () => chatStore,
      engine: () => chatEngine,
      getActive: () => activeConv,
      refresh: () => syncChatList(),
      doAction,
    },
  };
}
