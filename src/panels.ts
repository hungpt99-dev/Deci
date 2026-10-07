// US-012: Activity Bar view models + review history. Pure, local, no I/O,
// no LLM, no backend. VS Code/CLI are thin adapters: core builds immutable
// node lists, the host renders them via TreeDataProviders + webviews.

import type { AlternativeSet } from "./alternatives.js";
import type { DecisionPoint } from "./decisions.js";
import type { EvidenceBundle } from "./evidence.js";
import type { ReviewMap } from "./reviewMap.js";

export type PanelViewId =
  | "changepilot.review"
  | "changepilot.decisions"
  | "changepilot.alternatives"
  | "changepilot.evidence"
  | "changepilot.history";

export interface PanelViewDef {
  id: PanelViewId;
  title: string;
}

export const PANEL_VIEWS: PanelViewDef[] = [
  { id: "changepilot.review", title: "Review" },
  { id: "changepilot.decisions", title: "Decisions" },
  { id: "changepilot.alternatives", title: "Alternatives" },
  { id: "changepilot.evidence", title: "Evidence" },
  { id: "changepilot.history", title: "History" },
];

export interface PanelNode {
  label: string;
  detail?: string;
  command?: string;
  args?: unknown[];
}

const node = (label: string, detail?: string, command?: string, args?: unknown[]): PanelNode =>
  detail === undefined && command === undefined ? { label } : { label, detail, command, args };

/** Review view: risk buckets + top files. Empty map → placeholder node. */
export function buildReviewNodes(map: ReviewMap): PanelNode[] {
  const d = map.riskDistribution;
  const head = node(
    `${map.totalLoc} LOC · ${map.files.length} files · ${map.modules.length} modules`,
    `Critical ${d.Critical.files} · High ${d.High.files} · Medium ${d.Medium.files} · Low ${d.Low.files} · Verified ${d.Verified.files}`,
    "changepilot.showReviewMap",
  );
  if (map.files.length === 0) return [head, node("No changes — diff is empty.")];
  const top = map.files
    .slice()
    .sort((a, b) => b.added + b.removed - (a.added + a.removed))
    .slice(0, 10)
    .map((f) => node(`${f.path} (+${f.added}/-${f.removed})`, f.risk, "changepilot.showReviewMap"));
  return [head, ...top];
}

/** Decisions view: one node per ranked decision, or placeholder. */
export function buildDecisionNodes(queue: DecisionPoint[]): PanelNode[] {
  if (queue.length === 0) return [node("No decisions — nothing consequential found.")];
  return queue.map((d) =>
    node(`${d.severity} · ${d.findingType}`, `${d.file} · ${d.status}`, "changepilot.showDecisions"),
  );
}

/** Alternatives view: A/B/C options for a rejected set, or placeholder. */
export function buildAlternativeNodes(set: AlternativeSet | null): PanelNode[] {
  if (!set) return [node("No alternatives — reject a decision with a constraint first.")];
  return set.options.map((o) =>
    node(
      `${o.label}: ${o.title}`,
      `${o.complexity} · ${o.changeSize} · +${o.locAdded}/-${o.locRemoved}`,
      "changepilot.showAlternatives",
      [set.decisionId, o.id],
    ),
  );
}

/** Evidence view: per-decision present/missing counts, or placeholder. */
export function buildEvidenceNodes(bundles: EvidenceBundle[]): PanelNode[] {
  if (bundles.length === 0) return [node("No evidence — run analysis first.")];
  return bundles.map((b) =>
    node(`${b.decisionId}`, `${b.present}/${b.items.length} present`, "changepilot.showEvidence"),
  );
}

export interface HistoryEntry {
  id: string;
  at: string;
  label: string;
  loc: number;
  files: number;
  risk: string;
  decisions: number;
  pendingCriticalHigh: number;
}

export function historyEntryFor(
  label: string,
  map: ReviewMap,
  queue: DecisionPoint[],
  at: string = new Date().toISOString(),
): HistoryEntry {
  const pending = queue.filter((d) => d.status === "pending");
  const pch = pending.filter((d) => d.severity === "Critical" || d.severity === "High").length;
  const top: Record<string, number> = {};
  for (const d of pending) top[d.severity] = (top[d.severity] ?? 0) + 1;
  const risk = top["Critical"] ? "Critical" : top["High"] ? "High" : pending.length > 0 ? "Medium" : "Low";
  return {
    id: `${at}:${label}`,
    at,
    label,
    loc: map.totalLoc,
    files: map.files.length,
    risk,
    decisions: queue.length,
    pendingCriticalHigh: pch,
  };
}

/** Immutable append, newest last, capped (default 20). Zero I/O. */
export function appendHistory(entries: HistoryEntry[], entry: HistoryEntry, cap = 20): HistoryEntry[] {
  const next = [...entries, entry];
  return next.length > cap ? next.slice(next.length - cap) : next;
}

export function buildHistoryNodes(entries: HistoryEntry[]): PanelNode[] {
  if (entries.length === 0) return [node("No reviews yet — run ChangePilot analysis first.")];
  return entries
    .slice()
    .reverse()
    .map((e) =>
      node(`${e.label} · ${e.risk}`, `${e.loc} LOC · ${e.files} files · ${e.decisions} decisions`, "changepilot.showHistory"),
    );
}

export function renderHistoryMarkdown(entries: HistoryEntry[]): string {
  if (entries.length === 0) return "## History\n\nNo reviews yet.\n";
  const rows = entries
    .slice()
    .reverse()
    .map((e) => `| ${e.at} | ${e.label} | ${e.loc} | ${e.files} | ${e.risk} | ${e.decisions} | ${e.pendingCriticalHigh} |`)
    .join("\n");
  return `## History\n\n| When | Review | LOC | Files | Risk | Decisions | Pending Crit/High |\n| --- | --- | --- | --- | --- | --- | --- |\n${rows}\n`;
}
