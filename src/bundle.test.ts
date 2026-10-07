import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildDecisions } from "./decisions.js";
import { buildReviewMap } from "./reviewMap.js";
import type { SemanticFinding } from "./semantic.js";
import { runFullVerify, type VerifyReport } from "./verify.js";
import {
  buildOutputBundle,
  buildRollbackPlan,
  buildTestPlan,
  overallRiskFor,
  renderBundleMarkdown,
} from "./bundle.js";

const f = (over: Partial<SemanticFinding> & { id: string }): SemanticFinding => ({
  file: "src/pay.ts",
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

const diff = [
  `diff --git a/src/pay.ts b/src/pay.ts`,
  `+++ b/src/pay.ts`,
  `@@ -1,1 +1,1 @@`,
  `-await commit(tx);`,
  `+await commit(tx); // widened`,
].join("\n");

const okExec = () => ({ exitCode: 0, output: "" });

function reportFor(d: string): VerifyReport {
  return runFullVerify(d, { exec: okExec });
}

describe("bundle", () => {
  it("classifies risk from pending queue; decided work does not raise risk", () => {
    const q = buildDecisions([f({ id: "t:1" })]);
    assert.equal(overallRiskFor(q, null).risk, "Critical");
    const decided = q.map((d) => ({ ...d, status: "accepted" as const }));
    assert.equal(overallRiskFor(decided, null).risk, "Low");
    assert.equal(overallRiskFor([], reportFor(diff)).risk, "Low");
  });

  it("failing verify holds risk High with empty queue", () => {
    const bad: VerifyReport = {
      ...reportFor(diff),
      failed: 1,
      allPass: false,
    };
    assert.equal(overallRiskFor([], bad).risk, "High");
  });

  it("test plan lists what ran plus what to add per Critical file", () => {
    const q = buildDecisions([f({ id: "t:1" })]);
    const plan = buildTestPlan(q, reportFor(diff));
    assert.ok(plan.ran.length > 0);
    assert.ok(plan.toAdd.some((l) => l.includes("src/pay.ts")));
    assert.ok(plan.toAdd.some((l) => l.includes("migration")));
  });

  it("rollback is text only: migration + contract + manual-only steps", () => {
    const r = buildRollbackPlan(["src/pay.ts", "db/migration/V2__pay.sql", "api/openapi.yaml"]);
    assert.ok(r.steps.some((s) => /migration down/i.test(s)));
    assert.ok(r.steps.some((s) => /republish.*contract|notify consumers/i.test(s)));
    assert.ok(r.steps.some((s) => /never auto-reverts/i.test(s)));
    assert.deepEqual(buildRollbackPlan([]).steps, ["No changes — nothing to roll back."]);
  });

  it("bundle composes impact/risk/test/rollback with reason", () => {
    const map = buildReviewMap(diff);
    const q = buildDecisions([f({ id: "t:1" })]);
    const b = buildOutputBundle(map, q, reportFor(diff), { changedFiles: ["src/pay.ts"] });
    assert.equal(b.risk, "Critical");
    assert.ok(b.riskReason.length > 0);
    assert.equal(b.impact.totalDecisions, 1);
    assert.ok(b.testPlan.ran.length > 0 && b.testPlan.toAdd.length > 0);
    assert.ok(b.rollback.steps.length >= 2);
    assert.ok(b.generatedAt);
  });

  it("markdown renders all four sections, text-only rollback, no revert runner", () => {
    const map = buildReviewMap(diff);
    const q = buildDecisions([f({ id: "t:1" })]);
    const md = renderBundleMarkdown(buildOutputBundle(map, q, reportFor(diff)));
    assert.match(md, /## Impact summary/);
    assert.match(md, /## Risk classification: Critical/);
    assert.match(md, /## Test plan/);
    assert.match(md, /## Rollback plan \(text only/);
    assert.match(md, /never auto-reverts/);
    assert.doesNotMatch(md, /command:changepilot\.\w*[Rr]evert/);
  });
});
