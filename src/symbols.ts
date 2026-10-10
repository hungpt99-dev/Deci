// Changed-symbol extraction. Pure, local, no LLM, no I/O.
//
// Regex-based declaration scan over diff hunk lines — a heuristic stand-in
// for full AST parsing (see CAPABILITIES). Every symbol carries its
// provenance (file, new-file line or null for pure removals, declaring
// line), so downstream impact tracing can cite evidence instead of guessing.

import { languageFor, type FileHunk } from "./semantic.js";

export type SymbolKind =
  | "function"
  | "method"
  | "class"
  | "interface"
  | "type"
  | "constant"
  | "endpoint"
  | "unknown";

export type SymbolChange = "added" | "removed" | "modified";

export interface ChangedSymbol {
  name: string;
  kind: SymbolKind;
  file: string;
  /** 1-based new-file line for added/modified; null for pure removals. */
  line: number | null;
  change: SymbolChange;
  /** Trimmed declaring line (evidence, max 160 chars). */
  signature: string;
}

export type CapabilityLevel = "heuristic" | "supported" | "unavailable";

export interface LanguageCapabilities {
  language: string;
  paths: string;
  symbolParsing: CapabilityLevel;
  callReferences: CapabilityLevel;
  typeRelations: CapabilityLevel;
  contractDiscovery: CapabilityLevel;
  testIdentification: CapabilityLevel;
  impactTraversal: CapabilityLevel;
  note: string;
}

/**
 * What each language path can actually do. Nothing here claims AST parsing:
 * symbol and reference discovery is pattern-based and labeled `heuristic`
 * wherever it applies, so callers can disclose limits instead of implying
 * complete coverage.
 */
export const CAPABILITIES: LanguageCapabilities[] = [
  {
    language: "typescript",
    paths: ".ts/.tsx/.mts/.cts/.js/.jsx",
    symbolParsing: "heuristic",
    callReferences: "heuristic",
    typeRelations: "heuristic",
    contractDiscovery: "heuristic",
    testIdentification: "heuristic",
    impactTraversal: "heuristic",
    note: "Declaration + reference patterns; no type resolution. Re-exports and dynamic calls are missed.",
  },
  {
    language: "java",
    paths: ".java",
    symbolParsing: "heuristic",
    callReferences: "heuristic",
    typeRelations: "heuristic",
    contractDiscovery: "heuristic",
    testIdentification: "heuristic",
    impactTraversal: "heuristic",
    note: "Class/method/annotation patterns; no overload or hierarchy resolution.",
  },
  {
    language: "generic",
    paths: "everything else",
    symbolParsing: "unavailable",
    callReferences: "unavailable",
    typeRelations: "unavailable",
    contractDiscovery: "heuristic",
    testIdentification: "heuristic",
    impactTraversal: "unavailable",
    note: "File-level only: contracts by path, tests by sibling name. No symbol tracing.",
  },
];

export function capabilitiesFor(path: string): LanguageCapabilities {
  const lang = languageFor(path);
  return CAPABILITIES.find((c) => c.language === lang) ?? CAPABILITIES[2] as LanguageCapabilities;
}

interface Decl {
  name: string;
  kind: SymbolKind;
}

// Ordered: first match wins per line.
const DECL_PATTERNS: Array<{ re: RegExp; kind: SymbolKind }> = [
  { re: /@(?:GetMapping|PostMapping|PutMapping|DeleteMapping|PatchMapping|RequestMapping)\b/, kind: "endpoint" },
  { re: /app\.(get|post|put|delete|patch)\s*\(/, kind: "endpoint" },
  { re: /router\.(get|post|put|delete|patch)\s*\(/, kind: "endpoint" },
  { re: /export\s+default\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/, kind: "function" },
  { re: /export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/, kind: "function" },
  { re: /function\s+([A-Za-z_$][\w$]*)\s*\(/, kind: "function" },
  { re: /export\s+class\s+([A-Za-z_$][\w$]*)/, kind: "class" },
  { re: /(?:public\s+)?class\s+([A-Za-z_$][\w$]*)/, kind: "class" },
  { re: /export\s+interface\s+([A-Za-z_$][\w$]*)/, kind: "interface" },
  { re: /interface\s+([A-Za-z_$][\w$]*)\b/, kind: "interface" },
  { re: /export\s+type\s+([A-Za-z_$][\w$]*)/, kind: "type" },
  { re: /export\s+(?:async\s+)?const\s+([A-Za-z_$][\w$]*)/, kind: "constant" },
  // Module-level constant (no export). Locals inside a body can also match;
  // harmless for tracing: an edge still needs an observed reference.
  { re: /^(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=/, kind: "constant" },
  // Method definitions open a block; calls end with `;`. Anchoring on `{`
  // keeps `checkout(cart, 50);` and `new Error("x");` out of declarations.
  { re: /(?:public|private|protected)?\s*(?:static\s+)?(?:async\s+)?([A-Za-z_$][\w$]*)\s*\([^;{}]*\)\s*(?::\s*[^{;=]+)?\s*[{]/, kind: "method" },
];

function declOf(line: string): Decl | null {
  const t = line.trim();
  if (!t || t.startsWith("//") || t.startsWith("*") || t.startsWith("import ") || t.startsWith("import{")) return null;
  // Route-table entries: { method: "POST", path: "/checkout", ... }.
  const route = /\{\s*method:\s*["'](?:GET|POST|PUT|DELETE|PATCH)["']\s*,\s*path:\s*["'`](\/[^"'`]*)["'`]/.exec(t);
  if (route) return { name: (route[1] as string).slice(0, 80), kind: "endpoint" };
  for (const { re, kind } of DECL_PATTERNS) {
    const m = re.exec(t);
    if (!m) continue;
    // Endpoint patterns carry no name group.
    const name = m[1] ?? (kind === "endpoint" ? endpointName(t) : undefined);
    if (!name || isKeyword(name)) continue;
    // Constructor calls are not declarations (`new Error("x")`).
    if (new RegExp(`\\bnew\\s+${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\(`).test(t)) continue;
    return { name, kind };
  }
  return null;
}

function endpointName(line: string): string | undefined {
  const m = /["'`](\/[^"'`]*|[\w\-/{}$:.]+)["'`]/.exec(line);
  return m?.[1]?.slice(0, 80);
}

const KEYWORDS = new Set([
  "if", "for", "while", "switch", "catch", "return", "new", "typeof", "import", "export",
  "public", "private", "protected", "static", "async", "function", "class",
]);

function isKeyword(name: string): boolean {
  return KEYWORDS.has(name);
}

/** Hunk lines → changed declarations. Pure; unknown input → []. Never throws. */
export function extractSymbols(hunk: FileHunk): ChangedSymbol[] {
  const lines = hunk.addedLines && hunk.addedLines.length === hunk.added.length
    ? hunk.addedLines
    : hunk.added.map((_, i) => i + 1);
  const seen = new Map<string, ChangedSymbol>();
  hunk.added.forEach((text, i) => {
    const d = declOf(text);
    if (!d) return;
    const key = `${d.kind}:${d.name}`;
    const prev = seen.get(key);
    if (prev) {
      prev.change = "modified";
      return;
    }
    seen.set(key, {
      name: d.name,
      kind: d.kind,
      file: hunk.path,
      line: lines[i] ?? null,
      change: hunk.removed.some((r) => declOf(r)?.name === d.name) ? "modified" : "added",
      signature: text.trim().slice(0, 160),
    });
  });
  for (const text of hunk.removed) {
    const d = declOf(text);
    if (!d) continue;
    const key = `${d.kind}:${d.name}`;
    if (seen.has(key)) continue;
    seen.set(key, {
      name: d.name,
      kind: d.kind,
      file: hunk.path,
      line: null,
      change: "removed",
      signature: text.trim().slice(0, 160),
    });
  }
  // Enclosing scope merges in unconditionally: a hunk can touch a
  // declaration AND the body around it. Context declarations keep
  // change "modified" with line null — the declaration itself did not move.
  // Locals are skipped here: a `const` inside a body is not an enclosing
  // scope (module-level constants arrive via added/removed lines instead).
  for (const text of hunk.context ?? []) {
    const d = declOf(text);
    if (!d || d.kind === "constant") continue;
    const key = `${d.kind}:${d.name}`;
    if (seen.has(key)) continue;
    seen.set(key, {
      name: d.name,
      kind: d.kind,
      file: hunk.path,
      line: null,
      change: "modified",
      signature: text.trim().slice(0, 160),
    });
  }
  return [...seen.values()];
}

/** Diff hunks → per-file changed symbols. Pure. */
export function symbolsForHunks(hunks: FileHunk[]): ChangedSymbol[] {
  return hunks.flatMap(extractSymbols);
}
