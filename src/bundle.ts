// US-008: Full output bundle (impact / risk / test plan / rollback).
// Pure, local, no I/O, no LLM. Every analysis composes the same four
// sections from ReviewMap + decision queue + verify report (+ optional
// evidence). Rollback is text only: this module exposes no exec, no fs
// writes, no revert runner — MVP never auto-reverts.

import { guessTestPath, type DecisionPoint } from "./decisions.js";
import type { EvidenceBundle } from "./evidence.js";
import type { ReviewMap } from "./reviewMap.js";
import type { VerifyReport } from "./verify.js";

export type OverallRisk = "Critical" | "High" | "Medium" | "Low";

export interface ImpactSummary {
  totalLoc: number;
  fileCount: number;
  modules: string[];
  services: string[];
  topFiles: string[];
  totalDecisions: number;
  pending: number;
  pendingCriticalHigh: number;
  verifyNote: string;
}

export interface TestPlan {
  /** What already ran (one line per verify check). */
  ran: string[];
  /** What to add (one line per gap, deterministic from queue/evidence). */
  toAdd: string[];
}

export interface RollbackPlan {
  /** Ordered manual steps, text only. Never executed by ChangePilot. */
  steps: string[];
}

export interface OutputBundle {
  impact: ImpactSummary;
  risk: OverallRisk;
  riskReason: string;
  testPlan: TestPlan;
  rollback: RollbackPlan;
  generatedAt: string;
}

const MIGRATION_RE = /migrat|schema\.sql|schema\.prisma|\.sql$|flyway|liquibase|drizzle\/|prisma\/|typeorm/i;
const CONTRACT_RE = /\.proto$|openapi|swagger|schema\.(graphql|json)$|\.graphql$/i;

function topFilesOf(map: ReviewMap, cap = 5): string[] {
  return map.files
    .slice()
    .sort((a, b) => b.added + b.removed - (a.added + a.removed))
    .slice(0, cap)
    .map((f) => f.path);
}

/**
 * Pure: overall risk from pending queue first, verify failures second.
 * Decided (accepted/rejected/investigating) decisions do not raise risk —
 * only work still awaiting a human does. Empty queue + green verify → Low.
 */
export function overallRiskFor(
  queue: DecisionPoint[],
  report: VerifyReport | null,
): { risk: OverallRisk; reason: string } {
  const pending = queue.filter((d) => d.status === "pending");
  const crit = pending.filter((d) => d.severity === "Critical").length;
  const high = pending.filter((d) => d.severity === "High").length;
  const med = pending.filter((d) => d.severity === "Medium").length;
  const failed = report?.failed ?? 0;
  if (crit > 0)
    return { risk: "Critical", reason: `${crit} pending Critical decision(s) need a human.` };
  if (high > 0 || failed > 0)
    return {
      risk: "High",
      reason:
        high > 0
          ? `${high} pending High decision(s) need a human.`
          : `${failed} verify check(s) failing — stays in human review.`,
    };
  if (med > 0) return { risk: "Medium", reason: `${med} pending Medium decision(s); no Critical/High open.` };
  if (queue.length === 0)
    return {
      risk: report && !report.allPass ? "High" : "Low",
      reason:
        report && !report.allPass
          ? `${report.failed} verify check(s) failing — stays in human review.`
          : "No consequential decisions detected.",
    };
  return { risk: "Low", reason: "No pending Critical/High/Medium decisions." };
}

/** Pure: one-line impact summary from map + queue + verify outcome. */
export function buildImpactSummary(
  map: ReviewMap,
  queue: DecisionPoint[],
  report: VerifyReport | null,
): ImpactSummary {
  const pending = queue.filter((d) => d.status === "pending").length;
  const pendingCriticalHigh = queue.filter(
    (d) => d.status === "pending" && (d.severity === "Critical" || d.severity === "High"),
  ).length;
  const verifyNote = !report
    ? "Verify not run in this surface — run CLI `analyze --verify` for shell checks."
    : report.allPass
      ? `${report.passed} check(s) green, ${report.skipped} skipped.`
      : `${report.failed} check(s) failing — affected code stays in human review.`;
  return {
    totalLoc: map.totalLoc,
    fileCount: map.fileCount,
    modules: map.modules,
    services: map.services,
    topFiles: topFilesOf(map),
    totalDecisions: queue.length,
    pending,
    pendingCriticalHigh,
    verifyNote,
  };
}

function ranLines(report: VerifyReport | null): string[] {
  if (!report) return ["Verify not run in this surface — no checks executed here."];
  if (report.checks.length === 0) return ["No checks applied — empty diff, nothing to verify."];
  const icon = { pass: "✓", fail: "✗", skip: "○" } as const;
  return report.checks.map((c) => `${icon[c.status]} ${c.label} (${c.status}) — ${c.detail}`);
}

/**
 * Pure: deterministic "what to add" from queue (+ evidence when supplied).
 * Rules: every pending Critical/High decision wants a regression test for
 * its file; contract findings want a consumer/contract test; data-model /
 * consistency findings want a migration/rollback test. Evidence bundles
 * narrow it: only flag files whose test item is missing.
 */
export function buildTestPlan(
  queue: DecisionPoint[],
  report: VerifyReport | null,
  evidence: EvidenceBundle[] = [],
): TestPlan {
  const missingTest = new Set(
    evidence
      .filter((b) => b.items.some((i) => i.kind === "test" && i.status === "missing"))
      .map((b) => b.file),
  );
  const useEvidence = evidence.length > 0;
  const toAdd: string[] = [];
  for (const d of queue) {
    if (d.status !== "pending") continue;
    if (d.severity !== "Critical" && d.severity !== "High") continue;
    if (useEvidence && !missingTest.has(d.file)) continue;
    toAdd.push(
      `Add regression test for \`${d.file}\` covering ${d.findingType} (${guessTestPath(d.file)}).`,
    );
    if (d.findingType === "API_CONTRACT_DECISION")
      toAdd.push(`Add consumer/contract test for the changed surface in \`${d.file}\`.`);
    if (d.findingType === "DATA_MODEL_DECISION" || d.findingType === "CONSISTENCY_DECISION")
      toAdd.push(`Add migration up/down test for the schema/tx change in \`${d.file}\`.`);
  }
  if (report && !report.allPass)
    toAdd.push("Fix failing verify checks first, then re-run full verify before merging.");
  if (toAdd.length === 0)
    toAdd.push("No additional tests suggested — pending Critical/High queue is clear.");
  return { ran: ranLines(report), toAdd: [...new Set(toAdd)] };
}

/**
 * Pure: ordered manual rollback steps, text only. Detects migrations and
 * contract surface from changed paths; always ends with re-verify. Never
 * executes anything — there is intentionally no runner for these steps.
 */
export function buildRollbackPlan(changedFiles: string[]): RollbackPlan {
  const steps: string[] = [];
  if (changedFiles.length === 0) return { steps: ["No changes — nothing to roll back."] };
  const files = [...new Set(changedFiles)].sort();
  const migrations = files.filter((p) => MIGRATION_RE.test(p));
  const contracts = files.filter((p) => CONTRACT_RE.test(p));
  const code = files.filter((p) => !MIGRATION_RE.test(p) && !CONTRACT_RE.test(p));
  steps.push(`Revert code change (${files.length} file(s)): \`git revert <commit>\` or \`git checkout <base> -- ${code.slice(0, 3).join(" ") || files.slice(0, 3).join(" ")}${files.length > 3 ? " …" : ""}\`.`);
  if (migrations.length > 0)
    steps.push(
      `Re-run migration down for ${migrations.slice(0, 3).join(", ")}${migrations.length > 3 ? " …" : ""} (e.g. \`npx prisma migrate resolve\` / \`./gradlew flywayUndo\` per project), then verify schema version.`,
    );
  if (contracts.length > 0)
    steps.push(
      `Republish previous contract for ${contracts.slice(0, 3).join(", ")}${contracts.length > 3 ? " …" : ""} and notify consumers before redeploy.`,
    );
  steps.push("Re-run full verify (build + unit tests + lint) on the rolled-back tree before merging.");
  steps.push("Manual steps only — ChangePilot never auto-reverts in MVP.");
  return { steps };
}

/** Pure: the full F7 bundle. Changed files default to queue files. */
export function buildOutputBundle(
  map: ReviewMap,
  queue: DecisionPoint[],
  report: VerifyReport | null,
  opts: { evidence?: EvidenceBundle[]; changedFiles?: string[] } = {},
): OutputBundle {
  const { risk, reason } = overallRiskFor(queue, report);
  return {
    impact: buildImpactSummary(map, queue, report),
    risk,
    riskReason: reason,
    testPlan: buildTestPlan(queue, report, opts.evidence ?? []),
    rollback: buildRollbackPlan(opts.changedFiles ?? [...new Set(queue.map((d) => d.file))]),
    generatedAt: new Date().toISOString(),
  };
}

/** Markdown bundle: impact + risk + test plan + rollback (text only). */
export function renderBundleMarkdown(b: OutputBundle): string {
  const i = b.impact;
  const ran = b.testPlan.ran.map((l) => `- ${l}`).join("\n");
  const add = b.testPlan.toAdd.map((l) => `- ${l}`).join("\n");
  const steps = b.rollback.steps.map((s, n) => `${n + 1}. ${s}`).join("\n");
  return [
    `## Impact summary`,
    ``,
    `${i.totalLoc} LOC across ${i.fileCount} file(s) · ${i.modules.length} module(s) · ${i.services.length} service(s).`,
    i.topFiles.length ? `Largest: ${i.topFiles.map((f) => `\`${f}\``).join(", ")}.` : `No changes.`,
    `${i.totalDecisions} decision(s), ${i.pending} pending (${i.pendingCriticalHigh} Critical/High). ${i.verifyNote}`,
    ``,
    `## Risk classification: ${b.risk}`,
    ``,
    `${b.riskReason}`,
    ``,
    `## Test plan`,
    ``,
    `What ran:`,
    ran,
    ``,
    `What to add:`,
    add,
    ``,
    `## Rollback plan (text only — manual steps, no auto-revert)`,
    ``,
    steps,
    ``,
  ].join("\n");
}
