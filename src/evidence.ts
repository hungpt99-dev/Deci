// US-005: Evidence gathering per decision. Pure, local-first, no LLM.
// Decisions in → present/missing evidence bundles out. I/O stays in thin
// adapters (CLI/VS Code) via injected callbacks; unreachable ticket/doc
// marks missing and never blocks analysis.

import { guessTestPath } from "./decisions.js";
import { toModule } from "./reviewMap.js";

export type EvidenceKind =
  | "code"
  | "related-code"
  | "test"
  | "git-history"
  | "doc-adr"
  | "contract"
  | "schema-config"
  | "ticket"
  | "design-doc";

export type EvidenceStatus = "present" | "missing";

export type EvidenceGrade = "VERIFIED" | "SUPPORTED" | "INFERRED" | "UNCERTAIN" | "MISSING";

export interface EvidenceItem {
  kind: EvidenceKind;
  label: string;
  ref: string;
  status: EvidenceStatus;
  /** Grading: direct hits SUPPORTED, indirect (history/ticket) INFERRED, absent MISSING. */
  grade?: EvidenceGrade;
  /** Why this grade; cites source path when present, states gap + next action when missing. */
  reason?: string;
  /** Short excerpt (code line, log entry, ticket text). Truncated, never full file. */
  excerpt: string | null;
  note: string | null;
}

export interface EvidenceBundle {
  decisionId: string;
  file: string;
  items: EvidenceItem[];
  present: number;
  missing: number;
}

export interface TicketInput {
  /** Fetched/excerpted text. Null when not provided or unreachable. */
  text: string | null;
  /** True when fetch was attempted but failed (offline, 404, no network in MVP). */
  unreachable: boolean;
  /** Original reference (URL/ID/path) for the ref column. */
  ref: string | null;
}

export interface EvidenceContext {
  /** All changed paths in the diff (for related-code/contract/schema scans). */
  changedFiles: string[];
  /** Local existence check (adapter injects fs.existsSync; tests stub). */
  fileExists: (path: string) => boolean;
  /** Short excerpt for a local path (adapter injects fs read; null = unreadable). */
  readExcerpt: (path: string) => string | null;
  /** Recent `git log --oneline` entries for a path ([] = none; throws never). */
  gitLogFor: (path: string) => string[];
  /** Known doc/ADR paths in the project (README, docs/, ADRs). */
  docPaths: string[];
  ticket: TicketInput;
  designDoc: TicketInput;
}

export const MAX_EXCERPT_CHARS = 500;

const CONTRACT_RE = /\.proto$|openapi|swagger|schema\.(graphql|json)$|\.graphql$/i;
const SCHEMA_RE =
  /migrat|schema\.sql|schema\.prisma|prisma\/|drizzle\/|typeorm|\.sql$|config\.(json|yaml|yml|toml)$|^(config|configs?)\//i;
const DOC_RE = /^(docs?|adr|adrs|design)(\/|$)|^README|\.md$/i;

function trunc(s: string): string {
  return s.length > MAX_EXCERPT_CHARS ? `${s.slice(0, MAX_EXCERPT_CHARS)}…` : s;
}

function safeExcerpt(ctx: EvidenceContext, path: string): string | null {
  try {
    return ctx.readExcerpt(path);
  } catch {
    return null;
  }
}

function safeExists(ctx: EvidenceContext, path: string): boolean {
  try {
    return ctx.fileExists(path);
  } catch {
    return false;
  }
}

/**
 * Pure: grade for an evidence kind. Present code/test/contract (and sibling/
 * schema/doc/design hits) → SUPPORTED only with excerpt + diff hit, else
 * UNCERTAIN; git-history/ticket → INFERRED (indirect signal); absent → MISSING
 * with gap + next action. Counts unchanged — grade never flips present/missing.
 */
export function gradeFor(
  kind: EvidenceKind,
  found: boolean,
  ref?: string,
  opts?: { excerpt?: string | null; inDiff?: boolean },
): { grade: EvidenceGrade; reason: string } {
  const where = ref ? ` at \`${ref}\`` : "";
  if (!found)
    return { grade: "MISSING", reason: `Missing ${kind}${where} — not found; next: provide ${kind} evidence.` };
  if (kind === "git-history" || kind === "ticket")
    return { grade: "INFERRED", reason: `Inferred from ${kind}${where} — indirect signal, confirm with code/test.` };
  if (opts !== undefined) {
    const hasExcerpt = !!opts.excerpt?.trim();
    const hit = opts.inDiff ?? false;
    if (!hasExcerpt || !hit) {
      const gap = !hit ? "not in diff" : "no readable excerpt";
      return { grade: "UNCERTAIN", reason: `Uncertain ${kind}${where} — present but ${gap}; next: confirm with code/test.` };
    }
  }
  return { grade: "SUPPORTED", reason: `Supported by ${kind}${where} — direct hit in diff or on disk.` };
}

function present(
  kind: EvidenceKind,
  label: string,
  ref: string,
  excerpt: string | null = null,
  note: string | null = null,
  inDiff?: boolean,
): EvidenceItem {
  const g =
    inDiff === undefined ? gradeFor(kind, true, ref) : gradeFor(kind, true, ref, { excerpt, inDiff });
  return { kind, label, ref, status: "present", excerpt: excerpt ? trunc(excerpt) : null, note, grade: g.grade, reason: g.reason };
}

function missing(kind: EvidenceKind, label: string, ref: string, note: string): EvidenceItem {
  return { kind, label, ref, status: "missing", excerpt: null, note, grade: "MISSING", reason: `${note} Next: provide ${kind} evidence for \`${ref}\`.` };
}

/** Same-module changed files excluding self; capped so bundles stay small. */
export function relatedCodeFor(file: string, changedFiles: string[], cap = 5): string[] {
  const mod = toModule(file);
  return changedFiles.filter((p) => p !== file && toModule(p) === mod).slice(0, cap);
}

function ticketItem(input: TicketInput, kind: EvidenceKind, label: string): EvidenceItem {
  if (input.text) return present(kind, label, input.ref ?? label, input.text, null);
  if (input.unreachable)
    return missing(kind, label, input.ref ?? label, "Unreachable — marked missing, analysis continues.");
  return missing(kind, label, label, "Not provided — paste a ticket/doc to use as evidence.");
}

/** Pure: evidence bundle for one decision. Never throws on absent inputs. */
export function collectEvidence(
  decision: { id: string; file: string },
  ctx: EvidenceContext,
): EvidenceBundle {
  const items: EvidenceItem[] = [];
  const file = decision.file;

  // 1. Current code — changed file itself.
  const codeExcerpt = safeExcerpt(ctx, file);
  const codeInDiff = ctx.changedFiles.includes(file);
  if (codeInDiff || safeExists(ctx, file))
    items.push(present("code", "current code", file, codeExcerpt, null, codeInDiff));
  else items.push(missing("code", "current code", file, "File not in diff and not on disk."));

  // 2. Related code — same-module siblings from the diff.
  const related = relatedCodeFor(file, ctx.changedFiles);
  items.push(
    related.length > 0
      ? present("related-code", "related code", related.join(", "), null, `${related.length} same-module file(s).`, true)
      : missing("related-code", "related code", `module:${toModule(file)}`, "No same-module siblings in diff."),
  );

  // 3. Tests — sibling heuristic, then on-disk or in-diff confirmation.
  const testPath = guessTestPath(file);
  const testInDiff = ctx.changedFiles.includes(testPath);
  const testOnDisk = testInDiff || safeExists(ctx, testPath);
  const testExcerpt = testOnDisk ? safeExcerpt(ctx, testPath) : null;
  items.push(
    testOnDisk
      ? present("test", "tests", testPath, testExcerpt, testInDiff ? "Touched in this diff." : null, testInDiff)
      : missing("test", "tests", testPath, "No sibling test found — consider adding one."),
  );

  // 4. Git history — adapter-supplied log; empty or throwing-provider → missing.
  let log: string[] = [];
  try {
    log = ctx.gitLogFor(file) ?? [];
  } catch {
    log = [];
  }
  items.push(
    log.length > 0
      ? present("git-history", "git history", file, log.slice(0, 3).join("\n"), `${log.length} recent commit(s).`)
      : missing("git-history", "git history", file, "No recent history — new file or shallow clone."),
  );

  // 5. Docs/ADRs — SUPPORTED only with excerpt + diff hit, else UNCERTAIN.
  const docs = ctx.docPaths.filter((p) => DOC_RE.test(p)).slice(0, 5);
  const docExcerpt = docs.length > 0 ? safeExcerpt(ctx, docs[0] as string) : null;
  const docInDiff = docs.some((p) => ctx.changedFiles.includes(p));
  items.push(
    docs.length > 0
      ? present("doc-adr", "docs/ADRs", docs.join(", "), docExcerpt, null, docInDiff)
      : missing("doc-adr", "docs/ADRs", "docs/, README, ADR", "No project docs matched."),
  );

  // 6. Contracts.
  const contracts = ctx.changedFiles.filter((p) => CONTRACT_RE.test(p)).slice(0, 5);
  const contractExcerpt = contracts.length > 0 ? safeExcerpt(ctx, contracts[0] as string) : null;
  items.push(
    contracts.length > 0
      ? present("contract", "API contracts", contracts.join(", "), contractExcerpt, null, true)
      : missing("contract", "API contracts", "openapi/proto/graphql", "No contract surface in diff."),
  );

  // 7. Schema/config.
  const schemas = ctx.changedFiles.filter((p) => SCHEMA_RE.test(p)).slice(0, 5);
  items.push(
    schemas.length > 0
      ? present("schema-config", "schema/config", schemas.join(", "), safeExcerpt(ctx, schemas[0] as string), null, true)
      : missing("schema-config", "schema/config", "migrations/schema/config", "No schema/config in diff."),
  );

  // 8–9. Ticket + design doc — provided text wins; unreachable marks missing, never blocks.
  items.push(ticketItem(ctx.ticket, "ticket", "ticket"));
  items.push(ticketItem(ctx.designDoc, "design-doc", "design doc"));

  return {
    decisionId: decision.id,
    file,
    items,
    present: items.filter((i) => i.status === "present").length,
    missing: items.filter((i) => i.status === "missing").length,
  };
}

/** Sensible defaults so callers only override what they have. */
export function emptyContext(over: Partial<EvidenceContext> = {}): EvidenceContext {
  return {
    changedFiles: [],
    fileExists: () => false,
    readExcerpt: () => null,
    gitLogFor: () => [],
    docPaths: [],
    ticket: { text: null, unreachable: false, ref: null },
    designDoc: { text: null, unreachable: false, ref: null },
    ...over,
  };
}

/** Pure: bundles for a whole queue, preserving queue order. */
export function collectQueueEvidence(
  queue: Array<{ id: string; file: string }>,
  ctx: EvidenceContext,
): EvidenceBundle[] {
  return queue.map((d) => collectEvidence(d, ctx));
}

const ICON: Record<EvidenceStatus, string> = { present: "✓", missing: "✗" };

/** Per-decision markdown: ✓/✗ per item with grade, reason, refs and short excerpts. */
export function renderEvidenceMarkdown(bundle: EvidenceBundle): string {
  const rows = bundle.items
    .map((i) => {
      const grade = i.grade ?? "MISSING";
      const reason = i.reason ?? "No grade reason recorded.";
      const extra = i.excerpt ? ` — \`${i.excerpt.slice(0, 120).replace(/\n/g, " ")}\`` : i.note ? ` — ${i.note}` : "";
      return `| ${i.label} | ${ICON[i.status]} ${i.status} | ${grade} | \`${i.ref}\`${extra} — ${reason} |`;
    })
    .join("\n");
  return [
    `### Evidence — ${bundle.decisionId} (\`${bundle.file}\`)`,
    ``,
    `${ICON.present} ${bundle.present} present · ${ICON.missing} ${bundle.missing} missing`,
    ``,
    `| Item | Status | Grade | Ref |`,
    `| --- | --- | --- | --- |`,
    rows,
    ``,
  ].join("\n");
}

/** Queue-level markdown: one section per decision. */
export function renderQueueEvidenceMarkdown(bundles: EvidenceBundle[]): string {
  if (bundles.length === 0) return `## Evidence\n\nNo decisions — nothing to evidence.\n`;
  return [`## Evidence (${bundles.length})`, ``, ...bundles.map((b) => renderEvidenceMarkdown(b))].join("\n");
}
