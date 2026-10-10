// Change overview: what changed, why (documented vs inferred), and what is
// still unknown. Pure, local, no LLM.
//
// The documented/inferred split is load-bearing: a ticket excerpt is a
// requirement; everything else is the tool's reading of the diff and is
// labeled as such.

import { overallRiskFor, type OverallRisk } from "./bundle.js";
import type { DecisionPoint } from "./decisions.js";
import type { EvidenceBundle } from "./evidence.js";
import type { ImpactMap } from "./impact.js";
import type { ReviewMap } from "./reviewMap.js";
import type { ChangedSymbol } from "./symbols.js";
import type { TicketInput } from "./evidence.js";
import type { VerifyReport } from "./verify.js";

export interface BehaviorDelta {
  file: string;
  line: number | null;
  before: string;
  after: string;
}

export interface ChangeOverview {
  purpose: string;
  purposeSource: "documented" | "inferred";
  purposeRef: string | null;
  behaviors: BehaviorDelta[];
  affectedSymbols: ChangedSymbol[];
  affectedComponents: string[];
  risk: OverallRisk;
  riskReason: string;
  /** Missing evidence and unresolved questions — never silently omitted. */
  unknowns: string[];
}

const MAX_BEHAVIORS = 8;
const MAX_SYMBOLS = 12;

function documentedPurpose(ticket: TicketInput, designDoc: TicketInput): { text: string; ref: string | null } | null {
  // Local file content wins; inline text is second choice. Unreachable refs
  // are unknown, not purpose.
  const doc = designDoc.text ?? ticket.text;
  const ref = designDoc.text ? designDoc.ref : ticket.text ? ticket.ref : null;
  if (!doc) return null;
  return { text: doc.trim().slice(0, 400), ref };
}

function inferredPurpose(queue: DecisionPoint[], map: ReviewMap): string {
  if (queue.length === 0) return "No consequential behavior detected in this change.";
  const byType = new Map<string, number>();
  for (const d of queue) byType.set(d.findingType, (byType.get(d.findingType) ?? 0) + 1);
  const top = [...byType.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3)
    .map(([t, n]) => `${t} (${n})`).join(", ");
  const where = map.modules.length > 0 ? ` in ${map.modules.slice(0, 4).join(", ")}` : "";
  return `Inferred from the diff (no requirement provided): ${queue.length} finding(s) — ${top}${where}. Confirm against the author's intent.`;
}

/** Queue + repo context → overview. Pure. */
export function buildOverview(
  queue: DecisionPoint[],
  map: ReviewMap,
  symbols: ChangedSymbol[],
  impact: ImpactMap,
  ticket: TicketInput,
  designDoc: TicketInput,
  evidence: EvidenceBundle[],
  report: VerifyReport | null,
): ChangeOverview {
  const doc = documentedPurpose(ticket, designDoc);
  const { risk, reason } = overallRiskFor(queue, report);
  const behaviors: BehaviorDelta[] = queue.slice(0, MAX_BEHAVIORS).map((d) => ({
    file: d.file,
    line: d.line,
    before: d.before,
    after: d.after,
  }));
  const components = [...new Set([...map.modules, ...map.services, ...impact.directFiles])].sort();
  const unknowns: string[] = [];
  if (!doc) unknowns.push("No ticket or design doc provided — purpose is inferred from the diff, not verified against a requirement.");
  const missingFiles = [...new Set(
    evidence
      .filter((b) => b.items.some((i) => i.kind === "test" && i.status === "missing"))
      .map((b) => b.file),
  )];
  if (missingFiles.length > 0) {
    const refs = impact.testFiles.length > 0
      ? ` Referencing tests found via impact: ${impact.testFiles.slice(0, 3).map((t) => `\`${t}\``).join(", ")} — confirm they cover the change.`
      : "";
    unknowns.push(`No sibling test at the expected path for ${missingFiles.length} changed file(s): ${missingFiles.slice(0, 3).map((f) => `\`${f}\``).join(", ")}${missingFiles.length > 3 ? " …" : ""}.${refs}`);
  }
  const missingTicket = evidence.some((b) => b.items.some((i) => i.kind === "ticket" && i.status === "missing"));
  if (missingTicket && doc) unknowns.push("Ticket evidence is missing for some findings despite a provided reference — coverage is partial.");
  unknowns.push(...impact.unresolved);
  if (queue.some((d) => d.uncertain))
    unknowns.push("Some findings are heuristic matches (confidence < 0.6) — they mark where to look, not what is true.");
  return {
    purpose: doc?.text ?? inferredPurpose(queue, map),
    purposeSource: doc ? "documented" : "inferred",
    purposeRef: doc?.ref ?? null,
    behaviors,
    affectedSymbols: symbols.slice(0, MAX_SYMBOLS),
    affectedComponents: components,
    risk,
    riskReason: reason,
    unknowns,
  };
}

export function renderOverviewMarkdown(o: ChangeOverview): string {
  const tag = o.purposeSource === "documented" ? "documented requirement" : "inferred — not verified";
  const syms = o.affectedSymbols.length
    ? o.affectedSymbols.map((s) => `- \`${s.name}\` (${s.kind}, ${s.change}) — \`${s.file}${s.line ? `:${s.line}` : ""}\``).join("\n")
    : `No declarations detected — file-level analysis only.`;
  const deltas = o.behaviors.length
    ? o.behaviors.map((b) => {
      const where = b.line ? `\`${b.file}:${b.line}\`` : `\`${b.file}\``;
      const arrow = b.before ? `\`${b.before}\` → \`${b.after}\`` : `\`${b.after}\``;
      return `- ${where}: ${arrow}`;
    }).join("\n")
    : `No behavioral deltas.`;
  return [
    `## Change overview`,
    ``,
    `Purpose (${tag})${o.purposeRef ? ` — ${o.purposeRef}` : ""}: ${o.purpose}`,
    ``,
    `Risk: **${o.risk}** — ${o.riskReason}`,
    ``,
    `Affected components: ${o.affectedComponents.length ? o.affectedComponents.map((c) => `\`${c}\``).join(", ") : "—"}`,
    ``,
    `Changed symbols:`,
    syms,
    ``,
    `Behavioral differences:`,
    deltas,
    ``,
    o.unknowns.length ? `Unknowns / missing evidence:` : `No unknowns — all evidence present.`,
    ...o.unknowns.map((u) => `- ${u}`),
    ``,
  ].join("\n");
}
