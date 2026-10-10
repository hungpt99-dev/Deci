import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  analyzeFile,
  analyzeSemantics,
  languageFor,
  parseFileHunks,
  registerAdapter,
} from "./semantic.js";

const file = (path: string, body: string) =>
  `diff --git a/${path} b/${path}\n+++ b/${path}\n${body}`;

const SIX_CATEGORIES = file(
  "src/mixed/service.ts",
  [
    "@@ -1,6 +1,6 @@",
    "-const price = 10;",
    "+const price = calculateDiscount(price);",
    "+jwt.verify(token);",
    "+await tx.transaction(async () => {});",
    "+CREATE TABLE orders (id INT);",
    "+await retry(fetchData, { timeout: 5000 });",
    "+const memo = useMemo(() => heavy(), []);",
    "+export interface OrderDto { id: string }",
  ].join("\n"),
);

describe("semantic", () => {
  it("detects all six categories", () => {
    const cats = new Set(analyzeSemantics(SIX_CATEGORIES).map((f) => f.category));
    for (const c of ["business", "architecture", "data", "security", "reliability", "performance"])
      assert.ok(cats.has(c as never), `missing ${c}: ${[...cats]}`);
  });

  it("ships TS + Java adapters via pluggable interface", () => {
    assert.equal(languageFor("src/a.ts"), "typescript");
    assert.equal(languageFor("svc/Main.java"), "java");
    assert.equal(languageFor("notes.md"), "generic");
    registerAdapter({ id: "test-lang", matches: (p) => p.endsWith(".zz"), rules: [] });
    assert.equal(languageFor("x.zz"), "test-lang"); // no core rewrite needed
    const java = analyzeSemantics(
      file("svc/Order.java", "@@ -1,1 +1,2 @@\n-old\n+@Transactional public void checkout() {}"),
    );
    assert.ok(java.some((f) => f.language === "java" && f.type === "CONSISTENCY_DECISION"));
  });

  it("every finding emits type, before/after, impact, confidence", () => {
    for (const f of analyzeSemantics(SIX_CATEGORIES)) {
      assert.ok(f.type && f.impact && typeof f.confidence === "number");
      assert.ok(f.confidence >= 0 && f.confidence <= 1);
      assert.ok(typeof f.before === "string" && typeof f.after === "string");
      assert.ok(f.id && f.file && f.language);
    }
  });

  it("uncertain items surface, changed files never dropped", () => {
    const plain = analyzeSemantics(file("src/plain/util.ts", "@@ -1,1 +1,1 @@\n-const a = 1;\n+const a = 2;"));
    assert.equal(plain.length, 1);
    assert.equal(plain[0]?.type, "BEHAVIOR_CHANGE");
    assert.equal(plain[0]?.uncertain, true);
    assert.equal(analyzeSemantics("").length, 0);
    assert.deepEqual(parseFileHunks(""), []);
    assert.ok(analyzeFile({ path: "x.ts", added: [], removed: [] }).length === 0);
  });

  it("reports diff-backed line numbers and hunk-local before", () => {
    const hunks = parseFileHunks(
      file("src/auth/login.ts", "@@ -10,2 +20,2 @@\n-const old = 1;\n+jwt.verify(token);"),
    );
    assert.equal(hunks.length, 1);
    assert.deepEqual(hunks[0]?.addedLines, [20]);
    assert.deepEqual(hunks[0]?.addedBefore, [["const old = 1;"]]);
    const findings = analyzeSemantics(
      file("src/auth/login.ts", "@@ -10,2 +20,2 @@\n-const old = 1;\n+jwt.verify(token);"),
    );
    const sec = findings.find((f) => f.type === "SECURITY_DECISION");
    assert.ok(sec);
    assert.equal(sec.line, 20);
    assert.equal(sec.before, "const old = 1;");
    assert.ok(sec.id.includes("src/auth/login.ts:20:"));
  });

  it("leaves before empty on pure additions instead of borrowing unrelated lines", () => {
    const findings = analyzeSemantics(
      file("src/a.ts", "@@ -1,0 +1,2 @@\n+import payload from 'event-stream';\n+export const x = 1;"),
    );
    const dep = findings.find((f) => f.type === "DEPENDENCY_DECISION");
    assert.ok(dep);
    assert.equal(dep.before, "");
  });

  it("pairs each added line with its nearest hunk-local before", () => {
    const findings = analyzeSemantics(
      file("src/p.ts", "@@ -1,2 +1,2 @@\n-if (discountPct > 50) throw new Error();\n+if (discountPct < 0) throw new Error();\n-return Math.round(x);\n+return Math.floor(x);"),
    );
    const first = findings.find((f) => f.after.includes("discountPct < 0"));
    assert.equal(first?.before, "if (discountPct > 50) throw new Error();");
  });

  it("flags removed capability lines and never drops deleted files", () => {
    const deleted = [
      `diff --git a/src/auth/legacy.ts b/src/auth/legacy.ts`,
      `--- a/src/auth/legacy.ts`,
      `+++ /dev/null`,
      `@@ -1,1 +0,0 @@`,
      `-jwt.verify(token);`,
    ].join("\n");
    const hunks = parseFileHunks(deleted);
    assert.equal(hunks.length, 1);
    assert.equal(hunks[0]?.path, "src/auth/legacy.ts");
    const findings = analyzeSemantics(deleted);
    assert.ok(findings.length >= 1);
    assert.ok(findings.some((f) => f.type === "SECURITY_DECISION" && f.line === null));
  });

  it("classifies route-table and router changes as contract decisions", () => {
    const diff = file("src/api.ts", `@@ -1,1 +1,1 @@\n-{ method: "POST", path: "/checkout", handler: "checkout" },\n+{ method: "POST", path: "/v2/checkout", handler: "checkout" },`);
    const findings = analyzeSemantics(diff);
    assert.ok(findings.some((f) => f.type === "API_CONTRACT_DECISION" && f.after.includes("/v2/checkout")));
    const router = analyzeSemantics(file("src/r.ts", "@@ -1,0 +1,1 @@\n+router.post(\"/pay\", handler);"));
    assert.ok(router.some((f) => f.type === "API_CONTRACT_DECISION"));
  });
});
