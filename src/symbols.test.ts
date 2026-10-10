import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseFileHunks } from "./semantic.js";
import { capabilitiesFor, extractSymbols, symbolsForHunks } from "./symbols.js";

const hunk = (path: string, body: string) => parseFileHunks(
  `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n${body}`,
)[0]!;

describe("symbols", () => {
  it("extracts added/modified/removed declarations with lines", () => {
    const syms = extractSymbols(hunk(
      "src/pricing.ts",
      "@@ -1,4 +1,5 @@\n-export function lineTotal(item) {\n+export function lineTotal(item: Item): number {\n+export const CENTS = 100;\n const x = 1;",
    ));
    const fn = syms.find((s) => s.name === "lineTotal");
    assert.equal(fn?.kind, "function");
    assert.equal(fn?.change, "modified");
    assert.equal(fn?.line, 1);
    const c = syms.find((s) => s.name === "CENTS");
    assert.equal(c?.kind, "constant");
    assert.equal(c?.change, "added");
  });

  it("marks pure removals with null line", () => {
    const syms = extractSymbols(hunk(
      "src/old.ts",
      "@@ -1,2 +0,0 @@\n-export function gone() {\n-}",
    ));
    assert.equal(syms.length, 1);
    assert.equal(syms[0]?.change, "removed");
    assert.equal(syms[0]?.line, null);
  });

  it("detects classes, interfaces, and endpoints", () => {
    const syms = symbolsForHunks(parseFileHunks(
      `diff --git a/svc/A.java b/svc/A.java\n--- a/svc/A.java\n+++ b/svc/A.java\n@@ -1,1 +1,3 @@\n+@GetMapping("/orders")\n+public class OrderApi {\n+public List<Order> list() {`,
    ));
    assert.ok(syms.some((s) => s.kind === "endpoint"));
    assert.ok(syms.some((s) => s.name === "OrderApi" && s.kind === "class"));
    assert.ok(syms.some((s) => s.name === "list" && s.kind === "method"));
  });

  it("detects route-table entries and router calls as endpoints", () => {
    const syms = symbolsForHunks(parseFileHunks(
      `diff --git a/src/api.ts b/src/api.ts\n--- a/src/api.ts\n+++ b/src/api.ts\n@@ -1,1 +1,1 @@\n-{ method: "POST", path: "/checkout", handler: "x" },\n+{ method: "POST", path: "/v2/checkout", handler: "x" },\n+router.post("/pay", h);`,
    ));
    assert.ok(syms.some((s) => s.kind === "endpoint" && s.name === "/v2/checkout"));
    assert.ok(syms.some((s) => s.kind === "endpoint"));
  });

  it("documents honest per-language capabilities", () => {
    assert.equal(capabilitiesFor("src/a.ts").language, "typescript");
    assert.equal(capabilitiesFor("svc/A.java").language, "java");
    assert.equal(capabilitiesFor("notes.md").language, "generic");
    // No module claims full AST parsing.
    for (const c of [capabilitiesFor("src/a.ts"), capabilitiesFor("svc/A.java")]) {
      assert.ok(c.note.length > 0);
      assert.notEqual(c.symbolParsing, "supported");
    }
  });
});
