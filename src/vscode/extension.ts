// VS Code host: Review Map webview (US-001) + ranked decision queue with
// gutter icons + hover cards + Accept/Reject/Investigate commands (US-004).
// Core stays pure in decisions.ts; this file is the thin editor adapter.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from "node:fs";
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
  type TicketInput,
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
import { parseFileHunks } from "../semantic.js";
import { symbolsForHunks } from "../symbols.js";
import { buildImpactMap, type ImpactMap } from "../impact.js";
import { discoverTests, type TestDiscovery } from "../discover.js";
import { selectTests, type TestSelection } from "../select.js";
import { runTests as runSelectedTests } from "../run.js";
import { diagnoseFailure } from "../diagnose.js";
import { generateTests, writeGeneratedTests, type GeneratedTest } from "../generate.js";
import { buildRollbackPlan, buildTestPlan, type RollbackPlan, type TestPlan } from "../bundle.js";
import { explainChange } from "../operations.js";
import { checkProvider, PROVIDER_SPECS, resolveProvider, type DeciOperation } from "../providers.js";
import { parseDiffHunks } from "./ui/diffModel.js";
import type { ReviewMap } from "../reviewMap.js";
import { DECI_CSS } from "./ui/css.js";
import { BASE_CLIENT_JS, doc, makeNonce } from "./ui/html.js";
import {
  DIFF_REVIEW_CLIENT_JS,
  buildDiffReviewHtml,
  diffFileHtml,
  type DiffReviewVM,
  type FindingVM,
} from "./ui/diffReview.js";
import { SIDEBAR_CLIENT_JS, buildSidebarHtml } from "./ui/sidebar.js";
import { SETTINGS_CLIENT_JS, buildSettingsHtml, type SettingsVM } from "./ui/settings.js";
import { NEW_REVIEW_CLIENT_JS, buildNewReviewHtml } from "./ui/newReview.js";
import { HISTORY_CLIENT_JS, historyPanelHtml } from "./ui/historyCompare.js";
import { TESTS_CLIENT_JS, testsPanelHtml, type TestRow } from "./ui/testsPanel.js";
import {
  addNote,
  deleteNote,
  decisionsPath,
  notesFor,
  notesPath,
  parseDecided,
  parseNotes,
  serializeDecided,
  serializeNotes,
  toggleNoteResolved,
  type DecidedState,
  type NoteMap,
} from "./ui/notes.js";

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
    showInformationMessage?(message: string): void;
    showErrorMessage?(message: string): void;
    registerWebviewViewProvider?(viewId: string, provider: unknown): unknown;
    activeTextEditor?: {
      document: { uri: { fsPath: string }; lineCount: number };
      setDecorations?(kind: unknown, ranges: unknown[]): void;
    };
    createTextEditorDecorationType?(options: unknown): unknown;
    registerTreeDataProvider?(viewId: string, provider: unknown): unknown;
  };
  workspace: {
    getConfiguration(section: string): {
      get<T>(key: string): T | undefined;
      update?(key: string, value: unknown): unknown;
    };
    /** Real-fs adapter for ref reads (host injects; tests omit). */
    fs?: {
      exists: (path: string) => boolean;
      read: (path: string) => string;
      write?: (path: string, content: string) => void;
    };
  };
  /** SecretStorage passthrough (host injects; tests omit → key UI degrades). */
  secrets?: {
    get(key: string): Promise<string | undefined>;
    store(key: string, value: string): Promise<void>;
    delete(key: string): Promise<void>;
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

  const openChatPanel = async (convId: unknown): Promise<void> => {
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
  };
  vscode.commands.registerCommand("deci.openChat", openChatPanel);
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
    showReviewMap(vscode, diff);
    // Feed the new interactive UI from the same diff (history already noted above).
    void (async () => {
      await runUiAnalysis(diff, await headRev(), { skipNote: true });
      await openDiffReview();
    })();
    return undefined;
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

  // ---------- Interactive review UI (webviews; core untouched) ----------
  interface UiSession {
    rev: string;
    diff: string;
    map: ReviewMap;
    queue: DecisionPoint[];
    evidence: EvidenceBundle[];
    impact: ImpactMap | null;
    discovery: TestDiscovery | null;
    selection: TestSelection | null;
    verify: VerifyReport | null;
    generated: GeneratedTest[];
    results: TestRow[];
    diagnosis: string | null;
    fixDiff: string | null;
    fixPatch: { path: string; diff: string; description: string } | null;
    fixGuards: string[];
    testPlan: TestPlan | null;
    rollbackPlan: RollbackPlan | null;
    aiCard: string | null;
    alternatives: AlternativeSet | null;
    notes: NoteMap;
    decided: Record<string, DecidedState>;
    expandedFile: string | null;
    view: "unified" | "split";
    compareSel: string[];
    error: string | null;
  }
  let ui: UiSession | null = null;
  let branchLabel = "";
  const reviewDiffs = new Map<string, string>();
  type UiWebview = {
    html: string;
    postMessage?(msg: unknown): void;
    onDidReceiveMessage?(cb: (msg: Record<string, unknown>) => void): unknown;
  };
  let diffView: UiWebview | null = null;
  let sideView: UiWebview | null = null;

  const readRepoSync = (rel: string): string | null => {
    try {
      return readFileSync(join(workspaceRoot, rel), "utf8");
    } catch {
      return null;
    }
  };
  const listRepoSync = (root: string): string[] | null => {
    try {
      const out: string[] = [];
      const walk = (dir: string, rel: string, depth: number): void => {
        if (depth > 6 || out.length >= 400) return;
        let ents: string[];
        try {
          ents = readdirSync(dir);
        } catch {
          return;
        }
        for (const e of ents) {
          if (e === "node_modules" || e === ".git" || e === "dist" || e === ".deci") continue;
          const abs = join(dir, e);
          const rp = rel ? `${rel}/${e}` : e;
          try {
            const st = statSync(abs);
            if (st.isDirectory()) walk(abs, rp, depth + 1);
            else out.push(rp);
          } catch {
            /* skip */
          }
        }
      };
      walk(root, "", 0);
      return out;
    } catch {
      return null;
    }
  };
  const repoIoSync = {
    listFiles: (r: string): string[] | null => listRepoSync(r),
    read: (p: string): string => {
      const c = readRepoSync(p);
      if (c === null) throw new Error(`unreadable ${p}`);
      return c;
    },
  };
  const syncExec = (cmd: string): { exitCode: number; output: string } => {
    try {
      const out = execFileSync(cmd, {
        cwd: workspaceRoot,
        encoding: "utf8",
        timeout: 180000,
        maxBuffer: 10 * 1024 * 1024,
        shell: true,
      }) as string;
      return { exitCode: 0, output: out };
    } catch (e: unknown) {
      const err = e as { stdout?: string; stderr?: string; status?: number };
      return { exitCode: err.status ?? 1, output: `${err.stdout ?? ""}\n${err.stderr ?? ""}` };
    }
  };
  const loadNotes = (rev: string): NoteMap => {
    try {
      const p = join(workspaceRoot, notesPath(rev));
      if (vscode.workspace.fs?.exists(p)) return parseNotes(vscode.workspace.fs.read(p));
    } catch {
      /* fall through */
    }
    return {};
  };
  const saveNotes = (rev: string, map: NoteMap): void => {
    try {
      vscode.workspace.fs?.write?.(join(workspaceRoot, notesPath(rev)), serializeNotes(map));
    } catch {
      /* degraded host without write */
    }
  };
  const loadDecided = (rev: string): Record<string, DecidedState> => {
    try {
      const p = join(workspaceRoot, decisionsPath(rev));
      if (vscode.workspace.fs?.exists(p)) return parseDecided(vscode.workspace.fs.read(p));
    } catch {
      /* fall through */
    }
    return {};
  };
  const saveDecided = (rev: string, saved: Record<string, DecidedState>): void => {
    try {
      vscode.workspace.fs?.write?.(join(workspaceRoot, decisionsPath(rev)), serializeDecided(saved));
    } catch {
      /* degraded host without write */
    }
  };
  const applyDecided = (queue: DecisionPoint[], saved: Record<string, DecidedState>): DecisionPoint[] =>
    queue.map((d) => {
      const s = saved[d.id];
      return s ? { ...d, status: s.status, rejectReason: (s.reason ?? d.rejectReason) as DecisionPoint["rejectReason"], constraint: s.constraint ?? d.constraint, decidedAt: s.decidedAt } : d;
    });
  const headRev = async (): Promise<string> => {
    try {
      const r = await gitRun(["rev-parse", "HEAD"]);
      return r.stdout.trim() || "worktree";
    } catch {
      return "worktree";
    }
  };

  const findingsVm = (): FindingVM[] => {
    if (!ui) return [];
    return ui.queue.map((d) => {
      const b = ui?.evidence.find((x) => x.decisionId === d.id);
      return {
        decision: d,
        evidencePresent: b ? `${b.present}/${b.items.length} present` : "—",
        notes: notesFor(ui?.notes ?? {}, d.id, d.file, d.line),
      };
    });
  };
  const diffVm = (): DiffReviewVM | null => {
    if (!ui) return null;
    const files = parseDiffHunks(ui.diff);
    return {
      rev: ui.rev,
      files,
      fileMeta: new Map(ui.map.files.map((f) => [f.path, f])),
      findings: findingsVm(),
      evidence: ui.evidence,
      impact: ui.impact,
      discovery: ui.discovery,
      selection: ui.selection,
      testPlan: ui.testPlan,
      rollbackPlan: ui.rollbackPlan,
      expandedFile: ui.expandedFile,
      view: ui.view,
      stale: false,
      aiCard: ui.aiCard,
    };
  };
  const pushDiffFile = (): void => {
    const vm = diffVm();
    if (!vm || !diffView?.postMessage) return;
    const file = vm.files.find((f) => f.path === vm.expandedFile) ?? vm.files[0];
    if (!file) return;
    diffView.postMessage({ type: "patch", target: "drFile", html: diffFileHtml(vm, file, false) });
  };
  const sidebarVm = async (): Promise<Parameters<typeof buildSidebarHtml>[0]> => ({
    branch: branchLabel,
    map: ui?.map ?? null,
    queue: ui?.queue ?? [],
    evidence: ui?.evidence ?? [],
    alternatives: ui?.alternatives ?? null,
    history: entries,
    conversations: await chatStore.list().catch(() => []),
    activeConvId: activeConv?.id ?? null,
  });
  const pushSidebar = async (): Promise<void> => {
    if (!sideView?.postMessage) return;
    sideView.postMessage({ type: "patch", target: "sidebar", html: buildSidebarHtml(await sidebarVm()) });
  };
  const refreshTrees = (): void => {
    if (!ui) return;
    providers["deci.review"].set(buildReviewNodes(ui.map));
    providers["deci.decisions"].set(buildDecisionNodes(ui.queue));
    providers["deci.evidence"].set(buildEvidenceNodes(ui.evidence));
  };

  /** Full local pipeline for one diff. Async bits (test runs, AI) stream in via patches. */
  const runUiAnalysis = async (
    diff: string,
    rev: string,
    opts: { verify?: boolean; staticOnly?: boolean; genTests?: boolean; runTests?: boolean; aiExplain?: boolean; skipNote?: boolean; ticket?: TicketInput | null; designDoc?: TicketInput | null } = {},
  ): Promise<void> => {
    const map = buildReviewMap(diff);
    const decided = loadDecided(rev);
    const queue = applyDecided(decisionsForDiff(diff), decided);
    const changedFiles = [...new Set(queue.map((d) => d.file))];
    const evidence = collectQueueEvidence(queue, emptyContext({
      changedFiles,
      ...(opts.ticket ? { ticket: opts.ticket } : {}),
      ...(opts.designDoc ? { designDoc: opts.designDoc } : {}),
    }));
    let impact: ImpactMap | null = null;
    try {
      impact = buildImpactMap(symbolsForHunks(parseFileHunks(diff)), changedFiles, repoIoSync, workspaceRoot);
    } catch {
      impact = null;
    }
    let discovery: TestDiscovery | null = null;
    let selection: TestSelection | null = null;
    try {
      discovery = discoverTests(repoIoSync, workspaceRoot);
      selection = selectTests(changedFiles, impact ?? { edges: [], directFiles: [], indirectFiles: [], testFiles: [], scannedFiles: 0, truncated: false, unresolved: [] }, discovery.tests);
    } catch {
      /* discovery is best-effort */
    }
    const report = runFullVerify(diff, { runCommands: false });
    const verifiedMap = applyVerification(map, report.verifiedPaths);
    ui = {
      rev, diff, map: verifiedMap, queue, evidence, impact, discovery, selection,
      verify: report, generated: [], results: [], diagnosis: null, fixDiff: null,
      fixPatch: null, fixGuards: [], testPlan: buildTestPlan(queue, report, evidence),
      rollbackPlan: buildRollbackPlan(changedFiles), aiCard: null, alternatives: null,
      notes: loadNotes(rev), decided, expandedFile: null, view: "unified", compareSel: [], error: null,
    };
    if (!opts.skipNote) {
      entries = noteReview(entries, `review ${entries.length + 1}`, diff, queue);
      const last = entries[entries.length - 1];
      if (last) reviewDiffs.set(last.id, diff);
      syncHistory();
    }
    refreshTrees();
    applyDecisionDecorations(vscode, queue);
    void pushSidebar();
    if (opts.verify) {
      try {
        const full = opts.staticOnly
          ? runFullVerify(diff, { runCommands: false })
          : runFullVerify(diff, { runCommands: true }, syncExec);
        if (ui && ui.diff === diff) {
          ui.verify = full;
          ui.map = applyVerification(ui.map, full.verifiedPaths);
          refreshTrees();
          void pushSidebar();
        }
      } catch (err) {
        if (ui && ui.diff === diff) ui.error = err instanceof Error ? err.message : String(err);
      }
    }
    if (opts.genTests && ui && ui.diff === diff) {
      try {
        const symbols = symbolsForHunks(parseFileHunks(diff));
        const fw = (discovery?.frameworks.find((f) => f === "node:test" || f === "jest" || f === "vitest") ?? "node:test") as "node:test" | "jest" | "vitest";
        ui.generated = generateTests(symbols, { readFile: (p) => readRepoSync(p) }, fw);
      } catch {
        /* best-effort */
      }
    }
    if (opts.runTests && ui && ui.diff === diff) {
      try {
        const runnable = (ui.selection?.selected ?? []).filter((t) => t.command.length > 0);
        const out = await runSelectedTests(runnable, { cwd: workspaceRoot, timeoutMs: 120000, revision: rev });
        if (ui && ui.diff === diff) {
          ui.results = out.map((r) => ({ path: r.path, status: r.status, detail: r.detail, output: r.output }));
          void pushSidebar();
        }
      } catch (err) {
        if (ui && ui.diff === diff) ui.error = err instanceof Error ? err.message : String(err);
      }
    }
    if (opts.aiExplain && ui && ui.diff === diff) {
      try {
        const cfg = vscode.workspace.getConfiguration("deci");
        const allowCloud = cfg.get<boolean>("allowCloudAi") === true || process.env.DECI_ALLOW_CLOUD_AI === "1";
        const routes = (cfg.get<Record<string, string>>("routing") ?? {}) as Partial<Record<DeciOperation, string>>;
        const defaultProvider = resolveProvider({ provider: cfg.get<string>("provider") ?? "ollama" }, process.env);
        if (defaultProvider.dataClass !== "local" && !allowCloud) {
          ui.aiCard = "AI explanation refused: cloud provider needs explicit opt-in — enable “Allow cloud AI” in Settings.";
        } else {
          const res = await explainChange(
            { defaultProvider, routes, env: process.env as Record<string, string | undefined> },
            { summary: `${ui.map.totalLoc} LOC across ${ui.map.files.length} files`, files: changedFiles, diffExcerpt: diff.slice(0, 8000) },
          );
          if (ui && ui.diff === diff) ui.aiCard = `AI explanation (${res.handledBy.provider}:${res.handledBy.model}):\n${res.text}`;
        }
      } catch (err) {
        if (ui && ui.diff === diff) ui.aiCard = `AI explanation unavailable: ${err instanceof Error ? err.message : String(err)}`;
      }
    }
  };

  const openDiffReview = async (diffText?: string): Promise<void> => {
    if (typeof diffText === "string") {
      await runUiAnalysis(diffText, await headRev());
    } else if (!ui) {
      const d = await gitRun(["diff", "HEAD", "--"]);
      await runUiAnalysis(d.stdout, await headRev());
    }
    const vm = diffVm();
    const panel = vscode.window.createWebviewPanel("deci.diffReview", "Diff Review", 1, { enableScripts: true });
    diffView = panel.webview as unknown as UiWebview;
    const nonce = makeNonce();
    panel.webview.html = vm
      ? doc({ title: "Diff Review", css: DECI_CSS, body: buildDiffReviewHtml(vm), state: { view: vm.view, expandedFile: vm.expandedFile }, nonce, clientJs: `${BASE_CLIENT_JS}\n${DIFF_REVIEW_CLIENT_JS}` })
      : doc({ title: "Diff Review", css: DECI_CSS, body: "<div class=\"deci-wrap\"><p class=\"muted\">No review yet — run an analysis first.</p></div>", nonce, clientJs: `${BASE_CLIENT_JS}\n${DIFF_REVIEW_CLIENT_JS}` });
    panel.webview.onDidReceiveMessage?.((raw) => {
      void onUiMessage((raw ?? {}) as Record<string, unknown>);
    });
  };

  const openSettingsPanel = async (): Promise<void> => {
    const cfg = vscode.workspace.getConfiguration("deci");
    const get = <T,>(key: string): T | undefined => {
      try {
        return cfg.get<T>(key);
      } catch {
        return undefined;
      }
    };
    const env = process.env;
    const activeProvider = get<string>("provider") ?? env.DECI_PROVIDER ?? "ollama";
    const savedProviders = get<Record<string, { baseURL?: string; model?: string }>>("providers") ?? {};
    const providers: SettingsVM["providers"] = await Promise.all(
      PROVIDER_SPECS.map(async (spec) => {
        const upper = spec.id.toUpperCase().replace(/-/g, "_");
        const saved = savedProviders[spec.id] ?? {};
        let keySet = false;
        try {
          keySet = (await vscode.secrets?.get(`deci.key.${spec.id}`)) ? true : false;
        } catch {
          keySet = false;
        }
        if (!keySet && spec.needsKey) {
          keySet = Boolean(env[`DECI_${upper}_API_KEY`] ?? env.DECI_API_KEY);
        }
        const envOverridden: string[] = [];
        if (env.DECI_PROVIDER === spec.id) envOverridden.push("DECI_PROVIDER");
        if (env[`DECI_${upper}_BASE_URL`]) envOverridden.push(`DECI_${upper}_BASE_URL`);
        if (env[`DECI_${upper}_MODEL`]) envOverridden.push(`DECI_${upper}_MODEL`);
        if (env[`DECI_${upper}_API_KEY`]) envOverridden.push(`DECI_${upper}_API_KEY`);
        return {
          spec,
          baseURL: saved.baseURL ?? spec.defaultBaseURL ?? "",
          model: saved.model ?? "",
          keySet,
          envOverridden,
        };
      }),
    );
    const vm: SettingsVM = {
      providers,
      activeProvider,
      routing: get<Record<string, string>>("routing") ?? {},
      fallback: get<string[]>("fallback") ?? [],
      allowCloudAi: get<boolean>("allowCloudAi") ?? env.DECI_ALLOW_CLOUD_AI === "1",
      allowCloudFallback: get<boolean>("allowCloudFallback") ?? env.DECI_ALLOW_CLOUD_FALLBACK === "1",
      verify: get<boolean>("verify") ?? true,
      staticOnly: get<boolean>("staticOnly") ?? false,
      testTimeoutMs: get<number>("testTimeoutMs") ?? 120000,
      dirty: false,
    };
    const panel = vscode.window.createWebviewPanel("deci.settings", "Deci Settings", 1, { enableScripts: true });
    const nonce = makeNonce();
    settingsView = panel.webview as unknown as UiWebview;
    settingsView.html = doc({
      title: "Deci Settings", css: DECI_CSS, body: buildSettingsHtml(vm), nonce,
      clientJs: `${BASE_CLIENT_JS}\n${SETTINGS_CLIENT_JS}`,
    });
    panel.webview.onDidReceiveMessage?.((raw) => {
      void onUiMessage((raw ?? {}) as Record<string, unknown>, panel.webview as unknown as UiWebview);
    });
  };

  const openNewReviewPanel = async (): Promise<void> => {
    const branches = await gitRun(["branch", "--format=%(refname:short)"]);
    const list = branches.exitCode === 0 ? branches.stdout.split("\n").map((b) => b.trim()).filter(Boolean) : [];
    const vm = {
      hasGit: branches.exitCode === 0,
      branches: list.length ? list : ["main"],
      defaultBranch: list.includes("main") ? "main" : (list[0] ?? "main"),
      verify: true, staticOnly: false, genTests: false, runTests: false, diagnose: false, aiExplain: false,
      busy: false, error: null as string | null,
    };
    const panel = vscode.window.createWebviewPanel("deci.newReview", "Deci: New Review", 1, { enableScripts: true });
    const nonce = makeNonce();
    (panel.webview as unknown as UiWebview).html = doc({
      title: "Deci: New Review", css: DECI_CSS, body: buildNewReviewHtml(vm), nonce,
      clientJs: `${BASE_CLIENT_JS}\n${NEW_REVIEW_CLIENT_JS}`,
    });
    panel.webview.onDidReceiveMessage?.((raw) => {
      void onUiMessage((raw ?? {}) as Record<string, unknown>, panel.webview as unknown as UiWebview);
    });
  };

  const openTestsPanel = async (): Promise<void> => {
    const panel = vscode.window.createWebviewPanel("deci.tests", "Deci Tests", 1, { enableScripts: true });
    const nonce = makeNonce();
    const render = (): string => testsPanelHtml({
      verify: ui?.verify ?? null, verifying: false,
      discovery: ui?.discovery ?? null, selection: ui?.selection ?? null,
      results: ui?.results ?? [], generated: (ui?.generated ?? []).map((g) => ({ path: g.path, added: false })),
      diagnosis: ui?.diagnosis ?? null, fixDiff: ui?.fixDiff ?? null, error: ui?.error ?? null,
    });
    (panel.webview as unknown as UiWebview).html = doc({
      title: "Deci Tests", css: DECI_CSS, body: render(), nonce,
      clientJs: `${BASE_CLIENT_JS}\n${TESTS_CLIENT_JS}`,
    });
    testsView = panel.webview as unknown as UiWebview;
    panel.webview.onDidReceiveMessage?.((raw) => {
      void onUiMessage((raw ?? {}) as Record<string, unknown>, panel.webview as unknown as UiWebview);
    });
  };
  let testsView: UiWebview | null = null;
  const pushTests = (): void => {
    if (!testsView?.postMessage || !ui) return;
    testsView.postMessage({
      type: "patch", target: "tests",
      html: testsPanelHtml({
        verify: ui.verify, verifying: false, discovery: ui.discovery, selection: ui.selection,
        results: ui.results, generated: ui.generated.map((g) => ({ path: g.path, added: false })),
        diagnosis: ui.diagnosis, fixDiff: ui.fixDiff, error: ui.error,
      }),
    });
  };

  const openHistoryPanel = async (): Promise<void> => {
    const panel = vscode.window.createWebviewPanel("deci.historyView", "Deci History", 1, { enableScripts: true });
    const nonce = makeNonce();
    const render = (): string => {
      const sel = ui?.compareSel ?? [];
      const [a, b] = sel.map((id) => entries.find((e) => e.id === id)).filter((e) => e !== undefined);
      return historyPanelHtml({ entries, selected: sel, compare: a && b ? { a, b } : null });
    };
    (panel.webview as unknown as UiWebview).html = doc({
      title: "Deci History", css: DECI_CSS, body: render(), nonce,
      clientJs: `${BASE_CLIENT_JS}\n${HISTORY_CLIENT_JS}`,
    });
    historyView = panel.webview as unknown as UiWebview;
    panel.webview.onDidReceiveMessage?.((raw) => {
      void onUiMessage((raw ?? {}) as Record<string, unknown>, panel.webview as unknown as UiWebview);
    });
  };
  let historyView: UiWebview | null = null;
  const pushHistory = (): void => {
    if (!historyView?.postMessage) return;
    const sel = ui?.compareSel ?? [];
    const [a, b] = sel.map((id) => entries.find((e) => e.id === id)).filter((e) => e !== undefined);
    historyView.postMessage({
      type: "patch", target: "history",
      html: historyPanelHtml({ entries, selected: sel, compare: a && b ? { a, b } : null }),
    });
  };

  const decide = async (id: string, action: string, reason?: string, constraint?: string): Promise<void> => {
    if (!ui) return;
    if (action === "accept") {
      ui.queue = acceptDecision(ui.queue, id);
      ui.decided[id] = { status: "accepted", decidedAt: new Date().toISOString() };
    } else if (action === "investigate") {
      ui.queue = investigateDecision(ui.queue, id);
      ui.decided[id] = { status: "investigating", decidedAt: new Date().toISOString() };
    } else if (action === "reject") {
      let r = reason;
      let c = constraint;
      if (!r) {
        r = await vscode.window.showQuickPick?.(REJECT_REASONS, { placeHolder: "Reject reason" });
        if (!r) return;
      }
      if (!c) {
        c = await vscode.window.showInputBox?.({ prompt: "Constraint (required — what must hold instead?)" });
        if (!c?.trim()) return;
      }
      try {
        ui.queue = rejectDecision(ui.queue, id, r as RejectReason, c);
      } catch {
        return;
      }
      ui.decided[id] = { status: "rejected", reason: r, constraint: c.trim(), decidedAt: new Date().toISOString() };
      const d = ui.queue.find((x) => x.id === id);
      if (d) {
        try {
          ui.alternatives = generateAlternatives(d);
        } catch {
          ui.alternatives = null;
        }
      }
    } else {
      return;
    }
    saveDecided(ui.rev, ui.decided);
    applyDecisionDecorations(vscode, ui.queue);
    refreshTrees();
    await pushSidebar();
    pushDiffFile();
  };

  const onUiMessage = async (msg: Record<string, unknown>, view?: UiWebview): Promise<void> => {
    try {
      switch (msg.type) {
        case "decision": {
          if (typeof msg.id === "string" && typeof msg.action === "string") {
            await decide(msg.id, msg.action, typeof msg.reason === "string" ? msg.reason : undefined, typeof msg.constraint === "string" ? msg.constraint : undefined);
          }
          break;
        }
        case "note": {
          if (!ui) break;
          const op = msg.op;
          if (op === "add" && typeof msg.file === "string" && typeof msg.text === "string") {
            const line = typeof msg.line === "number" ? msg.line : null;
            const r = addNote(ui.notes, msg.file, line, "You", msg.text, typeof msg.findingId === "string" ? msg.findingId : undefined);
            if (r) {
              ui.notes = r.map;
              saveNotes(ui.rev, ui.notes);
              await pushSidebar();
              pushDiffFile();
            }
          } else if (op === "resolve" && typeof msg.id === "string") {
            ui.notes = toggleNoteResolved(ui.notes, msg.id);
            saveNotes(ui.rev, ui.notes);
            pushDiffFile();
          } else if (op === "delete" && typeof msg.id === "string") {
            ui.notes = deleteNote(ui.notes, msg.id);
            saveNotes(ui.rev, ui.notes);
            pushDiffFile();
          }
          break;
        }
        case "openFile": {
          if (typeof msg.path === "string") {
            const line = typeof msg.line === "number" ? msg.line : (typeof msg.line === "string" && msg.line !== "" ? Number(msg.line) : null);
            const r = await openFile(msg.path, Number.isFinite(line) ? line : null);
            if (!r.ok) vscode.window.showErrorMessage?.(r.detail);
          }
          break;
        }
        case "expandFile": {
          if (ui && typeof msg.path === "string") {
            ui.expandedFile = msg.path;
            pushDiffFile();
          }
          break;
        }
        case "view": {
          if (ui && (msg.view === "split" || msg.view === "unified")) {
            ui.view = msg.view;
            pushDiffFile();
          }
          break;
        }
        case "gotoDecision":
        case "openDecisions":
        case "openDiff": {
          await openDiffReview();
          break;
        }
        case "openTests": {
          await openTestsPanel();
          break;
        }
        case "openEvidence": {
          if (ui) {
            const q = typeof msg.id === "string" ? ui.queue.filter((d) => d.id === msg.id) : ui.queue;
            showEvidence(vscode, q.length ? q : ui.queue);
          }
          break;
        }
        case "openHistory": {
          if (typeof msg.id === "string") {
            const d = reviewDiffs.get(msg.id);
            if (d !== undefined) await openDiffReview(d);
            else await openHistoryPanel();
          } else await openHistoryPanel();
          break;
        }
        case "openChat": {
          await openChatPanel(typeof msg.id === "string" ? msg.id : undefined);
          break;
        }
        case "newChat": {
          const conv = createConversation("New conversation");
          await chatStore.create(conv);
          await syncChatList();
          await pushSidebar();
          break;
        }
        case "newReview": {
          await openNewReviewPanel();
          break;
        }
        case "rerun": {
          if (ui) await runUiAnalysis(ui.diff, await headRev(), { verify: true, staticOnly: false });
          await pushSidebar();
          break;
        }
        case "runAnalysis": {
          const source = typeof msg.source === "string" ? msg.source : "working";
          const o = (msg.options ?? {}) as Record<string, boolean>;
          let diff = "";
          if (source === "staged") diff = (await gitRun(["diff", "--staged", "--"])).stdout;
          else if (source === "range") {
            const base = typeof msg.base === "string" && /^[\w./-]+$/.test(msg.base) ? msg.base : "main";
            const head = typeof msg.head === "string" && /^[\w./-]+$/.test(msg.head) ? msg.head : "HEAD";
            diff = (await gitRun(["diff", `${base}...${head}`, "--"])).stdout;
          } else if (source === "file" && typeof msg.file === "string" && msg.file.trim()) {
            const rel = msg.file.trim().replace(/\\/g, "/");
            const content = readRepoSync(rel);
            diff = content === null ? "" : manualDiffForFiles([{ path: rel, content }]);
          } else diff = (await gitRun(["diff", "HEAD", "--"])).stdout;
          if (!diff.trim()) {
            ui = null;
            vscode.window.showInformationMessage?.("Deci: no changes found for that source.");
            break;
          }
          const refIo = {
            exists: (p: string) => existsSync(join(workspaceRoot, p)),
            read: (p: string) => readFileSync(join(workspaceRoot, p), "utf8"),
          };
          const ticket = resolveRefInput(typeof msg.ticket === "string" ? msg.ticket : null, refIo);
          const designDoc = resolveRefInput(typeof msg.doc === "string" ? msg.doc : null, refIo);
          await runUiAnalysis(diff, await headRev(), {
            verify: o.verify === true, staticOnly: o.staticOnly === true,
            genTests: o.genTests === true, runTests: o.runTests === true, aiExplain: o.aiExplain === true,
            ticket, designDoc,
          });
          await openDiffReview();
          break;
        }
        case "selectProvider":
        case "saveSettings":
        case "resetSettings":
        case "fallbackMove":
        case "fallbackRemove":
        case "fallbackAdd": {
          const cfg = vscode.workspace.getConfiguration("deci");
          if (msg.type === "selectProvider" && typeof msg.provider === "string") {
            await cfg.update?.("provider", msg.provider);
          } else if (msg.type === "saveSettings") {
            const s = (msg.settings ?? {}) as { routes?: Record<string, string>; defs?: Record<string, unknown>; priv?: Record<string, boolean>; providers?: Record<string, { baseURL?: string; model?: string }> };
            if (s.routes) await cfg.update?.("routing", s.routes);
            if (s.providers) await cfg.update?.("providers", s.providers);
            if (typeof s.priv?.allowCloudAi === "boolean") await cfg.update?.("allowCloudAi", s.priv.allowCloudAi);
            if (typeof s.priv?.allowCloudFallback === "boolean") await cfg.update?.("allowCloudFallback", s.priv.allowCloudFallback);
            if (typeof s.defs?.verify === "boolean") await cfg.update?.("verify", s.defs.verify);
            if (typeof s.defs?.staticOnly === "boolean") await cfg.update?.("staticOnly", s.defs.staticOnly);
            if (typeof s.defs?.testTimeoutMs === "number" && Number.isFinite(s.defs.testTimeoutMs)) {
              await cfg.update?.("testTimeoutMs", s.defs.testTimeoutMs);
            }
          } else if (msg.type === "resetSettings") {
            for (const k of ["provider", "routing", "fallback", "allowCloudAi", "allowCloudFallback", "verify", "staticOnly", "testTimeoutMs", "providers"]) {
              await cfg.update?.(k, undefined);
            }
          } else {
            const fb = [...(cfg.get<string[]>("fallback") ?? [])];
            if (msg.type === "fallbackMove" && typeof msg.from === "number" && typeof msg.to === "number") {
              const [x] = fb.splice(msg.from, 1);
              if (x !== undefined) fb.splice(Math.max(0, msg.to), 0, x);
            } else if (msg.type === "fallbackRemove" && typeof msg.index === "number") {
              fb.splice(msg.index, 1);
            } else if (msg.type === "fallbackAdd" && typeof msg.provider === "string" && !fb.includes(msg.provider)) {
              fb.push(msg.provider);
            }
            await cfg.update?.("fallback", fb);
          }
          await pushSettings();
          await pushSidebar();
          break;
        }
        case "testConnection": {
          if (typeof msg.provider === "string" && view?.postMessage) {
            const target = view;
            try {
              const cfg = vscode.workspace.getConfiguration("deci");
              const saved = cfg.get<Record<string, { baseURL?: string; model?: string }>>("providers") ?? {};
              const s = saved[msg.provider] ?? {};
              let key: string | undefined;
              try {
                key = await vscode.secrets?.get(`deci.key.${msg.provider}`);
              } catch {
                key = undefined;
              }
              const p = resolveProvider(
                { provider: msg.provider, baseURL: s.baseURL || undefined, model: s.model || undefined, apiKey: key ?? undefined },
                process.env as Record<string, string | undefined>,
              );
              const res = await checkProvider(p, { live: true });
              target.postMessage?.({ type: "connResult", provider: msg.provider, ok: res.ok, detail: res.detail });
            } catch (err) {
              target.postMessage?.({ type: "connResult", provider: msg.provider, ok: false, detail: err instanceof Error ? err.message : String(err) });
            }
          }
          break;
        }
        case "keyReplace": {
          if (typeof msg.provider === "string") {
            const v = await vscode.window.showInputBox?.({ prompt: `API key for ${msg.provider} (SecretStorage, never displayed)` } as unknown as undefined);
            if (typeof v === "string" && v.trim() && vscode.secrets) {
              try {
                await vscode.secrets.store(`deci.key.${msg.provider}`, v.trim());
              } catch {
                /* degraded */
              }
              await pushSettings();
            } else if (!vscode.secrets) {
              vscode.window.showErrorMessage?.("Deci: SecretStorage unavailable — set DECI_<PROVIDER>_API_KEY instead.");
            }
          }
          break;
        }
        case "keyClear": {
          if (typeof msg.provider === "string" && vscode.secrets) {
            try {
              await vscode.secrets.delete(`deci.key.${msg.provider}`);
            } catch {
              /* degraded */
            }
            await pushSettings();
          }
          break;
        }
        case "settingsDirty": {
          break;
        }
        case "testsDiscover": {
          if (!ui) break;
          try {
            ui.discovery = discoverTests(repoIoSync, workspaceRoot);
            const changed = [...new Set(ui.queue.map((d) => d.file))];
            ui.selection = selectTests(changed, ui.impact ?? { edges: [], directFiles: [], indirectFiles: [], testFiles: [], scannedFiles: 0, truncated: false, unresolved: [] }, ui.discovery.tests);
          } catch (err) {
            ui.error = err instanceof Error ? err.message : String(err);
          }
          pushTests();
          await pushSidebar();
          break;
        }
        case "testsGenerate": {
          if (!ui) break;
          try {
            const symbols = symbolsForHunks(parseFileHunks(ui.diff));
            const fw = (ui.discovery?.frameworks.find((f) => f === "node:test" || f === "jest" || f === "vitest") ?? "node:test") as "node:test" | "jest" | "vitest";
            ui.generated = generateTests(symbols, { readFile: (p) => readRepoSync(p) }, fw);
          } catch (err) {
            ui.error = err instanceof Error ? err.message : String(err);
          }
          pushTests();
          break;
        }
        case "testsWrite": {
          if (!ui) break;
          try {
            const res = writeGeneratedTests(ui.generated, {
              exists: (p) => existsSync(join(workspaceRoot, p)),
              write: (p, c) => writeFileSync(join(workspaceRoot, p), c, "utf8"),
            });
            ui.error = res.skipped.length ? `Skipped existing: ${res.skipped.map((s) => s.path).join(", ")}` : null;
          } catch (err) {
            ui.error = err instanceof Error ? err.message : String(err);
          }
          pushTests();
          break;
        }
        case "testsRun": {
          if (!ui) break;
          try {
            const paths = Array.isArray(msg.paths) ? msg.paths.filter((p): p is string => typeof p === "string") : null;
            const pool = ui.selection?.selected ?? [];
            const runnable = (paths ? pool.filter((t) => paths.includes(t.path)) : pool).filter((t) => t.command.length > 0);
            const timeout = vscode.workspace.getConfiguration("deci").get<number>("testTimeoutMs") ?? 120000;
            const out = await runSelectedTests(runnable, { cwd: workspaceRoot, timeoutMs: timeout, revision: ui.rev });
            ui.results = out.map((r) => ({ path: r.path, status: r.status, detail: r.detail, output: r.output }));
          } catch (err) {
            ui.error = err instanceof Error ? err.message : String(err);
          }
          pushTests();
          break;
        }
        case "testsDiagnose": {
          if (!ui) break;
          try {
            const failed = ui.results.find((r) => r.status === "failed" || r.status === "error");
            if (!failed) {
              ui.diagnosis = "No failed test results to diagnose — run the tests first.";
            } else {
              const diag = diagnoseFailure(
                { path: failed.path, command: [], status: "failed", exitCode: 1, output: failed.output, durationMs: 0, revision: ui.rev, detail: failed.detail },
                { changedFiles: [...new Set(ui.queue.map((d) => d.file))], readFile: (p) => readRepoSync(p) },
              );
              ui.diagnosis = `${diag.summary} ${diag.causes.map((c) => `[${c.standing}] ${c.statement}`).join(" ")}`.slice(0, 2000);
              try {
                const proposal = await proposeFixStructured(failed.path, toolContext);
                ui.fixDiff = proposal.patch ? proposal.patch.diff : null;
                ui.fixPatch = proposal.patch;
                ui.fixGuards = proposal.guardLines;
              } catch {
                ui.fixDiff = null;
                ui.fixPatch = null;
              }
            }
          } catch (err) {
            ui.error = err instanceof Error ? err.message : String(err);
          }
          pushTests();
          break;
        }
        case "fixApply": {
          if (!ui?.fixPatch || msg.confirmed !== true) break;
          try {
            const detail = await applyFixAfterApproval(ui.fixPatch, ui.fixGuards, toolContext);
            ui.diagnosis = `${ui.diagnosis ?? ""}\nApplied: ${detail}`.slice(0, 2000);
            ui.fixDiff = null;
            ui.fixPatch = null;
          } catch (err) {
            ui.error = err instanceof Error ? err.message : String(err);
          }
          pushTests();
          break;
        }
        case "fixDiscard": {
          if (!ui) break;
          ui.fixDiff = null;
          ui.fixPatch = null;
          ui.diagnosis = null;
          pushTests();
          break;
        }
        case "chooseAlternative": {
          if (ui?.alternatives && typeof msg.optionId === "string") {
            try {
              const picked = pickAlternative(ui.alternatives, msg.optionId);
              ui.alternatives = picked;
              previewImplementation(vscode, picked);
              await pushSidebar();
            } catch {
              /* unknown option */
            }
          }
          break;
        }
        case "compareSelect": {
          ensureCompareSession();
          if (ui && typeof msg.id === "string") {
            ui.compareSel = ui.compareSel.includes(msg.id) ? ui.compareSel.filter((x) => x !== msg.id) : [...ui.compareSel.slice(-1), msg.id];
          }
          pushHistory();
          break;
        }
        case "exportHistory": {
          try {
            const name = `.deci/exports/history-${Date.now()}.json`;
            writeFileSync(join(workspaceRoot, name), JSON.stringify(entries, null, 2), "utf8");
            vscode.window.showInformationMessage?.(`Deci: history exported to ${name}`);
          } catch (err) {
            vscode.window.showErrorMessage?.(`Deci: export failed — ${err instanceof Error ? err.message : String(err)}`);
          }
          break;
        }
        case "exportPlan": {
          try {
            const body = `# Test plan\n\n${(ui?.testPlan?.toAdd ?? []).map((s) => `- ${s}`).join("\n")}\n\n# Rollback plan\n\n${(ui?.rollbackPlan?.steps ?? []).map((s, i) => `${i + 1}. ${s}`).join("\n")}\n`;
            const name = `.deci/exports/plan-${Date.now()}.md`;
            writeFileSync(join(workspaceRoot, name), body, "utf8");
            vscode.window.showInformationMessage?.(`Deci: plan exported to ${name}`);
          } catch (err) {
            vscode.window.showErrorMessage?.(`Deci: export failed — ${err instanceof Error ? err.message : String(err)}`);
          }
          break;
        }
      }
    } catch (err) {
      vscode.window.showErrorMessage?.(`Deci: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const ensureCompareSession = (): void => {
    if (ui) return;
    ui = {
      rev: "", diff: "", map: buildReviewMap(""), queue: [], evidence: [], impact: null,
      discovery: null, selection: null, verify: null, generated: [], results: [],
      diagnosis: null, fixDiff: null, fixPatch: null, fixGuards: [], testPlan: null,
      rollbackPlan: null, aiCard: null, alternatives: null, notes: {}, decided: {},
      expandedFile: null, view: "unified", compareSel: [], error: null,
    };
  };

  let settingsView: UiWebview | null = null;
  const pushSettings = async (): Promise<void> => {
    if (!settingsView) return;
    const cfg = vscode.workspace.getConfiguration("deci");
    const get = <T,>(key: string): T | undefined => {
      try {
        return cfg.get<T>(key);
      } catch {
        return undefined;
      }
    };
    const env = process.env;
    const savedProviders = get<Record<string, { baseURL?: string; model?: string }>>("providers") ?? {};
    const providers: SettingsVM["providers"] = [];
    for (const spec of PROVIDER_SPECS) {
      const upper = spec.id.toUpperCase().replace(/-/g, "_");
      const saved = savedProviders[spec.id] ?? {};
      let keySet = false;
      try {
        keySet = (await vscode.secrets?.get(`deci.key.${spec.id}`)) ? true : false;
      } catch {
        keySet = false;
      }
      if (!keySet && spec.needsKey) keySet = Boolean(env[`DECI_${upper}_API_KEY`] ?? env.DECI_API_KEY);
      const envOverridden: string[] = [];
      if (env.DECI_PROVIDER === spec.id) envOverridden.push("DECI_PROVIDER");
      if (env[`DECI_${upper}_BASE_URL`]) envOverridden.push(`DECI_${upper}_BASE_URL`);
      if (env[`DECI_${upper}_MODEL`]) envOverridden.push(`DECI_${upper}_MODEL`);
      if (env[`DECI_${upper}_API_KEY`]) envOverridden.push(`DECI_${upper}_API_KEY`);
      providers.push({ spec, baseURL: saved.baseURL ?? spec.defaultBaseURL ?? "", model: saved.model ?? "", keySet, envOverridden });
    }
    const vm: SettingsVM = {
      providers,
      activeProvider: get<string>("provider") ?? env.DECI_PROVIDER ?? "ollama",
      routing: get<Record<string, string>>("routing") ?? {},
      fallback: get<string[]>("fallback") ?? [],
      allowCloudAi: get<boolean>("allowCloudAi") ?? env.DECI_ALLOW_CLOUD_AI === "1",
      allowCloudFallback: get<boolean>("allowCloudFallback") ?? env.DECI_ALLOW_CLOUD_FALLBACK === "1",
      verify: get<boolean>("verify") ?? true,
      staticOnly: get<boolean>("staticOnly") ?? false,
      testTimeoutMs: get<number>("testTimeoutMs") ?? 120000,
      dirty: false,
    };
    const nonce = makeNonce();
    settingsView.html = doc({
      title: "Deci Settings", css: DECI_CSS, body: buildSettingsHtml(vm), nonce,
      clientJs: `${BASE_CLIENT_JS}\n${SETTINGS_CLIENT_JS}`,
    });
  };

  vscode.commands.registerCommand("deci.newReview", () => openNewReviewPanel());
  vscode.commands.registerCommand("deci.openDiffReview", (diffText: unknown) => openDiffReview(typeof diffText === "string" ? diffText : undefined));
  vscode.commands.registerCommand("deci.openSettings", () => openSettingsPanel());
  vscode.commands.registerCommand("deci.openTests", () => openTestsPanel());
  vscode.commands.registerCommand("deci.openHistory", () => openHistoryPanel());
  vscode.commands.registerCommand("deci.compareRuns", () => openHistoryPanel());
  vscode.commands.registerCommand("deci.showAlternatives", (decisionId: unknown) => {
    if (!ui) {
      vscode.window.showInformationMessage?.("Deci: run an analysis first.");
      return;
    }
    const d = ui.queue.find((x) => x.id === decisionId) ?? ui.queue.find((x) => x.status === "rejected") ?? ui.queue[0];
    if (!d) {
      vscode.window.showInformationMessage?.("Deci: no decisions to explore alternatives for.");
      return;
    }
    const set = showAlternatives(vscode, d);
    ui.alternatives = set;
    void pushSidebar();
  });
  vscode.commands.registerCommand("deci.showEvidence", (decisionId: unknown) => {
    if (!ui) {
      vscode.window.showInformationMessage?.("Deci: run an analysis first.");
      return;
    }
    const q = typeof decisionId === "string" ? ui.queue.filter((x) => x.id === decisionId) : ui.queue;
    showEvidence(vscode, q.length ? q : ui.queue);
  });

  // Single Deci sidebar (WebviewView). Tree providers stay registered as a
  // degraded fallback; the webview is the primary surface.
  try {
    vscode.window.registerWebviewViewProvider?.("deci.sidebar", {
      resolveWebviewView: (view: {
        webview: UiWebview & { options?: unknown };
        onDidDispose?: (cb: () => void) => void;
      }) => {
        view.webview.options = { enableScripts: true };
        sideView = view.webview;
        void (async () => {
          try {
            const b = await gitRun(["rev-parse", "--abbrev-ref", "HEAD"]);
            if (b.stdout.trim()) branchLabel = b.stdout.trim();
          } catch {
            /* keep cached */
          }
          if (sideView) {
            const nonce = makeNonce();
            sideView.html = doc({
              title: "Deci", css: DECI_CSS, body: buildSidebarHtml(await sidebarVm()),
              state: {}, nonce, clientJs: `${BASE_CLIENT_JS}\n${SIDEBAR_CLIENT_JS}`,
            });
          }
        })();
        view.webview.onDidReceiveMessage?.((raw) => {
          void onUiMessage((raw ?? {}) as Record<string, unknown>);
        });
        view.onDidDispose?.(() => {
          if (sideView === view.webview) sideView = null;
        });
      },
    });
  } catch {
    /* host without WebviewView support keeps trees */
  }

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
