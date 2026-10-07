// US-004: Ranked human decision queue. Pure, local, no I/O, no LLM.
// Semantic findings in → severity-ranked queue out. State transitions are
// immutable; VS Code/CLI are thin adapters over these helpers.

import type { SemanticFinding } from "./semantic.js";

export type Severity = "Critical" | "High" | "Medium" | "Low";
export type DecisionStatus = "pending" | "accepted" | "rejected" | "investigating";

export type RejectReason =
  | "wrong-architecture"
  | "wrong-business"
  | "wrong-security"
  | "wrong-performance"
  | "too-complex"
  | "requirement-mismatch"
  | "other";

export const REJECT_REASONS: RejectReason[] = [
  "wrong-architecture",
  "wrong-business",
  "wrong-security",
  "wrong-performance",
  "too-complex",
  "requirement-mismatch",
  "other",
];

export interface EvidenceLink {
  label: string;
  ref: string;
}

export interface DecisionPoint {
  id: string;
  severity: Severity;
  status: DecisionStatus;
  file: string;
  language: string;
  findingType: string;
  category: string;
  impact: string;
  confidence: number;
  uncertain: boolean;
  before: string;
  after: string;
  evidenceLinks: EvidenceLink[];
  rejectReason?: RejectReason;
  /** Free-text constraint from Reject, e.g. "payment must remain strongly consistent". */
  constraint?: string;
  decidedAt?: string;
}

/** Deterministic finding-type → severity. Uncertain findings keep severity, flagged via `uncertain`. */
export function severityFor(type: string): Severity {
  switch (type) {
    case "SECURITY_DECISION":
    case "DATA_MODEL_DECISION":
    case "CONSISTENCY_DECISION":
      return "Critical";
    case "RELIABILITY_DECISION":
    case "ARCHITECTURE_DECISION":
    case "API_CONTRACT_DECISION":
    case "DEPENDENCY_DECISION":
    case "BUSINESS_RULE_DECISION":
      return "High";
    case "PERFORMANCE_DECISION":
    case "BEHAVIOR_CHANGE":
      return "Medium";
    default:
      return "Medium";
  }
}

const SEVERITY_RANK: Record<Severity, number> = { Critical: 0, High: 1, Medium: 2, Low: 3 };

/** ponytail: sibling-test heuristic; real test-graph lookup lands in US-005. */
export function guessTestPath(path: string): string {
  if (/(\.test\.|\.spec\.|__tests__)/.test(path)) return path;
  const m = path.match(/^(.*)\.([^./]+)$/);
  return m ? `${m[1]}.test.${m[2]}` : `${path}.test`;
}

export function evidenceFor(file: string, id: string): EvidenceLink[] {
  return [
    { label: "file", ref: file },
    { label: "test", ref: guessTestPath(file) },
    { label: "finding", ref: `#${id}` },
  ];
}

function toDecision(f: SemanticFinding, n: number): DecisionPoint {
  const id = `D${n + 1} ${f.id}`;
  return {
    id,
    severity: severityFor(f.type),
    status: "pending",
    file: f.file,
    language: f.language,
    findingType: f.type,
    category: f.category,
    impact: f.impact,
    confidence: f.confidence,
    uncertain: f.uncertain,
    before: f.before,
    after: f.after,
    evidenceLinks: evidenceFor(f.file, f.id),
  };
}

/** Findings → severity-ranked queue (severity, then confidence desc). Pure. */
export function buildDecisions(findings: SemanticFinding[]): DecisionPoint[] {
  return findings
    .map(toDecision)
    .sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || b.confidence - a.confidence);
}

function update(queue: DecisionPoint[], id: string, patch: Partial<DecisionPoint>): DecisionPoint[] {
  let hit = false;
  const next = queue.map((d) => {
    if (d.id !== id) return d;
    hit = true;
    return { ...d, ...patch, decidedAt: new Date().toISOString() };
  });
  if (!hit) throw new Error(`unknown decision: ${id}`);
  return next;
}

export function acceptDecision(queue: DecisionPoint[], id: string): DecisionPoint[] {
  return update(queue, id, { status: "accepted", rejectReason: undefined, constraint: undefined });
}

export function investigateDecision(queue: DecisionPoint[], id: string): DecisionPoint[] {
  return update(queue, id, { status: "investigating", rejectReason: undefined, constraint: undefined });
}

/** Reject requires a reason plus a non-empty free-text constraint. Throws otherwise. */
export function rejectDecision(
  queue: DecisionPoint[],
  id: string,
  reason: RejectReason,
  constraint: string,
): DecisionPoint[] {
  if (!REJECT_REASONS.includes(reason)) throw new Error(`invalid reject reason: ${reason}`);
  if (!constraint.trim()) throw new Error("reject requires a free-text constraint");
  return update(queue, id, { status: "rejected", rejectReason: reason, constraint: constraint.trim() });
}

export interface DecisionSummary {
  total: number;
  pending: number;
  accepted: number;
  rejected: number;
  investigating: number;
  pendingCriticalHigh: number;
}

export function decisionSummary(queue: DecisionPoint[]): DecisionSummary {
  const s: DecisionSummary = {
    total: queue.length,
    pending: 0,
    accepted: 0,
    rejected: 0,
    investigating: 0,
    pendingCriticalHigh: 0,
  };
  for (const d of queue) {
    s[d.status === "pending" ? "pending" : d.status] += 1;
    if (d.status === "pending" && (d.severity === "Critical" || d.severity === "High"))
      s.pendingCriticalHigh += 1;
  }
  return s;
}

/** Panel/CLI markdown: ranked table with severity, confidence, evidence links, status. */
export function renderDecisionsMarkdown(queue: DecisionPoint[]): string {
  if (queue.length === 0) return `## Decisions\n\nNo decisions — nothing consequential detected.\n`;
  const rows = queue
    .map((d, i) => {
      const ev = d.evidenceLinks.map((e) => `[${e.label}](${e.ref})`).join(" ");
      const extra =
        d.status === "rejected" ? ` — rejected: ${d.rejectReason} / "${d.constraint}"` : "";
      return `| ${i + 1} | ${d.severity} | \`${d.file}\` | ${d.findingType} | ${d.confidence.toFixed(2)}${d.uncertain ? " ?" : ""} | ${d.status}${extra} | ${ev} |`;
    })
    .join("\n");
  return [
    `## Decisions (${queue.length})`,
    ``,
    `| # | Severity | File | Type | Conf | Status | Evidence |`,
    `| --- | --- | --- | --- | --- | --- | --- |`,
    rows,
    ``,
    `Actions: Accept / Reject (reason + constraint required) / Investigate — inline or in Decisions panel.`,
    ``,
  ].join("\n");
}

// --- Editor seam (gutter + hover). Pure; VS Code adapter renders these. ---

export const GUTTER_ICON: Record<Severity, string> = {
  Critical: "🔴",
  High: "🟠",
  Medium: "🟡",
  Low: "⚪",
};

export function gutterIconFor(severity: Severity): string {
  return GUTTER_ICON[severity];
}

export interface GutterMark {
  decisionId: string;
  file: string;
  line: number;
  severity: Severity;
  icon: string;
}

/**
 * Pure line mapping: caller supplies per-file 1-based line numbers
 * (e.g. first added-line of each finding's hunk). Missing file → line 1.
 */
export function gutterMarksFor(queue: DecisionPoint[], lineOfFile: (file: string) => number): GutterMark[] {
  return queue.map((d) => ({
    decisionId: d.id,
    file: d.file,
    line: Math.max(1, Math.floor(lineOfFile(d.file)) || 1),
    severity: d.severity,
    icon: gutterIconFor(d.severity),
  }));
}

/** Hover card markdown with Accept / Reject / Investigate command links. */
export function hoverMarkdownFor(d: DecisionPoint): string {
  const ev = d.evidenceLinks.map((e) => `- [${e.label}](${e.ref})`).join("\n");
  const cmd = (action: string) =>
    `command:deci.decision${action}?${encodeURIComponent(JSON.stringify([d.id]))}`;
  return [
    `**${d.severity}** ${d.findingType} — ${d.status}`,
    ``,
    `${d.impact}`,
    ``,
    `Confidence: **${d.confidence.toFixed(2)}**${d.uncertain ? " (uncertain — needs human look)" : ""}`,
    d.after ? `Change: \`${d.after.slice(0, 200)}\`` : ``,
    ``,
    `Evidence:`,
    ev,
    ``,
    `[Accept](${cmd("Accept")}) · [Reject…](${cmd("Reject")}) · [Investigate](${cmd("Investigate")})`,
    ``,
  ].join("\n");
}
