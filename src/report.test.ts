import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildReviewMap } from "./reviewMap.js";
import { analyzeSemantics, parseFileHunks } from "./semantic.js";
import { buildDecisions } from "./decisions.js";
import { collectQueueEvidence, emptyContext } from "./evidence.js";
import { symbolsForHunks } from "./symbols.js";
import { buildImpactMap, type ImpactIo } from "./impact.js";
import { buildRiskFindings } from "./risks.js";
import { buildOverview } from "./overview.js";
import { buildOutputBundle } from "./bundle.js";
import { buildReportHtml, diffSections, highlightLine, type AnalysisSnapshot } from "./report.js";
import type { TicketInput } from "./evidence.js";

const DIFF = `diff --git a/src/auth/login.ts b/src/auth/login.ts
--- a/src/auth/login.ts
+++ b/src/auth/login.ts
@@ -10,2 +20,2 @@
-const old = 1;
+jwt.verify(token);
`;

const noTicket: TicketInput = { text: null, unreachable: false, ref: null };
const emptyIo: ImpactIo = { listFiles: () => [], read: () => "" };

function snapshot(): AnalysisSnapshot {
  const map = buildReviewMap(DIFF);
  const queue = buildDecisions(analyzeSemantics(DIFF));
  const symbols = symbolsForHunks(parseFileHunks(DIFF));
  const impact = buildImpactMap(symbols, ["src/auth/login.ts"], emptyIo, ".");
  const evidence = collectQueueEvidence(queue, emptyContext({ changedFiles: ["src/auth/login.ts"] }));
  const risks = buildRiskFindings(queue, { evidence, impact, report: null });
  const bundle = buildOutputBundle(map, queue, null, { evidence });
  const overview = buildOverview(queue, map, symbols, impact, noTicket, noTicket, evidence, null);
  return {
    revision: { ref: "test", sha: null, dirty: false, analyzedAt: "2026-01-01T00:00:00.000Z" },
    diffText: DIFF,
    map,
    queue,
    symbols,
    impact,
    risks,
    overview,
    evidence,
    testPlan: bundle.testPlan,
  };
}

describe("report", () => {
  it("sections track hunk headers for line anchors", () => {
    const [s] = diffSections(DIFF);
    assert.equal(s?.path, "src/auth/login.ts");
    assert.deepEqual(s?.lines.filter((l) => l.kind === "add").map((l) => l.newLine), [20]);
  });

  it("highlights code without breaking escaped markup", () => {
    const h = highlightLine(`const s = "a<b>"; // hi`);
    assert.ok(h.includes("c-str") && h.includes("&lt;"));
    assert.ok(!h.includes("<b>"));
  });

  it("every finding anchor resolves in the HTML", () => {
    const snap = snapshot();
    const html = buildReportHtml(snap);
    assert.ok(snap.queue.length > 0);
    for (const d of snap.queue) {
      const i = 0; // single-file fixture
      const target = d.line ? `id="L-${i}-${d.line}"` : `id="f-${i}"`;
      assert.ok(html.includes(target), `missing anchor ${target} for ${d.id}`);
    }
    // Every risk card target resolves too.
    for (const m of html.matchAll(/data-target="([^"]+)"/g)) {
      assert.ok(html.includes(`id="${m[1]}"`), `dangling data-target ${m[1]}`);
    }
  });

  it("renders tabs, navigation, staleness, and limitations", () => {
    const html = buildReportHtml(snapshot());
    for (const tab of ["pane-explain", "pane-impact", "pane-risks", "pane-tests", "pane-generate", "pane-diagnose", "pane-api"]) assert.ok(html.includes(tab));
    assert.ok(html.includes("prevF") && html.includes("nextF"));
    assert.ok(html.includes("re-run <code>deci analyze</code>"));
    assert.ok(html.includes("absence of a finding does not prove"));
    assert.ok(html.includes("Language capabilities") || html.includes("capabilities"));
  });

  it("links execution results to diagnoses without dangling targets", () => {
    const snap = snapshot();
    const failed = {
      path: "test/a.test.mjs", command: ["node", "--test", "test/a.test.mjs"],
      status: "failed" as const, exitCode: 1, output: "not ok", durationMs: 5,
      revision: "r", detail: "exited 1",
    };
    const html = buildReportHtml({
      ...snap,
      testResults: [failed, { ...failed, path: "test/b.test.mjs", status: "passed" as const, exitCode: 0, output: "", detail: "ok" }],
      diagnoses: [{
        testPath: "test/a.test.mjs", command: failed.command, exitCode: 1,
        summary: "boom", assertion: "boom", frames: [], links: [],
        causes: [{ statement: "x", standing: "hypothesis" as const }], patch: null,
      }],
    });
    for (const m of html.matchAll(/data-target="([^"]+)"/g)) {
      assert.ok(html.includes(`id="${m[1]}"`), `dangling data-target ${m[1]}`);
    }
  });

  it("empty analysis renders cleanly with disclosed unknowns", () => {
    const snap = snapshot();
    const empty = { ...snap, diffText: "", queue: [], risks: [] };
    const html = buildReportHtml(empty);
    assert.ok(html.includes("No changes."));
    assert.ok(html.includes("No risk findings."));
  });
});
