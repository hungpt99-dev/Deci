import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderSelectionMarkdown, selectTests } from "./select.js";
import type { DiscoveredTest } from "./discover.js";
import type { ImpactMap } from "./impact.js";

const t = (path: string, over: Partial<DiscoveredTest> = {}): DiscoveredTest => ({
  path,
  category: "unit",
  layer: "backend",
  framework: "node:test",
  command: ["node", "--test", path],
  unrunnable: null,
  ...over,
});

const emptyImpact: ImpactMap = {
  edges: [], directFiles: [], indirectFiles: [], testFiles: [],
  scannedFiles: 0, truncated: false, unresolved: [],
};

describe("select", () => {
  it("prefers sibling and traced tests as confirmed", () => {
    const discovered = [t("src/pay.test.ts"), t("src/cart.test.ts"), t("lib/other.test.ts")];
    const impact: ImpactMap = {
      ...emptyImpact,
      edges: [{
        symbol: "totalFor", fromFile: "src/pay.ts", toFile: "src/cart.test.ts",
        toLine: 3, evidence: "import-resolved", depth: "direct",
        excerpt: "import { totalFor }", matches: 1, isTest: true,
      }],
    };
    const s = selectTests(["src/pay.ts"], impact, discovered);
    const by = new Map(s.selected.map((x) => [x.path, x]));
    assert.equal(by.get("src/pay.test.ts")?.basis, "confirmed");
    assert.equal(by.get("src/cart.test.ts")?.basis, "confirmed");
    assert.ok(!by.has("lib/other.test.ts"));
    assert.ok(s.unselected.some((u) => u.path === "lib/other.test.ts"));
    assert.match(renderSelectionMarkdown(s), /Sibling of changed file/);
  });

  it("marks same-module matches inferred, contract changes pull api tests", () => {
    const discovered = [t("src/pay.helper.test.ts"), t("src/api.test.ts", { category: "api" })];
    const s = selectTests(["src/pay.ts", "api/openapi.yaml"], emptyImpact, discovered);
    const by = new Map(s.selected.map((x) => [x.path, x]));
    assert.equal(by.get("src/pay.helper.test.ts")?.basis, "inferred");
    assert.equal(by.get("src/api.test.ts")?.basis, "confirmed");
  });

  it("selects nothing without relationships and says so", () => {
    const s = selectTests(["src/pay.ts"], emptyImpact, [t("unrelated/x.test.ts")]);
    assert.equal(s.selected.length, 0);
    assert.match(renderSelectionMarkdown(s), /No tests selected/);
  });
});
