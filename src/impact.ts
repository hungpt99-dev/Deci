// Impact tracing: changed symbols → referencing files. Pure core with
// injected I/O; deterministic, bounded, local-first.
//
// Honesty rules enforced here, not just documented:
// - An edge requires a textual reference (word-boundary name match) in the
//   impacted file. Same-module or filename similarity alone NEVER creates
//   an edge.
// - `import-resolved` (import line + name) outranks `textual` (name only).
// - Everything this scan cannot see is reported in `unresolved`/limits.

import { toModule } from "./reviewMap.js";
import type { ChangedSymbol } from "./symbols.js";

export type EvidenceClass = "import-resolved" | "textual";
export type ImpactDepth = "direct" | "indirect";

export interface ImpactEdge {
  /** Changed symbol that pulls this file into scope. */
  symbol: string;
  fromFile: string;
  toFile: string;
  /** 1-based line of the first reference in the impacted file. */
  toLine: number;
  evidence: EvidenceClass;
  depth: ImpactDepth;
  /** Trimmed referencing line (max 160 chars). */
  excerpt: string;
  /** How many reference lines were found in the file. */
  matches: number;
  /** Intermediate file for indirect edges. */
  via?: string;
  /** True when the impacted path looks like a test. */
  isTest: boolean;
}

export interface ImpactMap {
  edges: ImpactEdge[];
  directFiles: string[];
  indirectFiles: string[];
  testFiles: string[];
  scannedFiles: number;
  truncated: boolean;
  /** Human-readable coverage gaps; empty means the scan completed in scope. */
  unresolved: string[];
}

export interface ImpactIo {
  /** Null = not a directory; [] = empty. Callee caps apply on top. */
  listFiles: (root: string) => string[] | null;
  /** Throws or oversized content = skipped + disclosed, never fatal. */
  read: (path: string) => string;
}

const MAX_SCAN_FILES = 200;
const MAX_FILE_BYTES = 100_000;
const MAX_DIRECT_PER_SYMBOL = 20;
const MAX_INDIRECT = 20;

const SOURCE_RE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|java|py|go|rb|php|cs|kt|swift)$/i;
const TEST_RE = /\.test\.|\.spec\.|__tests__|(^|\/)tests?(\/|$)/i;
// Agent-harness worktrees hold repo copies — tracing into them fabricates
// duplicate impact edges for the same logical file.
const SKIP_RE = /(^|\/)(node_modules|\.git|dist|build|coverage|\.next|vendor|\.kilo|\.opencode|\.agents|\.cursor|worktrees)(\/|$)/;

const IMPORT_RE = /^\s*(import|from|require\(|include|use)\b/;

function isTestPath(p: string): boolean {
  return TEST_RE.test(p);
}

function baseName(p: string): string {
  const b = p.split("/").pop() ?? p;
  return b.replace(/\.[^.]+$/, "");
}

function wordMatch(line: string, name: string): boolean {
  if (name.startsWith("/")) return line.includes(name);
  try {
    return new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(line);
  } catch {
    return line.includes(name);
  }
}

/** True when the file imports the changed module (basename match on an import line). */
function importsModule(lines: string[], changedFile: string): boolean {
  const base = baseName(changedFile).toLowerCase();
  const mod = toModule(changedFile).toLowerCase();
  return lines.some(
    (l) =>
      IMPORT_RE.test(l) &&
      (l.toLowerCase().includes(base) || (mod !== "(root)" && l.toLowerCase().includes(mod))),
  );
}

interface Scanned {
  path: string;
  lines: string[];
}

function scanRepo(io: ImpactIo, root: string, changed: Set<string>): { files: Scanned[]; unresolved: string[]; truncated: boolean } {
  const unresolved: string[] = [];
  let listed: string[] | null;
  try {
    listed = io.listFiles(root);
  } catch (err) {
    return { files: [], unresolved: [`Could not list ${root}: ${(err as Error).message}. Impact tracing skipped.`], truncated: false };
  }
  if (!listed) return { files: [], unresolved: [`${root} is not a directory. Impact traced from the diff only.`], truncated: false };
  // Diff paths and scanned paths may be rooted differently (e.g. analysis
  // run from a parent directory). Compare by suffix as well as equality so
  // the changed files themselves never appear as their own impact.
  const isChanged = (p: string): boolean => {
    if (changed.has(p)) return true;
    for (const c of changed) {
      if (p.endsWith(`/${c}`) || c.endsWith(`/${p}`)) return true;
    }
    return false;
  };
  const candidates = listed.filter((p) => SOURCE_RE.test(p) && !SKIP_RE.test(p) && !isChanged(p));
  const truncated = candidates.length > MAX_SCAN_FILES;
  const files: Scanned[] = [];
  for (const p of candidates.slice(0, MAX_SCAN_FILES)) {
    let raw: string;
    try {
      raw = io.read(p);
    } catch {
      unresolved.push(`Unreadable: \`${p}\` — references from this file are unknown.`);
      continue;
    }
    if (raw.length > MAX_FILE_BYTES) {
      unresolved.push(`Skipped oversized file: \`${p}\` — references from it are unknown.`);
      continue;
    }
    files.push({ path: p, lines: raw.split("\n") });
  }
  return { files, unresolved, truncated };
}

/** Changed symbols + repo scan → evidence-classed impact edges. Deterministic. */
export function buildImpactMap(
  symbols: ChangedSymbol[],
  changedFiles: string[],
  io: ImpactIo,
  root: string,
): ImpactMap {
  const changed = new Set(changedFiles);
  const { files, unresolved, truncated } = scanRepo(io, root, changed);
  const edges: ImpactEdge[] = [];
  const seen = new Set<string>();

  const push = (e: ImpactEdge): void => {
    const key = `${e.symbol}\0${e.toFile}\0${e.depth}`;
    if (seen.has(key)) return;
    seen.add(key);
    edges.push(e);
  };

  const directFiles = new Set<string>();
  for (const s of symbols) {
    let n = 0;
    for (const f of files) {
      if (n >= MAX_DIRECT_PER_SYMBOL) break;
      const hits: number[] = [];
      f.lines.forEach((l, i) => {
        if (wordMatch(l, s.name)) hits.push(i + 1);
      });
      if (hits.length === 0) continue;
      n += 1;
      directFiles.add(f.path);
      push({
        symbol: s.name,
        fromFile: s.file,
        toFile: f.path,
        toLine: hits[0] as number,
        evidence: importsModule(f.lines, s.file) ? "import-resolved" : "textual",
        depth: "direct",
        excerpt: f.lines[(hits[0] as number) - 1]?.trim().slice(0, 160) ?? "",
        matches: hits.length,
        isTest: isTestPath(f.path),
      });
    }
    if (n === 0 && (s.change === "added" || s.change === "modified")) {
      unresolved.push(`No references to \`${s.name}\` in ${files.length} scanned file(s) — callers may exist outside the scan scope.`);
    }
  }

  // Indirect: files that import a directly-impacted file (second hop).
  let indirect = 0;
  for (const f of files) {
    if (indirect >= MAX_INDIRECT) break;
    if (directFiles.has(f.path)) continue;
    for (const d of directFiles) {
      const hits: number[] = [];
      f.lines.forEach((l, i) => {
        if (IMPORT_RE.test(l) && l.toLowerCase().includes(baseName(d).toLowerCase())) hits.push(i + 1);
      });
      if (hits.length === 0) continue;
      indirect += 1;
      push({
        symbol: baseName(d),
        fromFile: d,
        toFile: f.path,
        toLine: hits[0] as number,
        evidence: "import-resolved",
        depth: "indirect",
        excerpt: f.lines[(hits[0] as number) - 1]?.trim().slice(0, 160) ?? "",
        matches: hits.length,
        via: d,
        isTest: isTestPath(f.path),
      });
      break;
    }
  }

  if (truncated) unresolved.unshift(`Scan capped at ${MAX_SCAN_FILES} files — impact beyond the cap is unknown.`);
  const testFiles = [...new Set(edges.filter((e) => e.isTest).map((e) => e.toFile))].sort();
  return {
    edges: edges.sort((a, b) => a.depth.localeCompare(b.depth) || a.toFile.localeCompare(b.toFile)),
    directFiles: [...directFiles].sort(),
    indirectFiles: [...new Set(edges.filter((e) => e.depth === "indirect").map((e) => e.toFile))].sort(),
    testFiles,
    scannedFiles: files.length,
    truncated,
    unresolved,
  };
}

/** One-line impact tree for CLI markdown: file → symbol → evidence. */
export function renderImpactMarkdown(map: ImpactMap): string {
  if (map.edges.length === 0)
    return [`## Impact`, ``, `No referencing files found in ${map.scannedFiles} scanned file(s).`, ``, ...unresolvedLines(map)].join("\n");
  const direct = map.edges.filter((e) => e.depth === "direct");
  const indirect = map.edges.filter((e) => e.depth === "indirect");
  const row = (e: ImpactEdge): string =>
    `- \`${e.toFile}:${e.toLine}\` — references \`${e.symbol}\` (${e.evidence}, ${e.matches}×)${e.via ? ` via \`${e.via}\`` : ""}${e.isTest ? " · test" : ""}`;
  return [
    `## Impact (${direct.length} direct, ${indirect.length} indirect — ${map.scannedFiles} files scanned)`,
    ``,
    ...direct.map(row),
    ...(indirect.length ? [``, `Indirect:`, ...indirect.map(row)] : []),
    ``,
    ...unresolvedLines(map),
  ].join("\n");
}

function unresolvedLines(map: ImpactMap): string[] {
  if (map.unresolved.length === 0) return [];
  return [`Coverage gaps:`, ...map.unresolved.map((u) => `- ${u}`), ``];
}
