import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  acceptDecision,
  buildDecisions,
  decisionSummary,
  evidenceFor,
  gutterIconFor,
  gutterMarksFor,
  hoverMarkdownFor,
  investigateDecision,
  rejectDecision,
  renderDecisionsMarkdown,
  severityFor,
  type DecisionPoint,
} from "./decisions.js";
import type { SemanticFinding } from "./semantic.js";

const f = (over: Partial<SemanticFinding> & { id: string }): SemanticFinding => ({
  file: "src/a.ts",
  language: "typescript",
  category: "security",
  type: "SECURITY_DECISION",
  before: "",
  after: "+jwt.verify(token);",
  impact: "Auth changed.",
  confidence: 0.9,
  uncertain: false,
  ...over,
});

const queueOf = (): DecisionPoint[] =>
  buildDecisions([
    f({ id: "a:1", type: "PERFORMANCE_DECISION", category: "performance", confidence: 0.75 }),
    f({ id: "b:2", type: "SECURITY_DECISION", category: "security", confidence: 0.9 }),
    f({ id: "c:3", type: "BUSINESS_RULE_DECISION", category: "business", confidence: 0.7 }),
  ]);

describe("decisions", () => {
  it("ranks by severity then confidence", () => {
    const q = queueOf();
    assert.deepEqual(
      q.map((d) => d.findingType),
      ["SECURITY_DECISION", "BUSINESS_RULE_DECISION", "PERFORMANCE_DECISION"],
    );
    assert.equal(q[0]?.severity, "Critical");
  });

  it("each decision carries evidence links and confidence", () => {
    for (const d of queueOf()) {
      assert.ok(d.confidence >= 0 && d.confidence <= 1);
      assert.ok(d.evidenceLinks.length >= 2);
      assert.ok(d.evidenceLinks.some((e) => e.label === "file"));
      const md = renderDecisionsMarkdown([d]);
      assert.match(md, /Evidence/);
      assert.match(md, new RegExp(d.confidence.toFixed(2).replace(".", "\\.")));
    }
    assert.ok(evidenceFor("src/a.ts", "x").some((e) => e.label === "test"));
  });

  it("accept / investigate transition, unknown id throws", () => {
    const q = queueOf();
    const id = q[0]?.id as string;
    assert.equal(acceptDecision(q, id)[0]?.status, "accepted");
    assert.equal(investigateDecision(q, id)[0]?.status, "investigating");
    assert.throws(() => acceptDecision(q, "nope"), /unknown decision/);
    assert.equal(q[0]?.status, "pending"); // immutable input
  });

  it("reject requires reason plus free-text constraint", () => {
    const q = queueOf();
    const id = q[0]?.id as string;
    assert.throws(() => rejectDecision(q, id, "wrong-security", "  "), /constraint/);
    assert.throws(() => rejectDecision(q, id, "bogus" as never, "keep it consistent"), /reason/);
    const next = rejectDecision(q, id, "wrong-security", "payment must remain strongly consistent");
    assert.equal(next[0]?.status, "rejected");
    assert.equal(next[0]?.constraint, "payment must remain strongly consistent");
  });

  it("gutter icon plus hover card carry severity and actions", () => {
    assert.equal(gutterIconFor("Critical"), "🔴");
    assert.equal(severityFor("BEHAVIOR_CHANGE"), "Medium");
    const q = queueOf();
    const marks = gutterMarksFor(q, () => 42);
    assert.equal(marks.length, 3);
    assert.ok(marks.every((m) => m.line === 42 && m.icon));
    const hover = hoverMarkdownFor(q[0] as DecisionPoint);
    assert.match(hover, /Critical/);
    assert.match(hover, /Accept/);
    assert.match(hover, /Reject/);
    assert.match(hover, /Investigate/);
  });

  it("groups same file+findingType with groupedIds and populates unknowns when uncertain", () => {
    const q = buildDecisions([
      f({ id: "g:1", file: "src/auth.ts", type: "SECURITY_DECISION" }),
      f({ id: "g:2", file: "src/auth.ts", type: "SECURITY_DECISION" }),
      f({ id: "g:3", file: "src/other.ts", type: "SECURITY_DECISION", confidence: 0.4, uncertain: true }),
    ]);
    assert.equal(q.length, 2);
    const grouped = q.find((d) => d.file === "src/auth.ts");
    assert.deepEqual(grouped?.groupedIds, ["g:1", "g:2"]);
    assert.ok((grouped?.riskReasons?.length ?? 0) >= 1);
    assert.match(grouped?.riskReasons?.[0] ?? "", /src\/auth\.ts/);
    const low = q.find((d) => d.file === "src/other.ts");
    assert.ok(low?.unknowns?.length);
    assert.match(low?.unknowns?.[0] ?? "", /Unknown.*insufficient evidence.*next:/);
  });

  it("summary counts pending Critical/High; empty renders cleanly", () => {
    const q = queueOf();
    const s = decisionSummary(q);
    assert.equal(s.total, 3);
    assert.equal(s.pendingCriticalHigh, 2);
    const id = q[0]?.id as string;
    assert.equal(decisionSummary(acceptDecision(q, id)).pending, 2);
    assert.match(renderDecisionsMarkdown([]), /No decisions/);
  });
});
