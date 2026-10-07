import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildReviewMap } from "./reviewMap.js";
import {
  applyVerification,
  checkApiSchemaUnchanged,
  checkForbiddenDeps,
  planChecks,
  renderVerifyMarkdown,
  runCommandChecks,
  runFullVerify,
  type ExecFn,
} from "./verify.js";

const tsDiff = (body: string) =>
  `diff --git a/src/app.ts b/src/app.ts\n+++ b/src/app.ts\n${body}`;

const okExec: ExecFn = () => ({ exitCode: 0, output: "" });
const failExec: ExecFn = () => ({ exitCode: 1, output: "boom\ntrace line 2" });
const missingExec: ExecFn = () => {
  throw new Error("spawn npx ENOENT");
};

describe("verify", () => {
  it("plans per-language shell checks; docs-only plans none", () => {
    const ts = planChecks(["src/a.ts"]);
    assert.equal(ts.length, 4);
    assert.ok(ts.some((s) => s.id === "typescript-build"));
    const java = planChecks(["svc/Main.java"]);
    assert.equal(java.length, 4);
    assert.ok(java.some((s) => s.id === "java-unit-tests"));
    assert.deepEqual(planChecks(["README.md"]), []);
  });

  it("api-schema check fails only when contracts touched", () => {
    assert.equal(checkApiSchemaUnchanged(tsDiff("@@ -1,1 +1,1 @@\n-a\n+b")).status, "pass");
    const bad = checkApiSchemaUnchanged(
      `diff --git a/api/openapi.yaml b/api/openapi.yaml\n+++ b/api/openapi.yaml\n@@ -1,1 +1,1 @@\n-a\n+b`,
    );
    assert.equal(bad.status, "fail");
    assert.ok(bad.logRef);
    assert.match(bad.detail, /openapi\.yaml/);
  });

  it("forbidden-deps check catches added imports", () => {
    assert.equal(checkForbiddenDeps(tsDiff("@@ -1,1 +1,1 @@\n-a\n+b")).status, "pass");
    const bad = checkForbiddenDeps(tsDiff("@@ -1,1 +1,2 @@\n const x = 1;\n+import payload from 'event-stream';"));
    assert.equal(bad.status, "fail");
    assert.ok(bad.logRef);
    assert.match(bad.detail, /event-stream/);
  });

  it("command runner maps exit codes; missing toolchain skips", () => {
    const specs = planChecks(["src/a.ts"]);
    assert.ok(runCommandChecks(specs, okExec).every((c) => c.status === "pass"));
    const failed = runCommandChecks(specs, failExec);
    assert.ok(failed.every((c) => c.status === "fail"));
    assert.ok(failed.every((c) => c.logRef));
    assert.ok(runCommandChecks(specs, missingExec).every((c) => c.status === "skip"));
  });

  it("full verify collapses Low-risk files into Verified bucket", () => {
    const diff = [
      `diff --git a/README.md b/README.md`,
      `+++ b/README.md`,
      `@@ -1,1 +1,1 @@`,
      `-a`,
      `+b`,
    ].join("\n");
    const report = runFullVerify(diff, { exec: okExec });
    assert.equal(report.allPass, true);
    assert.deepEqual(report.verifiedPaths, ["README.md"]);
    const collapsed = applyVerification(buildReviewMap(diff), report.verifiedPaths);
    assert.equal(collapsed.riskDistribution.Verified.files, 1);
    assert.equal(collapsed.riskDistribution.Verified.loc, 2);
    assert.equal(collapsed.riskDistribution.Low.files, 0);
  });

  it("failing verify keeps files in human review with log links", () => {
    const report = runFullVerify(tsDiff("@@ -1,1 +1,1 @@\n-a\n+b"), { exec: failExec });
    assert.equal(report.allPass, false);
    assert.deepEqual(report.verifiedPaths, []);
    const md = renderVerifyMarkdown(report);
    assert.match(md, /✗/);
    assert.match(md, /verify-logs\//);
    assert.match(md, /<details>/);
    assert.match(md, /No files auto-verified/);
  });

  it("static-only mode skips shell, empty diff verifies nothing", () => {
    const report = runFullVerify(tsDiff("@@ -1,1 +1,1 @@\n-a\n+b"), { runCommands: false });
    assert.ok(report.checks.some((c) => c.status === "skip"));
    assert.equal(runFullVerify("", { exec: okExec }).verifiedPaths.length, 0);
    const md = renderVerifyMarkdown(runFullVerify("", { exec: okExec }));
    assert.match(md, /✓/);
    assert.match(md, /<details>|No files auto-verified/);
  });
});
