// Tool definitions and execution. Pure core with injected I/O.
// Wraps existing Deci capabilities as chat-callable tools. All file/test
// operations go through the injected ToolExecutionContext — never direct fs.
import {
  validateToolArgs,
  type ToolDefinition,
  type ToolExecutionContext,
  type ToolExecutionResult,
} from "./chat.js";
import { buildReviewMap, parseUnifiedDiff } from "./reviewMap.js";
import { analyzeSemantics, parseFileHunks } from "./semantic.js";
import { buildDecisions, decisionSummary } from "./decisions.js";
import { symbolsForHunks } from "./symbols.js";
import { buildImpactMap } from "./impact.js";
import { discoverTests } from "./discover.js";
import { selectTests } from "./select.js";
import { diagnoseFailure, applyProposedPatch } from "./diagnose.js";
import { runTests } from "./run.js";

/** Tool parameter schema definitions. */
export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: "read_file",
    description: "Read a file from the workspace. Returns file content with optional line range.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path relative to workspace root" },
        startLine: { type: "number", description: "Starting line (1-indexed)" },
        endLine: { type: "number", description: "Ending line (inclusive)" },
      },
      required: ["path"],
    },
  },
  {
    name: "search_code",
    description: "Search code using regex across the workspace. Returns matching lines with file paths and line numbers.",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Regex pattern to search for" },
        maxResults: { type: "number", description: "Maximum results to return" },
      },
      required: ["pattern"],
    },
  },
  {
    name: "analyze_change",
    description: "Analyze the current working-tree diff. Returns review map, decisions, risks, and symbols.",
    parameters: { type: "object", properties: {}, required: [] },
  },
  {
    name: "impact_analysis",
    description: "Trace impact of changed symbols through the codebase. Returns direct/indirect impacted files and test files.",
    parameters: { type: "object", properties: {}, required: [] },
  },
  {
    name: "discover_tests",
    description: "Discover tests in the project. Returns test files with categories, frameworks, and run commands.",
    parameters: { type: "object", properties: {}, required: [] },
  },
  {
    name: "run_tests",
    description: "Run selected tests via the real test runner (time-boxed, shell-free). Returns pass/fail status and output.",
    parameters: {
      type: "object",
      properties: {
        paths: { type: "string", description: "Comma-separated test file paths to run (empty = change-selected)" },
      },
      required: [],
    },
  },
  {
    name: "generate_tests",
    description: "Generate test scaffolds for changed symbols. Returns test code proposals (does not write files).",
    parameters: { type: "object", properties: {}, required: [] },
  },
  {
    name: "diagnose_failure",
    description: "Diagnose a test failure. Returns root cause analysis with stack trace links.",
    parameters: {
      type: "object",
      properties: {
        testPath: { type: "string", description: "Path to the failing test file" },
      },
      required: ["testPath"],
    },
  },
  {
    name: "propose_fix",
    description: "Propose a guard-restoration fix for a test failure. Requires explicit user approval before applying.",
    parameters: {
      type: "object",
      properties: {
        testPath: { type: "string", description: "Path to the failing test file" },
      },
      required: ["testPath"],
    },
    requiresApproval: true,
  },
  {
    name: "api_contracts",
    description: "List API contract symbols (endpoints, types) in the current change.",
    parameters: { type: "object", properties: {}, required: [] },
  },
  {
    name: "search_docs",
    description: "Search project documentation (README, ADRs, design docs).",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query" },
      },
      required: ["query"],
    },
  },
];

/** Names of tools that mutate state and always require approval. */
export function requiresApproval(name: string): boolean {
  return TOOL_DEFINITIONS.find((t) => t.name === name)?.requiresApproval === true;
}

/** Containment: refuse paths escaping the workspace root. */
function containedPath(root: string, p: string): string | null {
  const norm = (s: string): string => s.replace(/\\/g, "/");
  const clean = norm(p).trim();
  if (clean === "" || clean.includes("\0")) return null;
  if (clean.startsWith("/") || /^[A-Za-z]:\//.test(clean)) return null;
  const parts = clean.split("/");
  let depth = 0;
  for (const part of parts) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      depth -= 1;
      if (depth < 0) return null;
    } else depth += 1;
  }
  void root;
  return clean;
}

/** Current diff (working tree, then staged). */
async function currentDiff(ctx: ToolExecutionContext): Promise<string> {
  const wt = await ctx.git(["diff", "HEAD", "--"]);
  if (wt.stdout.trim()) return wt.stdout;
  const staged = await ctx.git(["diff", "--staged", "--"]);
  return staged.stdout;
}

function syncIo(ctx: ToolExecutionContext): {
  listFiles: (root: string) => string[] | null;
  read: (path: string) => string;
} {
  // Core scan functions are sync; bridge via cached async reads is not
  // possible, so tools that need scans use the async variants below.
  // This helper is kept for the sync-only paths that read via best-effort cache.
  void ctx;
  return {
    listFiles: () => null,
    read: () => { throw new Error("unavailable"); },
  };
}
void syncIo;

/** Execute a tool by name with arguments. Validates args, enforces containment. */
export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolExecutionContext,
): Promise<ToolExecutionResult> {
  const callId = `call_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  const def = TOOL_DEFINITIONS.find((t) => t.name === name);
  if (!def) return { callId, name, output: "", error: `Unknown tool: ${name}` };
  const argError = validateToolArgs(def, args);
  if (argError) return { callId, name, output: "", error: argError };
  try {
    let output: string;
    switch (name) {
      case "read_file": output = await readFileTool(args as { path: string; startLine?: number; endLine?: number }, ctx); break;
      case "search_code": output = await searchCodeTool(args as { pattern: string; maxResults?: number }, ctx); break;
      case "analyze_change": output = await analyzeChangeTool(ctx); break;
      case "impact_analysis": output = await impactAnalysisTool(ctx); break;
      case "discover_tests": output = await discoverTestsTool(ctx); break;
      case "run_tests": output = await runTestsTool(args as { paths?: string }, ctx); break;
      case "generate_tests": output = await generateTestsTool(ctx); break;
      case "diagnose_failure": output = await diagnoseFailureTool(args as { testPath: string }, ctx); break;
      case "propose_fix": output = await proposeFixTool(args as { testPath: string }, ctx); break;
      case "api_contracts": output = await apiContractsTool(ctx); break;
      case "search_docs": output = await searchDocsTool(args as { query: string }, ctx); break;
      default: return { callId, name, output: "", error: `Unknown tool: ${name}` };
    }
    return { callId, name, output };
  } catch (err) {
    return { callId, name, output: "", error: err instanceof Error ? err.message : String(err) };
  }
}

async function readFileTool(
  args: { path: string; startLine?: number; endLine?: number },
  ctx: ToolExecutionContext,
): Promise<string> {
  const safe = containedPath(ctx.workspaceRoot, args.path);
  if (!safe) throw new Error(`Refused: \`${args.path}\` escapes the workspace.`);
  const content = await ctx.readFile(safe);
  if (content == null) throw new Error(`File not found: ${args.path}`);
  const capped = content.length > 20000 ? `${content.slice(0, 20000)}\n…(truncated)` : content;
  if (args.startLine !== undefined || args.endLine !== undefined) {
    const lines = capped.split("\n");
    const start = Math.max(0, (args.startLine ?? 1) - 1);
    const end = args.endLine !== undefined ? Math.min(lines.length, args.endLine) : lines.length;
    if (start >= lines.length) throw new Error(`startLine ${args.startLine} beyond file (${lines.length} lines).`);
    return lines.slice(start, end).join("\n");
  }
  return capped;
}

async function searchCodeTool(
  args: { pattern: string; maxResults?: number },
  ctx: ToolExecutionContext,
): Promise<string> {
  let regex: RegExp;
  try {
    regex = new RegExp(args.pattern);
  } catch {
    throw new Error(`Invalid regex: ${args.pattern}`);
  }
  const files = await ctx.listFiles(ctx.workspaceRoot);
  if (!files) throw new Error("Could not list workspace files");
  const maxResults = Math.min(Math.max(args.maxResults ?? 50, 1), 100);
  const results: string[] = [];
  const scanned = files.filter((f) => !/(^|\/)(node_modules|\.git|dist|build|coverage)(\/|$)/.test(f)).slice(0, 200);
  for (const file of scanned) {
    if (results.length >= maxResults) break;
    // Untrusted content (file bodies) is searched, never executed.
    const content = await ctx.readFile(file);
    if (!content) continue;
    const lines = content.slice(0, 100000).split("\n");
    for (let i = 0; i < lines.length; i++) {
      // Reset lastIndex for global patterns.
      regex.lastIndex = 0;
      if (regex.test(lines[i] ?? "")) {
        results.push(`${file}:${i + 1}: ${(lines[i] ?? "").trim().slice(0, 220)}`);
        if (results.length >= maxResults) break;
      }
    }
  }
  return results.join("\n") || "No matches found";
}

async function analyzeChangeTool(ctx: ToolExecutionContext): Promise<string> {
  const diffText = await currentDiff(ctx);
  if (!diffText.trim()) return "No changes in working tree or staging area.";
  const map = buildReviewMap(diffText);
  const queue = buildDecisions(analyzeSemantics(diffText));
  const summary = decisionSummary(queue);
  const lines = [
    `## Review Map`,
    `${map.totalLoc} LOC across ${map.files.length} files · ${map.modules.length} modules`,
    `Risk: Critical ${map.riskDistribution.Critical.files} | High ${map.riskDistribution.High.files} | Medium ${map.riskDistribution.Medium.files} | Low ${map.riskDistribution.Low.files}`,
    ``,
    `## Decisions (${queue.length})`,
    `Pending: ${summary.pending} | Accepted: ${summary.accepted} | Rejected: ${summary.rejected} | Investigating: ${summary.investigating}`,
    `Pending Critical/High: ${summary.pendingCriticalHigh}`,
    ``,
    queue.slice(0, 10).map((d) => `- [${d.severity}] ${d.findingType} in \`${d.file}\` (confidence: ${d.confidence.toFixed(2)})`).join("\n"),
  ];
  return lines.join("\n");
}

/** Async repo scan for impact (core buildImpactMap is sync; here we gather file lists async). */
async function impactAnalysisTool(ctx: ToolExecutionContext): Promise<string> {
  const diff = await currentDiff(ctx);
  if (!diff.trim()) return "No changes to analyze.";
  const symbols = symbolsForHunks(parseFileHunks(diff));
  const changedPaths = parseUnifiedDiff(diff).map((f) => f.path);
  const files = (await ctx.listFiles(ctx.workspaceRoot)) ?? [];
  const cache = new Map<string, string>();
  const read = (p: string): string => {
    const hit = cache.get(p);
    if (hit !== undefined) return hit;
    throw new Error(`unread:${p}`);
  };
  // Best-effort async preload, then run the sync tracer over what we have.
  for (const f of files.slice(0, 200)) {
    try {
      const c = await ctx.readFile(f);
      if (c != null) cache.set(f, c.slice(0, 100000));
    } catch { /* skip */ }
  }
  const available = (p: string): boolean => cache.has(p);
  const io = {
    listFiles: (_root: string): string[] | null => files.filter(available),
    read,
  };
  const impact = buildImpactMap(symbols, changedPaths, io, ctx.workspaceRoot);
  const lines = [
    `## Impact Analysis`,
    `Direct files: ${impact.directFiles.length}`,
    `Indirect files: ${impact.indirectFiles.length}`,
    `Test files: ${impact.testFiles.length}`,
    `Scanned: ${impact.scannedFiles} files`,
  ];
  if (impact.directFiles.length > 0) lines.push(`Direct: ${impact.directFiles.slice(0, 15).join(", ")}`);
  if (impact.indirectFiles.length > 0) lines.push(`Indirect: ${impact.indirectFiles.slice(0, 10).join(", ")}`);
  if (impact.testFiles.length > 0) lines.push(`Test files: ${impact.testFiles.slice(0, 10).join(", ")}`);
  if (impact.unresolved.length > 0) lines.push(`Unresolved: ${impact.unresolved.slice(0, 3).join("; ")}`);
  return lines.join("\n");
}

async function discoverTestsTool(ctx: ToolExecutionContext): Promise<string> {
  const files = (await ctx.listFiles(ctx.workspaceRoot)) ?? [];
  const cache = new Map<string, string>();
  for (const f of files.slice(0, 400)) {
    try {
      const c = await ctx.readFile(f);
      if (c != null) cache.set(f, c);
    } catch { /* skip */ }
  }
  const io = {
    listFiles: (_root: string): string[] | null => files,
    read: (p: string): string => {
      const hit = cache.get(p);
      if (hit === undefined) throw new Error(`unread:${p}`);
      return hit;
    },
  };
  const discovery = discoverTests(io, ctx.workspaceRoot);
  const lines = [
    `## Test Discovery`,
    `Discovered: ${discovery.tests.length} test files`,
    `Frameworks: ${discovery.frameworks.join(", ") || "none"}`,
    `Scanned: ${discovery.scannedFiles} files`,
    ``,
  ];
  for (const t of discovery.tests.slice(0, 20)) {
    lines.push(`- \`${t.path}\` — ${t.category}/${t.layer}/${t.framework} — \`${t.command.join(" ")}\``);
  }
  if (discovery.gaps.length > 0) {
    lines.push(``, `Gaps:`, ...discovery.gaps.slice(0, 5).map((g) => `- ${g}`));
  }
  return lines.join("\n");
}

async function runTestsTool(args: { paths?: string }, ctx: ToolExecutionContext): Promise<string> {
  const files = (await ctx.listFiles(ctx.workspaceRoot)) ?? [];
  const cache = new Map<string, string>();
  for (const f of files.slice(0, 400)) {
    try {
      const c = await ctx.readFile(f);
      if (c != null) cache.set(f, c);
    } catch { /* skip */ }
  }
  const io = {
    listFiles: (_root: string): string[] | null => files,
    read: (p: string): string => {
      const hit = cache.get(p);
      if (hit === undefined) throw new Error(`unread:${p}`);
      return hit;
    },
  };
  const discovery = discoverTests(io, ctx.workspaceRoot);
  let wanted = (args.paths ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  wanted = wanted.map((p) => containedPath(ctx.workspaceRoot, p)).filter((p): p is string => p !== null);
  let selection = discovery.tests.filter((t) => wanted.length === 0 || wanted.includes(t.path));
  if (wanted.length === 0) {
    const diff = await currentDiff(ctx);
    if (diff.trim()) {
      const changedPaths = parseUnifiedDiff(diff).map((f) => f.path);
      const symbols = symbolsForHunks(parseFileHunks(diff));
      const impact = buildImpactMap(symbols, changedPaths, io, ctx.workspaceRoot);
      selection = selectTests(changedPaths, impact, discovery.tests).selected;
    } else {
      selection = discovery.tests.slice(0, 5);
    }
  }
  if (!selection.length) return "No tests selected.";
  const capped = selection.slice(0, 10);
  // Real execution via injected runner (tests inject a fake; hosts run real tools).
  const results = await runTests(capped.map((t) => ({ ...t, reason: "chat", basis: "confirmed" as const })), {
    cwd: ctx.workspaceRoot,
    timeoutMs: 60000,
    revision: "chat",
  });
  const lines = [`## Test Run (${results.length})`];
  for (const r of results) {
    lines.push(`- \`${r.path}\`: ${r.status} (exit ${r.exitCode ?? "—"}) — ${r.detail}`);
    if (r.status === "failed" && r.output) lines.push(`  \`\`\`\n  ${r.output.slice(-2000)}\n  \`\`\``);
  }
  return lines.join("\n");
}

async function generateTestsTool(ctx: ToolExecutionContext): Promise<string> {
  const { generateTests } = await import("./generate.js");
  const diff = await currentDiff(ctx);
  if (!diff.trim()) return "No changes to generate tests for.";
  const symbols = symbolsForHunks(parseFileHunks(diff));
  const generated = generateTests(symbols, {
    readFile: (p) => null,
  }, "node:test", { previousLines: [] });
  void ctx;
  if (!generated.length) return "No generatable symbols in this change.";
  const lines = [`## Generated Tests (${generated.length}) — proposals only, nothing written`];
  for (const g of generated.slice(0, 5)) {
    lines.push(`### \`${g.path}\` → \`${g.target}\``);
    lines.push(`Covers: ${g.covers.join("; ")}`);
    lines.push("```ts");
    lines.push(g.source.slice(0, 3000));
    lines.push("```");
    lines.push("");
  }
  return lines.join("\n");
}

async function diagnoseFailureTool(args: { testPath: string }, ctx: ToolExecutionContext): Promise<string> {
  const safe = containedPath(ctx.workspaceRoot, args.testPath);
  if (!safe) throw new Error(`Refused: \`${args.testPath}\` escapes the workspace.`);
  const diff = await currentDiff(ctx);
  const changedPaths = diff.trim() ? parseUnifiedDiff(diff).map((f) => f.path) : [];
  const symbols = diff.trim() ? symbolsForHunks(parseFileHunks(diff)) : [];
  const execRes = await ctx.exec("node", ["--test", safe], { cwd: ctx.workspaceRoot, timeoutMs: 30000 });
  const diagnosis = diagnoseFailure({
    path: safe,
    command: ["node", "--test", safe],
    status: execRes.exitCode === 0 ? "passed" : "failed",
    exitCode: execRes.exitCode,
    output: `${execRes.stdout}\n${execRes.stderr}`.slice(-6000),
    durationMs: 0,
    revision: "chat",
    detail: execRes.exitCode === 0 ? "passed" : `exited ${execRes.exitCode}`,
  }, {
    changedFiles: changedPaths,
    symbols: symbols.map((s) => ({ name: s.name, file: s.file, line: s.line })),
    readFile: (_p) => null,
    removedGuard: null,
  });
  const lines = [
    `## Diagnosis — \`${diagnosis.testPath}\` (exit ${diagnosis.exitCode ?? "—"})`,
    `Failure: ${diagnosis.summary}`,
    ``,
    `Stack (innermost first):`,
    ...diagnosis.frames.slice(0, 5).map((f) => `- \`${f.path}${f.line ? `:${f.line}` : ""}\`${f.fn ? ` — ${f.fn}` : ""}`),
    ``,
    `Possible causes:`,
    ...diagnosis.causes.map((c) => `- [${c.standing}] ${c.statement}`),
    ``,
    diagnosis.patch
      ? `Proposed patch (NOT applied):\n\`\`\`diff\n${diagnosis.patch.diff}\n\`\`\`\n${diagnosis.patch.description}`
      : `No mechanical patch recognized — fix must be human-authored.`,
  ];
  return lines.join("\n");
}

/** Structured fix proposal for action handlers. Shared by proposeFixTool and
 *  the extension's apply_fix executor so both see the same real diagnosis. */
export interface FixProposal {
  testPath: string;
  summary: string;
  patch: { path: string; diff: string; description: string } | null;
  guardLines: string[];
}

export async function proposeFixStructured(testPath: string, ctx: ToolExecutionContext): Promise<FixProposal> {
  const safe = containedPath(ctx.workspaceRoot, testPath);
  if (!safe) throw new Error(`Refused: \`${testPath}\` escapes the workspace.`);
  const diff = await currentDiff(ctx);
  const changedPaths = diff.trim() ? parseUnifiedDiff(diff).map((f) => f.path) : [];
  const symbols = diff.trim() ? symbolsForHunks(parseFileHunks(diff)) : [];
  const execRes = await ctx.exec("node", ["--test", safe], { cwd: ctx.workspaceRoot, timeoutMs: 30000 });
  const diagnosis = diagnoseFailure({
    path: safe,
    command: ["node", "--test", safe],
    status: execRes.exitCode === 0 ? "passed" : "failed",
    exitCode: execRes.exitCode,
    output: `${execRes.stdout}\n${execRes.stderr}`.slice(-6000),
    durationMs: 0,
    revision: "chat",
    detail: "",
  }, {
    changedFiles: changedPaths,
    symbols: symbols.map((s) => ({ name: s.name, file: s.file, line: s.line })),
    readFile: (_p) => null,
    removedGuard: null,
  });
  return {
    testPath: safe,
    summary: diagnosis.summary,
    patch: diagnosis.patch ? { path: diagnosis.patch.path, diff: diagnosis.patch.diff, description: diagnosis.patch.description } : null,
    guardLines: diagnosis.patch
      ? diagnosis.patch.diff.split("\n").filter((l) => l.startsWith("+")).map((l) => l.slice(1)).filter((l) => l.trim())
      : [],
  };
}

async function proposeFixTool(args: { testPath: string }, ctx: ToolExecutionContext): Promise<string> {
  const proposal = await proposeFixStructured(args.testPath, ctx);
  if (!proposal.patch) {
    return `No mechanical patch recognized for \`${proposal.testPath}\`. Fix must be human-authored.`;
  }
  // Approval is enforced by the chat engine (requiresApproval) — this tool
  // only PROPOSES. It never writes without the engine's explicit approval.
  return [
    `## Proposed fix for \`${proposal.testPath}\` (NOT applied — approve to apply)`,
    ``,
    "```diff",
    proposal.patch.diff,
    "```",
    ``,
    proposal.patch.description,
  ].join("\n");
}

/** Apply a proposed guard patch. Called by the engine only after approval. */
export async function applyFixAfterApproval(
  patch: { path: string; diff: string; description: string },
  guardLines: string[],
  ctx: ToolExecutionContext,
): Promise<string> {
  const safe = containedPath(ctx.workspaceRoot, patch.path);
  if (!safe) throw new Error(`Refused: \`${patch.path}\` escapes the workspace.`);
  let content: string | null;
  try {
    content = await ctx.readFile(safe);
  } catch {
    content = null;
  }
  if (content == null) throw new Error(`Cannot read ${safe}`);
  const applied = applyProposedPatch({ ...patch, path: safe }, guardLines, {
    read: (_p) => content as string,
    write: (_p, _c) => { throw new Error("use ctx.writeFile"); },
  }, { approve: false });
  void applied;
  // Real write through the injected context (containment already checked).
  const lines = content.split("\n");
  const missing = guardLines.filter((l) => l.trim() && !content.includes(l.trim()));
  if (missing.length === 0) return `No-op: guard lines already present in \`${safe}\`.`;
  const at = lines.findIndex((l) => /\bthrow\b/.test(l));
  lines.splice(at >= 0 ? at : 0, 0, ...missing);
  await ctx.writeFile(safe, lines.join("\n"));
  return `Fix applied to \`${safe}\`: inserted ${missing.length} guard line(s). Re-run affected tests.`;
}

async function apiContractsTool(ctx: ToolExecutionContext): Promise<string> {
  const diff = await currentDiff(ctx);
  if (!diff.trim()) return "No changes to analyze.";
  const symbols = symbolsForHunks(parseFileHunks(diff));
  const endpoints = symbols.filter((s) => s.kind === "endpoint");
  if (!endpoints.length) return "No endpoint symbols in this change.";
  const lines = [`## API Contracts (${endpoints.length})`];
  for (const e of endpoints.slice(0, 20)) {
    lines.push(`- \`${e.name}\` — \`${e.file}${e.line ? `:${e.line}` : ""}\` — \`${e.signature}\``);
  }
  return lines.join("\n");
}

async function searchDocsTool(args: { query: string }, ctx: ToolExecutionContext): Promise<string> {
  // Untrusted query is used as a case-insensitive substring/regex over local
  // docs only — never executed, never sent anywhere by this tool.
  let regex: RegExp;
  try {
    regex = new RegExp(args.query, "i");
  } catch {
    regex = new RegExp(args.query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
  }
  const docPaths = ["README.md", "docs/README.md", "ADR.md", "design.md", "DESIGN.md", "docs/architecture.md", "CONTRIBUTING.md"];
  const lines = [`## Doc Search: "${args.query.slice(0, 120)}"`];
  let hits = 0;
  for (const p of docPaths) {
    try {
      const content = await ctx.readFile(p);
      if (!content) continue;
      const matches = content.split("\n").filter((l) => { regex.lastIndex = 0; return regex.test(l); }).slice(0, 3);
      if (matches.length > 0) {
        hits += matches.length;
        lines.push(``, `### \`${p}\``, ...matches.map((m) => `- ${m.trim().slice(0, 200)}`));
      }
    } catch { continue; }
  }
  if (hits === 0) lines.push("", "No matches found.");
  return lines.join("\n");
}
