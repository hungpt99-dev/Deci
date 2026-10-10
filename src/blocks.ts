// Structured response blocks: the protocol between AI text and interactive UI.
// The provider returns plain text; fenced ```deci-block JSON``` sections are
// parsed, validated, and rendered as interactive components. Anything invalid
// degrades to readable text — never arbitrary HTML/JS execution. All builders
// below take REAL domain objects (ImpactMap, TestResult, Diagnosis, ...), so a
// visualization can only show measured data, never fabricated content.
import type { ImpactMap } from "./impact.js";
import type { RiskFinding } from "./risks.js";
import type { TestResult } from "./run.js";
import type { Diagnosis } from "./diagnose.js";
import type { ApiContractSymbol } from "./chat.js";

export const BLOCK_LIMITS = {
  maxBlocksPerMessage: 6,
  maxNodes: 120,
  maxEdges: 200,
  maxChartPoints: 60,
  maxTableRows: 50,
  maxDiffChars: 12000,
  maxTextChars: 20000,
} as const;

export type BlockType =
  | "text" | "graph" | "chart" | "code_diff"
  | "test_results" | "findings" | "api_request" | "action";

export interface TextBlock { type: "text"; markdown: string }
export type GraphNodeKind = "changed" | "direct" | "indirect" | "test" | "module";
export interface GraphNode {
  id: string; label: string; kind: GraphNodeKind;
  file?: string; line?: number | null; detail?: string;
}
export interface GraphEdge { from: string; to: string; label: string; evidence: string }
export interface GraphBlock {
  type: "graph"; title: string; nodes: GraphNode[]; edges: GraphEdge[];
  /** Disclosed gaps, e.g. unresolved references. Empty = complete in scope. */
  unresolved: string[];
}
export interface ChartSeries { name: string; points: Array<{ label: string; value: number }> }
export interface ChartBlock { type: "chart"; title: string; chart: "bar"; series: ChartSeries[] }
export interface CodeDiffBlock {
  type: "code_diff"; title: string; file: string;
  original: string; proposed: string; description: string;
  /** Tool + args to produce/apply this patch through the approval gate. */
  action?: { name: string; args: Record<string, unknown> };
}
export interface TestResultsBlock {
  type: "test_results"; title: string;
  results: Array<{ path: string; status: string; exitCode: number | null; durationMs: number; detail: string; output?: string }>;
  diagnosis?: { testPath: string; summary: string; causes: string[]; frames: Array<{ path: string; line: number | null }> } | null;
}
export interface FindingsBlock {
  type: "findings"; title: string;
  rows: Array<{ severity: string; file: string; line: number | null; finding: string; standing: string }>;
}
export interface ApiRequestBlock {
  type: "api_request"; title: string; name: string;
  file: string; line: number | null; signature: string;
  method: string; path: string;
}
export type ActionName = "run_tests" | "propose_fix" | "apply_fix" | "explain" | "open_file" | "ask";
export interface ActionBlock {
  type: "action"; title: string; action: ActionName;
  params: Record<string, unknown>; requiresApproval: boolean; label: string;
}
export type ResponseBlock =
  | TextBlock | GraphBlock | ChartBlock | CodeDiffBlock
  | TestResultsBlock | FindingsBlock | ApiRequestBlock | ActionBlock;

/** Actions the frontend may request. Backend re-validates before executing. */
export const ACTION_REGISTRY: Record<ActionName, { requiresApproval: boolean; description: string }> = {
  run_tests: { requiresApproval: false, description: "Run project tests via the real test service (time-boxed, shell-free)." },
  propose_fix: { requiresApproval: false, description: "Generate a reviewable patch proposal (never writes)." },
  apply_fix: { requiresApproval: true, description: "Apply an approved patch to workspace files." },
  explain: { requiresApproval: false, description: "Ask the configured provider about the selected item." },
  open_file: { requiresApproval: false, description: "Navigate to a workspace file and line." },
  ask: { requiresApproval: false, description: "Send a follow-up question with the selection as context." },
};

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function str(v: unknown, max: number): string | null {
  return typeof v === "string" ? v.slice(0, max) : null;
}
function numOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** Validate one raw value as a ResponseBlock. Returns errors (empty = valid). Mutates nothing. */
export function validateBlock(raw: unknown): string[] {
  if (!isObj(raw)) return ["block must be an object"];
  const type = raw.type;
  switch (type) {
    case "text": {
      const md = str(raw.markdown, BLOCK_LIMITS.maxTextChars + 1);
      if (md === null) return ["text.markdown must be a string"];
      if ((raw.markdown as string).length > BLOCK_LIMITS.maxTextChars) return ["text.markdown exceeds cap"];
      return [];
    }
    case "graph": return validateGraph(raw);
    case "chart": return validateChart(raw);
    case "code_diff": {
      const errs: string[] = [];
      if (str(raw.title, 200) === null) errs.push("code_diff.title must be a string");
      if (str(raw.file, 500) === null) errs.push("code_diff.file must be a string");
      for (const k of ["original", "proposed"] as const) {
        const v = raw[k];
        if (typeof v !== "string") errs.push(`code_diff.${k} must be a string`);
        else if (v.length > BLOCK_LIMITS.maxDiffChars) errs.push(`code_diff.${k} exceeds cap`);
      }
      if (str(raw.description, 2000) === null) errs.push("code_diff.description must be a string");
      if (raw.action !== undefined) {
        if (!isObj(raw.action) || typeof raw.action.name !== "string" || !isObj(raw.action.args))
          errs.push("code_diff.action must be {name, args}");
        else if (!(raw.action.name in ACTION_REGISTRY)) errs.push(`code_diff.action unknown: ${raw.action.name}`);
      }
      return errs;
    }
    case "test_results": {
      if (!Array.isArray(raw.results)) return ["test_results.results must be an array"];
      if (raw.results.length > BLOCK_LIMITS.maxTableRows) return ["test_results.results exceeds cap"];
      for (const r of raw.results) {
        if (!isObj(r) || typeof r.path !== "string" || typeof r.status !== "string") return ["test_results row must have path + status strings"];
      }
      return [];
    }
    case "findings": {
      if (!Array.isArray(raw.rows)) return ["findings.rows must be an array"];
      if (raw.rows.length > BLOCK_LIMITS.maxTableRows) return ["findings.rows exceeds cap"];
      return [];
    }
    case "api_request": {
      const errs: string[] = [];
      for (const k of ["title", "name", "file", "signature", "method", "path"] as const) {
        if (str(raw[k], 1000) === null) errs.push(`api_request.${k} must be a string`);
      }
      return errs;
    }
    case "action": {
      if (typeof raw.action !== "string" || !(raw.action in ACTION_REGISTRY)) return [`unknown action: ${String(raw.action)}`];
      if (!isObj(raw.params)) return ["action.params must be an object"];
      if (str(raw.label, 200) === null) return ["action.label must be a string"];
      return [];
    }
    default: return [`unsupported block type: ${String(type)}`];
  }
}

function validateGraph(raw: Record<string, unknown>): string[] {
  const errs: string[] = [];
  if (str(raw.title, 200) === null) errs.push("graph.title must be a string");
  if (!Array.isArray(raw.nodes)) return [...errs, "graph.nodes must be an array"];
  if (!Array.isArray(raw.edges)) return [...errs, "graph.edges must be an array"];
  if (raw.nodes.length > BLOCK_LIMITS.maxNodes) errs.push("graph.nodes exceeds cap");
  if (raw.edges.length > BLOCK_LIMITS.maxEdges) errs.push("graph.edges exceeds cap");
  const ids = new Set<string>();
  const kinds = new Set(["changed", "direct", "indirect", "test", "module"]);
  for (const n of raw.nodes) {
    if (!isObj(n) || typeof n.id !== "string" || typeof n.label !== "string") { errs.push("graph node must have id + label strings"); break; }
    if (!kinds.has(n.kind as string)) { errs.push(`graph node kind invalid: ${String(n.kind)}`); break; }
    ids.add(n.id);
  }
  for (const e of raw.edges) {
    if (!isObj(e) || typeof e.from !== "string" || typeof e.to !== "string") { errs.push("graph edge must have from/to strings"); break; }
    if (!ids.has(e.from) || !ids.has(e.to)) { errs.push(`graph edge references unknown node: ${e.from} → ${e.to}`); break; }
  }
  if (raw.unresolved !== undefined && !Array.isArray(raw.unresolved)) errs.push("graph.unresolved must be an array");
  return errs;
}

function validateChart(raw: Record<string, unknown>): string[] {
  if (raw.chart !== "bar") return ["chart.chart must be \"bar\""];
  if (str(raw.title, 200) === null) return ["chart.title must be a string"];
  if (!Array.isArray(raw.series)) return ["chart.series must be an array"];
  let points = 0;
  for (const s of raw.series) {
    if (!isObj(s) || typeof s.name !== "string" || !Array.isArray(s.points)) return ["chart series must have name + points"];
    for (const p of s.points) {
      if (!isObj(p) || typeof p.label !== "string" || typeof p.value !== "number") return ["chart point must have label + numeric value"];
      points++;
    }
  }
  if (points > BLOCK_LIMITS.maxChartPoints) return ["chart.points exceeds cap"];
  return [];
}

export interface ParsedResponse { blocks: ResponseBlock[]; warnings: string[] }

/** Extract ```deci-block fenced JSON from assistant text. Invalid blocks fall
 *  back to text with a warning. Always returns at least the text remainder. */
export function parseResponseBlocks(text: string): ParsedResponse {
  const blocks: ResponseBlock[] = [];
  const warnings: string[] = [];
  const fence = /```deci-block\s*\n([\s\S]*?)```/g;
  let match: RegExpExecArray | null;
  let lastIdx = 0;
  const textParts: string[] = [];
  const pushText = (s: string): void => {
    if (s.trim()) textParts.push(s.trim());
  };
  while ((match = fence.exec(text)) !== null && blocks.length < BLOCK_LIMITS.maxBlocksPerMessage) {
    pushText(text.slice(lastIdx, match.index));
    lastIdx = match.index + match[0].length;
    const rawText = (match[1] ?? "").trim();
    try {
      const raw: unknown = JSON.parse(rawText);
      const candidates = Array.isArray(raw) ? raw : [raw];
      for (const cand of candidates) {
        if (blocks.length >= BLOCK_LIMITS.maxBlocksPerMessage) {
          warnings.push("Block cap reached — remaining blocks shown as text.");
          pushText(JSON.stringify(cand).slice(0, 1000));
          continue;
        }
        const errs = validateBlock(cand);
        if (errs.length > 0) {
          warnings.push(`Invalid block ignored (${errs[0]}). Shown as text instead.`);
          pushText(typeof cand === "object" ? JSON.stringify(cand).slice(0, 1000) : String(cand));
        } else {
          blocks.push(cand as ResponseBlock);
        }
      }
    } catch {
      warnings.push("Malformed deci-block JSON ignored. Shown as text instead.");
      pushText(rawText.slice(0, 1000));
    }
  }
  pushText(text.slice(lastIdx));
  const merged = textParts.join("\n\n").slice(0, BLOCK_LIMITS.maxTextChars);
  return { blocks: merged ? [{ type: "text", markdown: merged }, ...blocks] : blocks, warnings };
}

// --- Builders from real domain data (no invented relationships) ---

/** Impact map → interactive graph. Only observed edges; gaps disclosed. */
export function impactToGraph(map: ImpactMap, changedFiles: string[]): GraphBlock {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const seen = new Set<string>();
  const addNode = (n: GraphNode): void => {
    if (seen.has(n.id) || nodes.length >= BLOCK_LIMITS.maxNodes) return;
    seen.add(n.id);
    nodes.push(n);
  };
  for (const f of changedFiles.slice(0, 20)) {
    addNode({ id: `changed:${f}`, label: f.split("/").pop() ?? f, kind: "changed", file: f, detail: "Changed in this diff" });
  }
  for (const f of map.directFiles.slice(0, 40)) {
    addNode({ id: `file:${f}`, label: f.split("/").pop() ?? f, kind: /\.test\.|\.spec\./.test(f) ? "test" : "direct", file: f });
  }
  for (const f of map.indirectFiles.slice(0, 30)) {
    addNode({ id: `file:${f}`, label: f.split("/").pop() ?? f, kind: "indirect", file: f });
  }
  for (const f of map.testFiles.slice(0, 30)) {
    const id = `file:${f}`;
    if (!seen.has(id)) addNode({ id, label: f.split("/").pop() ?? f, kind: "test", file: f, detail: "Guards this change" });
  }
  for (const e of map.edges.slice(0, BLOCK_LIMITS.maxEdges)) {
    const fromId = changedFiles.includes(e.fromFile) ? `changed:${e.fromFile}` : `file:${e.fromFile}`;
    const toId = `file:${e.toFile}`;
    if (!seen.has(fromId)) addNode({ id: fromId, label: e.fromFile.split("/").pop() ?? e.fromFile, kind: "direct", file: e.fromFile });
    if (!seen.has(toId)) continue;
    edges.push({ from: fromId, to: toId, label: e.symbol, evidence: e.evidence });
  }
  return {
    type: "graph",
    title: `Impact: ${changedFiles.length} changed → ${map.directFiles.length} direct, ${map.indirectFiles.length} indirect, ${map.testFiles.length} test files`,
    nodes, edges,
    unresolved: map.unresolved.slice(0, 5),
  };
}

/** Risk findings → severity bar chart + filterable table data. */
export function risksToChart(findings: RiskFinding[]): ChartBlock {
  const counts = new Map<string, number>();
  for (const f of findings) counts.set(f.severity, (counts.get(f.severity) ?? 0) + 1);
  return {
    type: "chart", title: `Risk distribution (${findings.length} findings)`, chart: "bar",
    series: [{ name: "findings", points: [...counts.entries()].map(([label, value]) => ({ label, value })) }],
  };
}

export function findingsToBlock(findings: RiskFinding[]): FindingsBlock {
  return {
    type: "findings", title: `Risk findings (${findings.length})`,
    rows: findings.slice(0, BLOCK_LIMITS.maxTableRows).map((f) => ({
      severity: f.severity, file: f.file, line: f.line ?? null,
      finding: `${f.title}: ${f.consequence}`.slice(0, 300), standing: f.standing,
    })),
  };
}

/** Real execution records → dashboard block, with optional real diagnosis. */
export function resultsToBlock(results: TestResult[], diagnosis?: Diagnosis | null): TestResultsBlock {
  return {
    type: "test_results",
    title: `Tests: ${results.filter((r) => r.status === "passed").length} passed, ${results.filter((r) => r.status === "failed").length} failed (${results.length} ran)`,
    results: results.slice(0, BLOCK_LIMITS.maxTableRows).map((r) => ({
      path: r.path, status: r.status, exitCode: r.exitCode, durationMs: r.durationMs,
      detail: r.detail.slice(0, 300), output: r.output ? r.output.slice(-3000) : undefined,
    })),
    diagnosis: diagnosis ? {
      testPath: diagnosis.testPath, summary: diagnosis.summary.slice(0, 500),
      causes: diagnosis.causes.map((c) => `[${c.standing}] ${c.statement}`.slice(0, 300)),
      frames: diagnosis.frames.slice(0, 5).map((f) => ({ path: f.path, line: f.line })),
    } : null,
  };
}

/** Test durations → bar chart from measured data only. */
export function durationsToChart(results: TestResult[]): ChartBlock {
  return {
    type: "chart", title: `Test durations (measured, ms)`, chart: "bar",
    series: [{
      name: "durationMs",
      points: results.slice(0, BLOCK_LIMITS.maxChartPoints).map((r) => ({
        label: (r.path.split("/").pop() ?? r.path).slice(0, 24), value: Math.round(r.durationMs),
      })),
    }],
  };
}

export function contractToBlock(c: ApiContractSymbol): ApiRequestBlock {
  const sig = c.signature ?? "";
  const m = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(\S+)/i.exec(sig);
  return {
    type: "api_request", title: `API: ${c.name}`, name: c.name,
    file: c.file, line: c.line, signature: sig.slice(0, 500),
    method: (m?.[1] ?? "GET").toUpperCase(), path: m?.[2] ?? sig.slice(0, 120),
  };
}

export function actionBlock(title: string, action: ActionName, params: Record<string, unknown>, label: string): ActionBlock {
  return { type: "action", title, action, params, requiresApproval: ACTION_REGISTRY[action].requiresApproval, label };
}

/** Render blocks as plain-text fallback (CLI, logs). No interactivity claimed. */
export function renderBlocksText(blocks: ResponseBlock[]): string {
  const parts: string[] = [];
  for (const b of blocks) {
    switch (b.type) {
      case "text": parts.push(b.markdown); break;
      case "graph": parts.push(`[Interactive graph: ${b.title} — ${b.nodes.length} nodes, ${b.edges.length} edges. Open in VS Code Chat for the interactive view.]`); break;
      case "chart": parts.push(`[Chart: ${b.title}]` + b.series.map((s) => `\n${s.name}: ` + s.points.map((p) => `${p.label}=${p.value}`).join(", ")).join("")); break;
      case "code_diff": parts.push(`--- ${b.file} (original)\n${b.original}\n+++ ${b.file} (proposed)\n${b.proposed}\n${b.description}`); break;
      case "test_results": parts.push(`[${b.title}]` + b.results.map((r) => `\n- ${r.path}: ${r.status} (exit ${r.exitCode ?? "—"})`).join("")); break;
      case "findings": parts.push(`[${b.title}]` + b.rows.map((r) => `\n- [${r.severity}] ${r.file}: ${r.finding}`).join("")); break;
      case "api_request": parts.push(`[API ${b.method} ${b.path} — ${b.name} (${b.file})]`); break;
      case "action": parts.push(`[Action: ${b.label} — requires approval: ${b.requiresApproval ? "yes" : "no"}]`); break;
    }
  }
  return parts.join("\n\n");
}
