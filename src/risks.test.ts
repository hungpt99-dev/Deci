import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildDecisions } from "./decisions.js";
import type { SemanticFinding } from "./semantic.js";
import { buildRiskFindings, confidenceMeaning, failingFilesFor, renderRisksMarkdown } from "./risks.js";
import { runFullVerify } from "./verify.js";

const f = (over: Partial<SemanticFinding> & { id: string }): SemanticFinding => ({
  file: "src/pay.ts",
  line: 7,
  language: "typescript",
  category: "data",
  type: "CONSISTENCY_DECISION",
  before: "-await commit(tx);",
  after: "+await commit(tx); // widened",
  impact: "Tx boundary changed.",
  confidence: 0.8,
  uncertain: false,
  ...over,
});

describe("risks", () => {
  it("emits all ten required fields with potential standing", () => {
    const [r] = buildRiskFindings(buildDecisions([f({ id: "a:1" })]));
    assert.ok(r);
    assert.ok(r.title && r.severity === "Critical");
    assert.equal(r.file, "src/pay.ts");
    assert.equal(r.line, 7);
    assert.equal(r.standing, "potential");
    assert.equal(r.claim, "inference");
    assert.ok(r.current.includes("commit"));
    assert.ok(r.consequence && r.scenario && r.mitigation && r.suggestedTest);
    assert.ok(r.evidence.length >= 2);
    assert.ok(r.confidenceMeaning.length > 0);
    assert.match(renderRisksMarkdown([r]), /Failure scenario/);
    assert.match(renderRisksMarkdown([r]), /Suggested test/);
    assert.match(renderRisksMarkdown([]), /No risk findings/);
  });

  it("marks uncertain matches as hypothesis, never fact", () => {
    const [r] = buildRiskFindings(buildDecisions([f({ id: "b:1", uncertain: true, confidence: 0.4 })]));
    assert.equal(r?.standing, "hypothesis");
    assert.equal(r?.claim, "hypothesis");
  });

  it("promotes to confirmed only when a failing check names the file", () => {
    const diff = `diff --git a/api/openapi.yaml b/api/openapi.yaml\n+++ b/api/openapi.yaml\n@@ -1,1 +1,1 @@\n-a\n+b`;
    const report = runFullVerify(diff, { runCommands: false, exec: () => ({ exitCode: 0, output: "" }) });
    assert.deepEqual(failingFilesFor(report), ["api/openapi.yaml"]);
    const [r] = buildRiskFindings(
      buildDecisions([f({ id: "c:1", file: "api/openapi.yaml", type: "API_CONTRACT_DECISION", category: "architecture" })]),
      { report },
    );
    assert.equal(r?.standing, "confirmed");
    assert.equal(r?.claim, "fact");
  });

  it("recommends creating the missing sibling test", () => {
    const [r] = buildRiskFindings(buildDecisions([f({ id: "d:1" })]), {
      evidence: [{
        decisionId: "D1",
        file: "src/pay.ts",
        items: [{ kind: "test", label: "tests", ref: "src/pay.test.ts", status: "missing", excerpt: null, note: "none" }],
        present: 0,
        missing: 1,
      }],
    });
    assert.match(r?.suggestedTest ?? "", /src\/pay\.test\.ts/);
  });

  it("documents what each confidence band means", () => {
    assert.match(confidenceMeaning(0.9), /Strong/);
    assert.match(confidenceMeaning(0.7), /Moderate/);
    assert.match(confidenceMeaning(0.2), /Weak/);
  });
});
