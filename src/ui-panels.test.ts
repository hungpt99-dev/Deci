import { test } from "node:test";
import assert from "node:assert/strict";
import { buildReviewMap } from "./reviewMap.js";
import { PROVIDER_SPECS } from "./providers.js";
import {
  alternativesHtml,
  buildSidebarHtml,
  chatSectionHtml,
  decisionsRowsHtml,
  evidenceChipsHtml,
  historyListHtml,
  reviewCardHtml,
} from "./vscode/ui/sidebar.js";
import { buildSettingsHtml, providerCardHtml, routingTableHtml } from "./vscode/ui/settings.js";
import { buildNewReviewHtml } from "./vscode/ui/newReview.js";
import { testsPanelHtml, verifyChecklistHtml } from "./vscode/ui/testsPanel.js";
import { historyPanelHtml } from "./vscode/ui/historyCompare.js";
import type { DecisionPoint } from "./decisions.js";

const DIFF = "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n";

function decision(over: Partial<DecisionPoint> = {}): DecisionPoint {
  return {
    id: "D1", severity: "Critical", status: "pending", file: "src/a.ts", line: 1,
    language: "ts", findingType: "SECURITY_DECISION", category: "sec",
    impact: "x <y>", confidence: 0.7, uncertain: false, before: "", after: "", evidenceLinks: [],
    ...over,
  } as DecisionPoint;
}

test("review card shows tiles, risk bar and legend; empty has New review", () => {
  const h = reviewCardHtml(buildReviewMap(DIFF));
  assert.ok(h.includes("stat-card") && h.includes("riskbar") && h.includes("Critical"));
  assert.ok(reviewCardHtml(null).includes("New review"));
});

test("decision rows reveal actions and escape file paths", () => {
  const h = decisionsRowsHtml([decision({ file: "a<b.ts" })]);
  assert.ok(h.includes("dot-Critical") && h.includes("a&lt;b.ts") && h.includes('data-how="accept"'));
  assert.ok(decisionsRowsHtml([]).includes("nothing consequential"));
});

test("evidence chips cap at 24 and show counts", () => {
  const many = Array.from({ length: 30 }, (_, i) => ({ decisionId: `D${i}`, file: "f", items: [], present: 1, missing: 0 }));
  const h = evidenceChipsHtml(many);
  assert.equal((h.match(/data-act="open-evidence"/g) ?? []).length, 24);
});

test("alternatives placeholder and option cards with Choose", () => {
  assert.ok(alternativesHtml(null).includes("reject a decision"));
  const h = alternativesHtml({
    decisionId: "D1", file: "f", findingType: "t", constraint: "c",
    options: [{ id: "o1", label: "A", title: "T <t>", summary: "", complexity: "Low", performance: "", consistency: "", changeSize: "s", locAdded: 1, locRemoved: 2, pros: [], cons: [] }],
  });
  assert.ok(h.includes("Choose") && h.includes("T &lt;t&gt;"));
});

test("history list reverses and escapes; sidebar assembles all sections", () => {
  const entries = [
    { id: "a", at: "t1", label: "r1", loc: 1, files: 1, risk: "Low", decisions: 0, pendingCriticalHigh: 0 },
    { id: "b", at: "t2", label: "r2", loc: 2, files: 2, risk: "High", decisions: 1, pendingCriticalHigh: 1 },
  ];
  assert.ok(historyListHtml(entries).indexOf("r2") < historyListHtml(entries).indexOf("r1"));
  const side = buildSidebarHtml({ branch: "main", map: null, queue: [], evidence: [], alternatives: null, history: entries, conversations: [], activeConvId: null });
  for (const s of ["Review", "Decisions (0)", "Evidence", "Alternatives", "History", "Chat"]) assert.ok(side.includes(s), s);
  assert.ok(side.includes("aria-expanded"));
});

test("chat section marks active conversation", () => {
  const h = chatSectionHtml([{ id: "c1", title: "T", createdAt: "", updatedAt: "", messageCount: 3 }], "c1");
  assert.ok(h.includes("active") && h.includes("3 msgs"));
});

test("settings: 9 provider cards, key set/missing only, routing ops, privacy", () => {
  assert.equal(PROVIDER_SPECS.length, 9);
  const mk = (id: string, keySet: boolean) => {
    const spec = PROVIDER_SPECS.find((s) => s.id === id)!;
    return { spec, baseURL: "", model: "", keySet, envOverridden: [] as string[] };
  };
  const vm = {
    providers: PROVIDER_SPECS.map((s) => mk(s.id, s.id === "openai")),
    activeProvider: "ollama", routing: { fix: "openai" }, fallback: ["openai"],
    allowCloudAi: false, allowCloudFallback: false, verify: true, staticOnly: false, testTimeoutMs: 60000, dirty: true,
  };
  const h = buildSettingsHtml(vm);
  assert.ok(h.includes("key: set") && h.includes("key: missing") && h.includes("Unsaved changes"));
  assert.ok(h.includes("Allow cloud AI"));
  assert.ok(h.includes("leave this machine"));
  for (const op of ["explain", "impact", "test-plan", "test-gen", "diagnose", "fix"]) assert.ok(h.includes(`data-route="${op}"`), op);
  const card = providerCardHtml(mk("vscode-lm", false), false);
  assert.ok(card.includes("key: none needed") && !card.includes("data-act=\"key-replace\""));
  assert.ok(!h.includes("sk-") && !card.match(/value="sk-/));
});

test("routing table escapes ids and marks current", () => {
  const h = routingTableHtml({
    providers: [], activeProvider: "ollama", routing: {}, fallback: [],
    allowCloudAi: false, allowCloudFallback: false, verify: false, staticOnly: false, testTimeoutMs: 1000, dirty: false,
  }, ["ollama"]);
  assert.ok(h.includes("default (ollama)"));
});

test("new review screen covers sources, context and options", () => {
  const h = buildNewReviewHtml({ hasGit: true, branches: ["main"], defaultBranch: "main", verify: true, staticOnly: false, genTests: false, runTests: false, diagnose: false, aiExplain: false, busy: false, error: null });
  for (const s of ["Working tree", "Staged", "Branch range", "Single file", "Ticket", "Design doc", "Run review"]) assert.ok(h.includes(s), s);
  const busy = buildNewReviewHtml({ hasGit: false, branches: [], defaultBranch: "", verify: false, staticOnly: false, genTests: false, runTests: false, diagnose: false, aiExplain: false, busy: true, error: "E <x>" });
  assert.ok(busy.includes("Analyzing…") && busy.includes("E &lt;x&gt;"));
});

test("verify checklist shows icons, logs and per-check re-run", () => {
  const h = verifyChecklistHtml({
    checks: [{ id: "typescript-build", label: "Build", command: "npm run build", status: "fail", detail: "boom <b>", logRef: null, output: "log" }],
    passed: 0, failed: 1, skipped: 0, allPass: false, verifiedPaths: [], generatedAt: "",
  }, false);
  assert.ok(h.includes("✗") && h.includes("boom &lt;b&gt;") && h.includes("verify-rerun"));
  assert.ok(verifyChecklistHtml(null, true).includes("running"));
});

test("tests panel empty states and fix preview with explicit apply", () => {
  const h = testsPanelHtml({ verify: null, verifying: false, discovery: null, selection: null, results: [{ path: "t.js", status: "failed", detail: "boom", output: "" }], generated: [], diagnosis: null, fixDiff: "diff <x>", error: null });
  assert.ok(h.includes("Discover tests") && h.includes("diff &lt;x&gt;") && h.includes("fix-apply") && h.includes("fix-discard"));
  assert.ok(h.includes("t.js") && h.includes("failed") && h.includes("Diagnose failures"));
});

test("history compare selects two runs and flags changed cells", () => {
  const entries = [
    { id: "a", at: "t1", label: "r1", loc: 1, files: 1, risk: "Low", decisions: 0, pendingCriticalHigh: 0 },
    { id: "b", at: "t2", label: "r2", loc: 9, files: 1, risk: "Low", decisions: 0, pendingCriticalHigh: 0 },
  ];
  const h = historyPanelHtml({ entries, selected: ["a", "b"], compare: { a: entries[0]!, b: entries[1]! } });
  assert.ok(h.includes("◀ changed") && h.includes("Export JSON"));
});
