import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildReviewMap } from "./reviewMap.js";
import { buildDecisions } from "./decisions.js";
import { generateAlternatives } from "./alternatives.js";
import { rejectDecision } from "./decisions.js";
import type { SemanticFinding } from "./semantic.js";
import {
  PANEL_VIEWS,
  appendHistory,
  buildAlternativeNodes,
  buildDecisionNodes,
  buildEvidenceNodes,
  buildHistoryNodes,
  buildReviewNodes,
  historyEntryFor,
  renderHistoryMarkdown,
} from "./panels.js";
import { collectQueueEvidence, emptyContext } from "./evidence.js";

const DIFF = `diff --git a/src/auth.ts b/src/auth.ts
new file mode 100644
--- /dev/null
+++ b/src/auth.ts
@@ -0,0 +1,2 @@
+export function login(t:string){ if(t) return true; return false; }
+// TODO: authorize role check
`;

const f = (over: Partial<SemanticFinding> & { id: string }): SemanticFinding => ({
  file: "src/pay.ts",
  language: "typescript",
  category: "data",
  type: "CONSISTENCY_DECISION",
  before: "-commit",
  after: "+commit widened",
  impact: "Tx boundary.",
  confidence: 0.8,
  uncertain: false,
  ...over,
});

describe("panels", () => {
  it("exposes all five Activity Bar views", () => {
    assert.deepEqual(
      PANEL_VIEWS.map((v) => v.id),
      ["deci.review", "deci.decisions", "deci.alternatives", "deci.evidence", "deci.history"],
    );
  });

  it("review nodes summarize map, empty map gets placeholder", () => {
    const nodes = buildReviewNodes(buildReviewMap(DIFF));
    assert.ok(nodes[0]?.label.includes("LOC"));
    assert.deepEqual(buildReviewNodes(buildReviewMap("")).slice(-1)[0]?.label, "No changes — diff is empty.");
  });

  it("decision nodes rank one per decision, empty gets placeholder", () => {
    const q = buildDecisions([f({ id: "a:1" })]);
    assert.equal(buildDecisionNodes(q).length, 1);
    assert.equal(buildDecisionNodes([])[0]?.label, "No decisions — nothing consequential found.");
  });

  it("alternative nodes show A/B/C, null gets placeholder", () => {
    const q = buildDecisions([f({ id: "t:1" })]);
    const rej = rejectDecision(q, q[0]!.id, "wrong-architecture", "keep consistent")[0]!;
    const set = generateAlternatives(rej);
    assert.deepEqual(buildAlternativeNodes(set).map((n) => n.label.slice(0, 2)), ["A:", "B:", "C:"]);
    assert.equal(buildAlternativeNodes(null)[0]?.label, "No alternatives — reject a decision with a constraint first.");
  });

  it("evidence nodes count present/missing, empty gets placeholder", () => {
    const q = buildDecisions([f({ id: "a:1" })]);
    const bundles = collectQueueEvidence(q, emptyContext({ changedFiles: ["src/pay.ts"] }));
    assert.equal(buildEvidenceNodes(bundles).length, 1);
    assert.match(buildEvidenceNodes(bundles)[0]!.detail!, /\d+\/\d+ present/);
    assert.equal(buildEvidenceNodes([])[0]?.label, "No evidence — run analysis first.");
  });

  it("history append is immutable + capped, newest first, renders table", () => {
    const map = buildReviewMap(DIFF);
    const q = buildDecisions([f({ id: "a:1" })]);
    const e1 = historyEntryFor("review-1", map, q, "2026-01-01T00:00:00.000Z");
    const e2 = historyEntryFor("review-2", map, [], "2026-01-02T00:00:00.000Z");
    assert.equal(e1.risk, "Critical");
    assert.equal(e2.risk, "Low");
    const h1 = appendHistory([], e1);
    const h2 = appendHistory(h1, e2);
    assert.equal(h1.length, 1);
    assert.equal(h2.length, 2);
    assert.equal(buildHistoryNodes(h2)[0]?.label.startsWith("review-2"), true);
    assert.match(renderHistoryMarkdown(h2), /\| When \| Review \|/);
    assert.equal(buildHistoryNodes([])[0]?.label, "No reviews yet — run Deci analysis first.");
    const capped = appendHistory([e1], e2, 1);
    assert.equal(capped.length, 1);
    assert.equal(capped[0]?.label, "review-2");
  });
});
