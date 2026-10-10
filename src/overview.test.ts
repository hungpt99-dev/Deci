import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildReviewMap } from "./reviewMap.js";
import { buildDecisions } from "./decisions.js";
import type { SemanticFinding } from "./semantic.js";
import { buildImpactMap, type ImpactIo } from "./impact.js";
import { buildOverview, renderOverviewMarkdown } from "./overview.js";
import type { TicketInput } from "./evidence.js";

const noTicket: TicketInput = { text: null, unreachable: false, ref: null };
const emptyIo: ImpactIo = { listFiles: () => [], read: () => "" };

const f = (over: Partial<SemanticFinding> & { id: string }): SemanticFinding => ({
  file: "src/pay.ts",
  line: 3,
  language: "typescript",
  category: "business",
  type: "BUSINESS_RULE_DECISION",
  before: "-old",
  after: "+new",
  impact: "Rule changed.",
  confidence: 0.7,
  uncertain: false,
  ...over,
});

describe("overview", () => {
  it("labels purpose documented when a ticket is provided", () => {
    const diff = `diff --git a/src/pay.ts b/src/pay.ts\n+++ b/src/pay.ts\n@@ -1,1 +1,1 @@\n-old\n+new`;
    const o = buildOverview(
      buildDecisions([f({ id: "a:1" })]),
      buildReviewMap(diff),
      [],
      buildImpactMap([], ["src/pay.ts"], emptyIo, "."),
      { text: "Cap discounts at 50%", unreachable: false, ref: "T-1" },
      noTicket,
      [],
      null,
    );
    assert.equal(o.purposeSource, "documented");
    assert.match(o.purpose, /Cap discounts/);
    assert.match(renderOverviewMarkdown(o), /documented requirement/);
  });

  it("labels purpose inferred and records unknowns without a ticket", () => {
    const diff = `diff --git a/src/pay.ts b/src/pay.ts\n+++ b/src/pay.ts\n@@ -1,1 +1,1 @@\n-old\n+new`;
    const o = buildOverview(
      buildDecisions([f({ id: "a:1" })]),
      buildReviewMap(diff),
      [],
      buildImpactMap([], ["src/pay.ts"], emptyIo, "."),
      noTicket,
      noTicket,
      [],
      null,
    );
    assert.equal(o.purposeSource, "inferred");
    assert.ok(o.unknowns.some((u) => /inferred from the diff/.test(u)));
    assert.match(renderOverviewMarkdown(o), /not verified/);
  });
});
