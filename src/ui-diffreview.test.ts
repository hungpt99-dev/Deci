import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildDiffReviewHtml,
  diffFileHtml,
  fileTreeHtml,
  findingCardHtml,
  findingsForLine,
  highlight,
  noteThreadHtml,
  rightTabsHtml,
  type DiffReviewVM,
  type FindingVM,
} from "./vscode/ui/diffReview.js";
import { parseDiffHunks } from "./vscode/ui/diffModel.js";
import type { DecisionPoint } from "./decisions.js";

const DIFF = [
  "diff --git a/src/a.ts b/src/a.ts",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1,3 +1,4 @@",
  " ctx",
  "-old",
  "+new1",
  "+new2",
  " end",
].join("\n");

function decision(over: Partial<DecisionPoint> = {}): DecisionPoint {
  return {
    id: "D1",
    severity: "High",
    status: "pending",
    file: "src/a.ts",
    line: 2,
    language: "ts",
    findingType: "API_CONTRACT_DECISION",
    category: "api",
    impact: "Breaks callers <b>bold</b>",
    confidence: 0.8,
    uncertain: false,
    before: "old",
    after: "new1",
    evidenceLinks: [],
    ...over,
  } as DecisionPoint;
}

function vm(over: Partial<DiffReviewVM> = {}): DiffReviewVM {
  const files = parseDiffHunks(DIFF);
  return {
    rev: "abc123def456",
    files,
    fileMeta: new Map([["src/a.ts", { path: "src/a.ts", added: 2, removed: 1, module: "src", service: "src", risk: "High" }]]),
    findings: [{ decision: decision(), evidencePresent: "2/9 present", notes: [] }],
    evidence: [],
    impact: null,
    discovery: null,
    selection: null,
    testPlan: null,
    rollbackPlan: null,
    expandedFile: null,
    view: "unified",
    stale: false,
    aiCard: null,
    ...over,
  };
}

test("highlight escapes then tokenizes without executing markup", () => {
  const h = highlight("<script>alert(1)</script> // c");
  assert.ok(!h.includes("<script>"));
  assert.ok(h.includes("tok-c") && h.includes("tok-k") === false);
});

test("highlight never marks keywords inside strings", () => {
  const h = highlight('"type": "webview", const x = 42');
  assert.ok(h.includes("tok-s"), "string span present");
  assert.ok(!h.includes('tok-k">type'), "type inside string is not a keyword");
  assert.ok(h.includes('tok-k">const'), "real keyword still marked");
  assert.ok(h.includes("tok-n"), "number span present");
});

test("findings anchor to exact new-file lines only", () => {
  const v = vm();
  assert.equal(findingsForLine(v, "src/a.ts", 2).length, 1);
  assert.equal(findingsForLine(v, "src/a.ts", 3).length, 0);
  assert.equal(findingsForLine(v, "src/a.ts", null).length, 0);
  assert.equal(findingsForLine(v, "other.ts", 2).length, 0);
});

test("finding card escapes impact, shows standing/confidence and decision buttons", () => {
  const h = findingCardHtml({ decision: decision(), evidencePresent: "2/9", notes: [] });
  assert.ok(h.includes("Breaks callers &lt;b&gt;bold&lt;/b&gt;"));
  assert.ok(h.includes("H High") && h.includes("conf 0.80") && h.includes("confirmed"));
  assert.ok(h.includes('data-how="accept"') && h.includes('data-how="reject"') && h.includes('data-how="investigate"'));
  assert.ok(h.includes("hypothesis") === false);
  const u = findingCardHtml({ decision: decision({ uncertain: true, confidence: 0.4 }), evidencePresent: "0/9", notes: [] });
  assert.ok(u.includes("hypothesis"));
});

test("note thread labels AI authorship and escapes text", () => {
  const f: FindingVM = {
    decision: decision(),
    evidencePresent: "1/9",
    notes: [
      { id: "n1", author: "You", text: "check <this>", at: "t", resolved: false },
      { id: "n2", author: "Deci", text: "ai note", at: "t", resolved: true },
    ],
  };
  const h = noteThreadHtml(f, "src/a.ts", 2);
  assert.ok(h.includes("(1 open)") && h.includes("check &lt;this&gt;") && h.includes("AI") && h.includes("resolved"));
});

test("file tree lists modules, counts, risk dots and filter chips", () => {
  const h = fileTreeHtml(vm());
  assert.ok(h.includes("src") && h.includes("+2/-2") === false);
  assert.ok(h.includes("+2/-1") && h.includes("1 finding"));
  assert.ok(h.includes("dot-High") && h.includes("filter-sev") && h.includes("Undecided"));
});

test("diff file renders gutter markers, finding cards and threads under the line", () => {
  const v = vm();
  const h = diffFileHtml(v, v.files[0]!, false);
  assert.ok(h.includes("mk-High") && h.includes("API_CONTRACT_DECISION"));
  assert.ok(h.indexOf("mk-High") < h.indexOf("API_CONTRACT_DECISION"));
});

test("right tabs rank findings and escape plan content", () => {
  const v = vm({
    findings: [
      { decision: decision({ id: "D2", severity: "Low" }), evidencePresent: "1/9", notes: [] },
      { decision: decision(), evidencePresent: "2/9", notes: [] },
    ],
    evidence: [{ decisionId: "D1", file: "src/a.ts", items: [
      { kind: "code", label: "current code", ref: "src/a.ts", status: "present", excerpt: null, note: null },
      { kind: "test", label: "tests", ref: "src/a.test.ts", status: "missing", excerpt: null, note: null },
    ], present: 1, missing: 1 }],
    testPlan: { ran: [], toAdd: ["add <test>"] },
    rollbackPlan: { steps: ["revert & redo"] },
  });
  const h = rightTabsHtml(v);
  assert.ok(h.indexOf("API_CONTRACT_DECISION") >= 0);
  assert.ok(h.indexOf("D1") >= 0); // evidence bundle id
  assert.ok(h.includes("1/2 present"));
  assert.ok(h.includes("add &lt;test&gt;") && h.includes("revert &amp; redo"));
  assert.ok(h.includes("Findings") && h.includes("Evidence") && h.includes("Impact") && h.includes("Tests") && h.includes("Plan"));
});

test("empty diff shows calm empty state, never a zero grid", () => {
  const h = buildDiffReviewHtml(vm({ files: [] }));
  assert.ok(h.includes("No changes") && h.includes("Choose what to review"));
  assert.ok(!h.includes("0 LOC"));
});

test("stale revision shows banner with short hash", () => {
  const h = buildDiffReviewHtml(vm({ stale: true }));
  assert.ok(h.includes("abc123def456".slice(0, 12)) && h.includes("Re-run after new changes"));
});
