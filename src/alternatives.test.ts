import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  generateAlternatives,
  pickAlternative,
  planForAlternative,
  renderAlternativesMarkdown,
  renderPlanMarkdown,
} from "./alternatives.js";
import { buildDecisions, rejectDecision } from "./decisions.js";
import type { SemanticFinding } from "./semantic.js";

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

const rejectedTx = () => {
  const q = buildDecisions([f({ id: "t:1" })]);
  const id = q[0]?.id as string;
  return rejectDecision(q, id, "wrong-architecture", "payment must remain strongly consistent")[0]!;
};

describe("alternatives", () => {
  it("generates 3 alternatives with complexity/performance/consistency/change-size", () => {
    const set = generateAlternatives(rejectedTx());
    assert.equal(set.options.length, 3);
    assert.deepEqual(set.options.map((o) => o.label), ["A", "B", "C"]);
    for (const o of set.options) {
      assert.ok(o.title && o.summary);
      assert.ok(["Low", "Medium", "High"].includes(o.complexity));
      assert.ok(o.performance && o.consistency && o.changeSize);
      assert.ok(o.pros.length > 0 && o.cons.length > 0);
      assert.ok(Number.isInteger(o.locAdded) && Number.isInteger(o.locRemoved));
    }
  });

  it("constraint from Reject flows into generation", () => {
    const set = generateAlternatives(rejectedTx());
    assert.equal(set.constraint, "payment must remain strongly consistent");
    for (const o of set.options) assert.match(o.summary, /payment must remain strongly consistent/);
    const md = renderAlternativesMarkdown(set);
    assert.match(md, /payment must remain strongly consistent/);
  });

  it("templates vary by finding type; unknown types get generic fallback", () => {
    const tx = generateAlternatives(rejectedTx());
    assert.ok(tx.options.some((o) => /Outbox/i.test(o.title)));
    const sec = buildDecisions([f({ id: "s:1", type: "SECURITY_DECISION", category: "security" })])[0]!;
    const secSet = generateAlternatives({ ...sec, constraint: "deny by default" });
    assert.ok(secSet.options.some((o) => /allow-list|middleware|audit/i.test(o.title)));
    const biz = buildDecisions([f({ id: "b:1", type: "BEHAVIOR_CHANGE", category: "business" })])[0]!;
    assert.ok(generateAlternatives(biz).options.some((o) => /Minimal targeted fix/i.test(o.title)));
  });

  it("renders A/B/C compare view with pros/cons and trade-off table", () => {
    const md = renderAlternativesMarkdown(generateAlternatives(rejectedTx()));
    assert.match(md, /Option A/);
    assert.match(md, /Option B/);
    assert.match(md, /Option C/);
    assert.match(md, /Pros:/);
    assert.match(md, /Cons:/);
    assert.match(md, /\| Alt \| Title \| Complexity \| Performance \| Consistency \| Change \|/);
  });

  it("pick one proceeds to implementation plan with file steps and LOC estimate", () => {
    const set = generateAlternatives(rejectedTx());
    const target = set.options[1]!;
    const next = pickAlternative(set, target.id);
    assert.equal(next.pickedId, target.id);
    assert.equal(set.pickedId, undefined); // immutable input
    assert.throws(() => pickAlternative(set, "bogus"), /unknown alternative/);
    const plan = planForAlternative(next);
    assert.equal(plan.alternativeId, target.id);
    assert.ok(plan.steps.length >= 2);
    assert.ok(plan.steps.some((s) => s.file === "src/pay.ts"));
    assert.match(renderPlanMarkdown(plan), /\+.*LOC|Estimate/);
    assert.match(renderAlternativesMarkdown(next), /picked/);
  });

  it("works without a constraint and stays deterministic", () => {
    const d = buildDecisions([f({ id: "n:1" })])[0]!;
    const a = generateAlternatives(d);
    const b = generateAlternatives(d);
    assert.equal(a.constraint, "");
    assert.deepEqual(a, b);
  });
});
