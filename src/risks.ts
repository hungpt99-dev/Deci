// Risk findings: decisions → inspectable 10-field assessments.
// Pure, local, no LLM. Templates are deterministic per finding type;
// anything not backed by evidence is labeled hypothesis, never fact.
//
// Standing rule (documented, not buried):
// - confirmed: a failing verification check names this file.
// - hypothesis: the underlying rule match is uncertain (confidence < 0.6).
// - potential: everything else (deterministic pattern, unverified outcome).

import { guessTestPath, type DecisionPoint } from "./decisions.js";
import type { EvidenceBundle } from "./evidence.js";
import type { ImpactMap } from "./impact.js";
import type { VerifyReport } from "./verify.js";

export type RiskStanding = "confirmed" | "potential" | "hypothesis";
export type ClaimKind = "fact" | "inference" | "hypothesis" | "unknown";

export interface RiskEvidence {
  label: string;
  ref: string;
  detail?: string;
}

export interface RiskFinding {
  id: string;
  title: string;
  severity: DecisionPoint["severity"];
  file: string;
  line: number | null;
  standing: RiskStanding;
  /** Epistemic status of the risk claim itself. */
  claim: ClaimKind;
  current: string;
  consequence: string;
  scenario: string;
  evidence: RiskEvidence[];
  confidence: number;
  confidenceMeaning: string;
  mitigation: string;
  suggestedTest: string;
}

const CONFIDENCE_MEANINGS: Array<[number, string]> = [
  [0.85, "Strong pattern match — the changed lines closely fit a known risk shape. Still a heuristic, not a proof."],
  [0.6, "Moderate pattern match — plausible concern, worth a focused look."],
  [0, "Weak signal — surfaced only because the file changed. Treat as a prompt to look, not a claim of risk."],
];

export function confidenceMeaning(confidence: number): string {
  for (const [min, text] of CONFIDENCE_MEANINGS) if (confidence >= min) return text;
  return CONFIDENCE_MEANINGS[CONFIDENCE_MEANINGS.length - 1]?.[1] as string;
}

interface Template {
  title: string;
  consequence: string;
  scenario: string;
  mitigation: string;
  test: string;
}

const FALLBACK: Template = {
  title: "Unclassified behavior change",
  consequence: "Behavior may differ from what callers assume.",
  scenario: "A caller depends on the old behavior; after this change it silently gets the new behavior and misbehaves downstream.",
  mitigation: "Have the change author state the intended behavior; review callers for assumptions about it.",
  test: "Add a characterization test pinning the new behavior at the changed lines.",
};

const TEMPLATES: Record<string, Template> = {
  SECURITY_DECISION: {
    title: "Authorization / credential boundary changed",
    consequence: "Requests that were previously allowed (or denied) may now be treated differently; secrets may be exposed.",
    scenario: "A non-privileged caller reaches the changed code path and gains access that the old check would have denied — or a legit caller is locked out.",
    mitigation: "Deny by default at the boundary; re-run the auth matrix (allowed + denied roles) before merging.",
    test: "Add allow/deny tests for each role against the changed path.",
  },
  DATA_MODEL_DECISION: {
    title: "Schema or migration changed",
    consequence: "Deploys may fail or existing rows may violate the new shape; rollback needs a down path.",
    scenario: "The migration runs against a production-like dataset and fails midway (or succeeds but old code reads new rows), leaving the schema half-applied.",
    mitigation: "Backward-compatible migration (add nullable → backfill → constrain) with a tested down migration.",
    test: "Add migration up/down test on a production-like fixture.",
  },
  CONSISTENCY_DECISION: {
    title: "Transaction / consistency boundary changed",
    consequence: "Work previously atomic may now partially commit; retries may duplicate effects.",
    scenario: "The process crashes between the two halves of the formerly atomic unit; on retry, the first half executes twice.",
    mitigation: "Narrow the atomic unit deliberately or add idempotency keys; never assume the caller retries safely.",
    test: "Add a crash-between-steps / duplicate-delivery test asserting exactly-once effect.",
  },
  API_CONTRACT_DECISION: {
    title: "API contract surface changed",
    consequence: "Consumers compiled against the old shape may break at runtime or silently misread responses.",
    scenario: "A downstream consumer sends the old payload; the renamed/removed field is ignored and the request is processed with wrong defaults.",
    mitigation: "Extend additively (never break) or version the boundary; notify consumers before redeploy.",
    test: "Add a consumer/contract test asserting the old shape still works.",
  },
  DEPENDENCY_DECISION: {
    title: "Dependency set changed",
    consequence: "New transitive code runs with the service's privileges; version drift may alter behavior.",
    scenario: "The new dependency pulls a compromised or breaking transitive update; the failure surfaces far from this diff.",
    mitigation: "Pin the version, review the transitive tree, and prefer well-maintained packages.",
    test: "Add a lockfile/diff review check; smoke-test startup with the new tree.",
  },
  BUSINESS_RULE_DECISION: {
    title: "Business rule changed",
    consequence: "Eligibility, pricing, or workflow outcomes differ from the documented requirement.",
    scenario: "A case the ticket explicitly covers now takes the other branch; the discrepancy reaches production because no test pins the rule.",
    mitigation: "Quote the ticket requirement in the change; verify each branch against it.",
    test: "Add a table-driven test with one row per requirement case.",
  },
  RELIABILITY_DECISION: {
    title: "Retry / timeout / failure handling changed",
    consequence: "Transient faults may now cascade (retry storms) or operations may hang past caller deadlines.",
    scenario: "The downstream dependency slows down; unbounded retries multiply load and turn a blip into an outage.",
    mitigation: "Cap attempts with backoff + jitter; fail fast past the caller's deadline.",
    test: "Add a fault-injection test (slow/flaky downstream) asserting bounded attempts.",
  },
  PERFORMANCE_DECISION: {
    title: "Caching / concurrency changed",
    consequence: "Contention, stale reads, or N+1 queries may appear under load but not in unit tests.",
    scenario: "Under concurrent load the new shared path serializes (or serves stale data within the TTL) and p99 latency regresses.",
    mitigation: "Bound the cache with TTL + invalidation, or batch instead of caching; load-test the hot path.",
    test: "Add a concurrency/burst test asserting latency and freshness bounds.",
  },
  ARCHITECTURE_DECISION: {
    title: "Module / service boundary changed",
    consequence: "Coupling shifts; a future change in one side silently breaks the other.",
    scenario: "A second team edits the shared boundary assuming the old ownership; both sides compile but the runtime contract is violated.",
    mitigation: "Keep the boundary narrow and owned by one side; document the contract.",
    test: "Add a boundary test asserting what each side may import/call.",
  },
  BEHAVIOR_CHANGE: {
    title: "Behavior change under review",
    consequence: "Callers may rely on the previous behavior.",
    scenario: "An existing caller exercises the old path in production; the new behavior breaks its assumption without any compile error.",
    mitigation: "Identify the callers (see Impact) and confirm the new behavior with each owner.",
    test: "Add a regression test covering the old vs new behavior at the changed lines.",
  },
};

/** Files named by failing verify checks (currently: api-schema lists contract paths). */
export function failingFilesFor(report: VerifyReport | null): string[] {
  if (!report) return [];
  const out = new Set<string>();
  for (const c of report.checks) {
    if (c.status !== "fail" || c.id !== "api-schema") continue;
    for (const line of c.output.split("\n")) {
      const p = line.trim();
      if (p) out.add(p);
    }
  }
  return [...out];
}

function testMissingFor(file: string, evidence: EvidenceBundle[]): boolean {
  const b = evidence.find((e) => e.file === file);
  return !!b?.items.some((i) => i.kind === "test" && i.status === "missing");
}

/** Queue → ordered risk findings (severity rank preserved from the queue). */
export function buildRiskFindings(
  queue: DecisionPoint[],
  opts: { evidence?: EvidenceBundle[]; impact?: ImpactMap; report?: VerifyReport | null } = {},
): RiskFinding[] {
  const evidence = opts.evidence ?? [];
  const failing = new Set(failingFilesFor(opts.report ?? null));
  return queue.map((d) => {
    const t = TEMPLATES[d.findingType] ?? FALLBACK;
    const standing: RiskStanding = failing.has(d.file)
      ? "confirmed"
      : d.uncertain
        ? "hypothesis"
        : "potential";
    const claim: ClaimKind = standing === "confirmed" ? "fact" : standing === "potential" ? "inference" : "hypothesis";
    // Downstream files affected by this decision's change (edges fan out
    // from the changed file). These are observed references, not guesses.
    const downstream = opts.impact?.edges.filter((e) => e.fromFile === d.file) ?? [];
    const testMissing = testMissingFor(d.file, evidence);
    const ev: RiskEvidence[] = [
      ...d.evidenceLinks.map((l) => ({ label: l.label, ref: l.ref })),
      ...downstream.slice(0, 3).map((e) => ({
        label: e.depth === "direct" ? "referenced-by" : "indirect-via",
        ref: `${e.toFile}:${e.toLine}`,
        detail: e.excerpt,
      })),
    ];
    const affected = downstream.length > 0 ? ` Traced impact: ${downstream.length} downstream file(s) reference this change.` : "";
    return {
      id: d.id,
      title: t.title,
      severity: d.severity,
      file: d.file,
      line: d.line,
      standing,
      claim,
      current: d.before ? `Before: \`${d.before}\` → After: \`${d.after}\`` : `Change: \`${d.after}\``,
      consequence: t.consequence + affected,
      scenario: t.scenario,
      evidence: ev,
      confidence: d.confidence,
      confidenceMeaning: confidenceMeaning(d.confidence),
      mitigation: t.mitigation,
      suggestedTest: testMissing
        ? `No sibling test found — add one at \`${guessTestPath(d.file)}\`: ${t.test}`
        : t.test,
    };
  }).map((r) => ({
    ...r,
    // Surface the analyzed location in the title-adjacent evidence when present.
    evidence: r.line ? [{ label: "location", ref: `${r.file}:${r.line}` }, ...r.evidence] : r.evidence,
  }));
}

/** Compact CLI markdown: one card per finding, location-linked. */
export function renderRisksMarkdown(risks: RiskFinding[]): string {
  if (risks.length === 0) return `## Risks\n\nNo risk findings — nothing consequential detected.\n`;
  const badge = { confirmed: "CONFIRMED", potential: "RISK", hypothesis: "HYPOTHESIS" } as const;
  const cards = risks.map((r, i) => {
    const where = r.line ? `\`${r.file}:${r.line}\`` : `\`${r.file}\``;
    return [
      `### ${i + 1}. [${r.severity}] ${r.title} — ${badge[r.standing]}`,
      ``,
      `Location: ${where} · Claim: ${r.claim} · Confidence ${r.confidence.toFixed(2)} — ${r.confidenceMeaning}`,
      ``,
      `Current: ${r.current}`,
      ``,
      `Consequence: ${r.consequence}`,
      ``,
      `Failure scenario: ${r.scenario}`,
      ``,
      `Mitigation: ${r.mitigation}`,
      ``,
      `Suggested test: ${r.suggestedTest}`,
      ``,
    ].join("\n");
  });
  return [`## Risks (${risks.length})`, ``, ...cards].join("\n");
}
