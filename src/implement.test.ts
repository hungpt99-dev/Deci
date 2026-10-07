import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildDecisions, rejectDecision } from "./decisions.js";
import { generateAlternatives, pickAlternative, planForAlternative } from "./alternatives.js";
import type { SemanticFinding } from "./semantic.js";
import {
  applyPatch,
  generatePatch,
  implementAndReverify,
  localAgentAdapter,
  memFs,
  renderImplementResultMarkdown,
  renderPatchMarkdown,
  requeueAffected,
  requireLocalAdapter,
  reverifyAfterApply,
} from "./implement.js";

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

const tsDiff = (body: string) => `diff --git a/src/pay.ts b/src/pay.ts\n+++ b/src/pay.ts\n${body}`;
const okExec = () => ({ exitCode: 0, output: "" });

function pickedSet() {
  const q = buildDecisions([f({ id: "t:1" })]);
  const id = q[0]?.id as string;
  const rej = rejectDecision(q, id, "wrong-architecture", "payment must remain strongly consistent");
  const set = generateAlternatives(rej[0]!);
  return pickAlternative(set, set.options[1]!.id);
}

describe("implement", () => {
  it("generates patch preview with file steps and LOC estimate", () => {
    const set = pickedSet();
    const patch = generatePatch(planForAlternative(set));
    assert.ok(patch.files.length >= 2);
    assert.ok(patch.files.some((x) => x.file === "src/pay.ts"));
    assert.match(patch.patchText, /diff --git|--- a\//);
    assert.match(renderPatchMarkdown(patch), /Generate patch/);
    assert.match(renderPatchMarkdown(patch), /\+.*LOC|Estimate/);
    assert.match(renderPatchMarkdown(patch), /local only/);
  });

  it("local adapter only: non-local adapter id throws before fs touch", () => {
    assert.throws(() => requireLocalAdapter("cloud"), /Local Agent Adapter only/);
    assert.equal(localAgentAdapter.id, "local");
    assert.ok(localAgentAdapter.inspect({ decisionId: "D1", alternativeId: "x", label: "B", title: "T", steps: [], locAdded: 1, locRemoved: 1 }).length > 0);
    const set = pickedSet();
    const fs = memFs();
    assert.throws(
      () => implementAndReverify(set, [], fs, "", { adapterId: "cloud" }),
      /Local Agent Adapter only/,
    );
    assert.equal(fs.store.size, 0);
  });

  it("applyPatch writes via injected fs; verify steps write nothing", () => {
    const set = pickedSet();
    const plan = planForAlternative(set);
    const fs = memFs({ "src/pay.ts": "const a = 1;\n" });
    const patch = applyPatch(plan, fs);
    assert.ok(patch.appliedAt);
    assert.ok((fs.store.get("src/pay.ts") as string).includes("Deci(local)"));
    assert.ok((fs.store.get("src/pay.ts") as string).includes("const a = 1;"));
    assert.ok(fs.store.has("src/pay.test.ts")); // sibling test scaffold
  });

  it("full re-verify runs after apply (stub exec)", () => {
    const report = reverifyAfterApply(tsDiff("@@ -1,1 +1,1 @@\n-a\n+b"), { exec: okExec });
    assert.equal(report.allPass, true);
    assert.ok(report.checks.length > 0);
  });

  it("only affected decisions re-queued; others keep status", () => {
    const q = buildDecisions([
      f({ id: "t:1" }),
      f({ id: "t:2", file: "src/other.ts" }),
    ]);
    const next = requeueAffected(
      q.map((d) => ({ ...d, status: "accepted" as const })),
      ["src/pay.ts"],
    );
    assert.equal(next[0]?.status, "pending");
    assert.equal(next[1]?.status, "accepted");
    // sibling test path also counts as affected
    const viaTest = requeueAffected(q, ["src/pay.ts.test.ts"]);
    assert.equal(viaTest[0]?.status, "pending");
  });

  it("implementAndReverify composes apply + verify + scoped requeue", () => {
    const set = pickedSet();
    const fresh = buildDecisions([
      f({ id: "t:1" }),
      f({ id: "t:2", file: "src/other.ts" }),
    ]);
    // Decide everything first so the re-queue flip is observable.
    const queue = fresh.map((d) => ({ ...d, status: "accepted" as const }));
    const fs = memFs();
    const postDiff = tsDiff("@@ -1,1 +1,1 @@\n-a\n+b");
    const result = implementAndReverify(set, queue, fs, postDiff, {
      verify: { exec: okExec },
    });
    assert.ok(result.patch.files.length > 0);
    assert.equal(result.report.allPass, true);
    assert.equal(result.requeued.length, 2);
    assert.equal(result.requeuedCount, 1); // only src/pay.ts decision flipped pending
    const md = renderImplementResultMarkdown(result);
    assert.match(md, /Re-verify/);
    assert.match(md, /Re-queued: 1/);
  });
});
