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
});
