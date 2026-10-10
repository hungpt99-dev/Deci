import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildReviewMap, classifyRisk, renderMarkdown } from "./reviewMap.js";

const DIFF = `diff --git a/src/auth/login.ts b/src/auth/login.ts
+++ b/src/auth/login.ts
@@ -1,2 +1,3 @@
-old
+new
+more
diff --git a/src/cart/total.ts b/src/cart/total.ts
+++ b/src/cart/total.ts
@@ -1,1 +1,2 @@
-same
+changed
diff --git a/README.md b/README.md
+++ b/README.md
@@ -1,1 +1,1 @@
-a
+b
`;

describe("reviewMap", () => {
  it("counts LOC, files, modules, services", () => {
    const map = buildReviewMap(DIFF);
    assert.equal(map.fileCount, 3);
    assert.equal(map.totalAdded, 4);
    assert.equal(map.totalRemoved, 3);
    assert.equal(map.totalLoc, 7);
    assert.ok(map.modules.includes("src/auth"));
    assert.ok(map.services.length >= 1);
  });

  it("distributes risk across all five buckets", () => {
    const map = buildReviewMap(DIFF);
    const keys = Object.keys(map.riskDistribution).sort();
    assert.deepEqual(keys, ["Critical", "High", "Low", "Medium", "Verified"]);
    assert.equal(map.riskDistribution.Critical.files, 1); // auth path
    assert.equal(map.riskDistribution.Low.files, 1); // README
  });

  it("estimates human vs full-diff time with compression", () => {
    const map = buildReviewMap(DIFF);
    assert.ok(map.estimatedFullReviewMinutes >= 1);
    assert.ok(map.estimatedHumanReviewMinutes >= 1);
    assert.ok(map.estimatedHumanReviewMinutes <= map.estimatedFullReviewMinutes);
    assert.ok(map.compressionRatio >= 1);
  });

  it("classifies unknown paths as Medium, never drops them", () => {
    assert.equal(classifyRisk("src/cart/total.ts"), "Medium");
  });

  it("renders markdown with all acceptance sections", () => {
    const md = renderMarkdown(buildReviewMap(DIFF));
    assert.match(md, /LOC/);
    assert.match(md, /Critical/);
    assert.match(md, /Human review/);
    assert.match(md, /full diff/);
  });

  it("builds a 2000+ LOC map in <5s", () => {
    const hunk = "@@ -1,1 +1,2 @@\n-old\n+new\n+new2\n";
    const one = `diff --git a/src/big/f.ts b/src/big/f.ts\n+++ b/src/big/f.ts\n${hunk}`;
    const t0 = performance.now();
    const map = buildReviewMap(one.repeat(700)); // 2100 LOC
    const ms = performance.now() - t0;
    assert.equal(map.totalLoc, 2100);
    assert.ok(ms < 5000, `took ${ms}ms`);
  });

  it("empty diff yields zero map, never throws", () => {
    const map = buildReviewMap("");
    assert.equal(map.totalLoc, 0);
    assert.equal(map.estimatedFullReviewMinutes, 0);
  });

  it("never drops deleted or new files (--- / +++ /dev/null pairs)", () => {
    const deleted = [
      `diff --git a/src/auth/legacy.ts b/src/auth/legacy.ts`,
      `--- a/src/auth/legacy.ts`,
      `+++ /dev/null`,
      `@@ -1,2 +0,0 @@`,
      `-export const x = 1;`,
      `-export const y = 2;`,
    ].join("\n");
    const map = buildReviewMap(deleted);
    assert.equal(map.fileCount, 1);
    assert.equal(map.files[0]?.path, "src/auth/legacy.ts");
    assert.equal(map.totalRemoved, 2);
    assert.equal(map.totalAdded, 0);
    // auth path still classifies Critical even when deleted.
    assert.equal(map.riskDistribution.Critical.files, 1);

    const created = [
      `--- /dev/null`,
      `+++ b/src/new/util.ts`,
      `@@ -0,0 +1,2 @@`,
      `+export const a = 1;`,
      `+export const b = 2;`,
    ].join("\n");
    const createdMap = buildReviewMap(created);
    assert.equal(createdMap.fileCount, 1);
    assert.equal(createdMap.files[0]?.path, "src/new/util.ts");
    assert.equal(createdMap.totalAdded, 2);
  });
});
