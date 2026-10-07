// VS Code host: Review Map webview (US-001) + ranked decision queue with
// gutter icons + hover cards + Accept/Reject/Investigate commands (US-004).
// Core stays pure in decisions.ts; this file is the thin editor adapter.
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

type Vscode = {
  window: {
    createWebviewPanel(viewType: string, title: string, column: number, options: unknown): {
      webview: { html: string };
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
  const io = { exists: () => false, read: () => "" };
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
    if (opts.manualFiles) return { spec: { kind: "file", path: opts.manualFiles.map((f) => f.path).join(", ") || "manual pick" }, ticket: null, doc: null, manualDiff: buildManualDiff(opts.manualFiles) };
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
  const body = `${renderMarkdown(map)}\n${renderDecisionsMarkdown(decisionsForDiff(diffText))}\n${renderVerifyMarkdown(report)}`;
  const panel = vscode.window.createWebviewPanel("deci.review", "Review Map", 1, {});
  panel.webview.html = `<html><body><pre>${escapeHtml(body)}</pre></body></html>`;
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
  return queue;
}

const SEVERITIES: Severity[] = ["Critical", "High", "Medium", "Low"];

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
  vscode.workspace.registerHoverProvider?.("*", {
    provideHover(document: { uri: { fsPath: string } }) {
      const hit = queue.find((d) => document.uri.fsPath.endsWith(d.file));
      return hit ? { contents: [hoverMarkdownFor(hit)] } : null;
    },
  });
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
  vscode.commands.registerCommand("deci.showDecisions", (diffText: unknown) =>
    showDecisions(vscode, typeof diffText === "string" ? diffText : ""),
  );
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
 * US-012: Activity Bar wiring — registers the five sidebar views
 * (Review | Decisions | Alternatives | Evidence | History) plus the full
 * command set: Review Map, Decisions, Alternative Studio A/B/C,
 * implementation plan preview, Generate patch, Verify output, Evidence,
 * output bundle, provider status, History. All local-first, no backend.
 */
export function activate(vscode: Vscode): {
  providers: Record<PanelViewId, ReturnType<typeof createListProvider>>;
  history: { list(): HistoryEntry[]; note(label: string, diffText: string, queue: DecisionPoint[]): void };
} {
  const providers = {
    "deci.review": createListProvider(buildReviewNodes(buildReviewMap(""))),
    "deci.decisions": createListProvider(buildDecisionNodes([])),
    "deci.alternatives": createListProvider(buildAlternativeNodes(null)),
    "deci.evidence": createListProvider(buildEvidenceNodes([])),
    "deci.history": createListProvider(buildHistoryNodes([])),
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
  vscode.commands.registerCommand("deci.showReviewMap", (diffText: unknown) => {
    const diff = typeof diffText === "string" ? diffText : "";
    const q = decisionsForDiff(diff);
    providers["deci.review"].set(buildReviewNodes(buildReviewMap(diff)));
    providers["deci.decisions"].set(buildDecisionNodes(q));
    entries = noteReview(entries, `review ${entries.length + 1}`, diff, q);
    syncHistory();
    return showReviewMap(vscode, diff);
  });
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
  return {
    providers,
    history: {
      list: () => entries,
      note: (label: string, diffText: string, q: DecisionPoint[]) => {
        entries = noteReview(entries, label, diffText, q);
        syncHistory();
      },
    },
  };
}
