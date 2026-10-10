// End-to-end: three fixture changes through the real analysis engine.
// Safe → no Critical/High. Regression → caller traced with evidence.
// Uncertain → hypothesis standing with disclosed unknowns.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { existsSync, lstatSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildReviewMap, parseUnifiedDiff } from "./reviewMap.js";
import { analyzeSemantics, parseFileHunks } from "./semantic.js";
import { buildDecisions, decisionSummary } from "./decisions.js";
import { collectQueueEvidence, emptyContext } from "./evidence.js";
import { symbolsForHunks } from "./symbols.js";
import { buildImpactMap, type ImpactIo } from "./impact.js";
import { buildRiskFindings } from "./risks.js";
import { buildOverview } from "./overview.js";
import { buildOutputBundle } from "./bundle.js";
import { buildReportHtml, type AnalysisSnapshot } from "./report.js";
import type { TicketInput } from "./evidence.js";

const SHOP = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "shop");
const noTicket: TicketInput = { text: null, unreachable: false, ref: null };

function walk(root: string, out: string[] = []): string[] {
  for (const e of readdirSync(root)) {
    const p = join(root, e);
    if (lstatSync(p).isSymbolicLink()) continue;
    if (statSync(p).isDirectory()) {
      if (e === "node_modules" || e === ".git" || e === "dist") continue;
      walk(p, out);
    } else out.push(p);
  }
  return out;
}

const fsIo: ImpactIo = {
  listFiles: (root) => (existsSync(root) && statSync(root).isDirectory() ? walk(root) : null),
  read: (p) => readFileSync(p, "utf8"),
};

function analyze(name: string): { snap: AnalysisSnapshot; diff: string } {
  const diff = readFileSync(join(SHOP, name), "utf8");
  const map = buildReviewMap(diff);
  const queue = buildDecisions(analyzeSemantics(diff));
  const changed = parseUnifiedDiff(diff).map((f) => f.path);
  const symbols = symbolsForHunks(parseFileHunks(diff));
  const impact = buildImpactMap(symbols, changed, fsIo, SHOP);
  const evidence = collectQueueEvidence(queue, emptyContext({ changedFiles: changed }));
  const risks = buildRiskFindings(queue, { evidence, impact, report: null });
  const bundle = buildOutputBundle(map, queue, null, { evidence, changedFiles: changed });
  const overview = buildOverview(queue, map, symbols, impact, noTicket, noTicket, evidence, null);
  const snap: AnalysisSnapshot = {
    revision: { ref: name, sha: null, dirty: false, analyzedAt: new Date().toISOString() },
    diffText: diff,
    map,
    queue,
    symbols,
    impact,
    risks,
    overview,
    evidence,
    testPlan: bundle.testPlan,
  };
  return { snap, diff };
}

describe("fixtures", () => {
  it("safe refactor: no Critical/High, symbols extracted", () => {
    const { snap } = analyze("safe.diff");
    assert.ok(snap.queue.length > 0);
    assert.equal(decisionSummary(snap.queue).pendingCriticalHigh, 0);
    assert.ok(snap.symbols.some((s) => s.name === "CENTS_PER_UNIT"));
  });

  it("regression: caller traced, risk explains the downstream consequence", () => {
    const { snap } = analyze("regression.diff");
    assert.ok(snap.queue.some((d) => d.severity === "High" && d.findingType === "BUSINESS_RULE_DECISION"));
    const cart = snap.impact.edges.find((e) => e.toFile.endsWith("src/cart.ts"));
    assert.ok(cart, "cart.ts caller must be traced");
    assert.equal(cart?.evidence, "import-resolved");
    assert.ok((cart?.toLine ?? 0) > 0);
    const [risk] = snap.risks;
    assert.ok(risk?.scenario.length > 0 && risk?.suggestedTest.length > 0);
    assert.ok(risk?.consequence.includes("downstream") || (risk?.evidence.length ?? 0) > 0);
    assert.equal(snap.overview.risk, "High");
  });

  it("uncertain change: hypothesis standing with disclosed unknowns", () => {
    const { snap } = analyze("uncertain.diff");
    assert.ok(snap.queue.length > 0);
    assert.ok(snap.risks.every((r) => r.standing === "hypothesis" || r.standing === "potential"));
    assert.ok(snap.risks.some((r) => r.standing === "hypothesis"));
    assert.ok(snap.overview.unknowns.length > 0);
    assert.equal(snap.overview.purposeSource, "inferred");
  });

  it("report anchors resolve for every fixture finding", () => {
    for (const name of ["safe.diff", "regression.diff", "uncertain.diff"]) {
      const { snap } = analyze(name);
      const html = buildReportHtml(snap);
      for (const m of html.matchAll(/data-target="([^"]+)"/g)) {
        assert.ok(html.includes(`id="${m[1]}"`), `${name}: dangling target ${m[1]}`);
      }
    }
  });
});
