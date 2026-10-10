import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { generateTests, renderGeneratedMarkdown, writeGeneratedTests } from "./generate.js";
import type { ChangedSymbol } from "./symbols.js";

const sym = (over: Partial<ChangedSymbol> & { name: string }): ChangedSymbol => ({
  kind: "function", file: "src/pricing.ts", line: 5, change: "modified",
  signature: "export function totalFor(items, discountPct)",
  ...over,
});

const SRC = `export function totalFor(items, discountPct) {
  if (discountPct < 0) throw new Error("bad");
  return items.length;
}`;

describe("generate", () => {
  const io = { readFile: () => SRC };

  it("references real imports, calls, and observed guards", () => {
    const [g] = generateTests([sym({ name: "totalFor" })], io, "node:test");
    assert.ok(g);
    assert.equal(g.target, "src/pricing.ts#totalFor");
    assert.ok(g.source.includes(`from "./pricing.js"`) || g.source.includes(`from "../pricing.js"`) || g.source.includes("pricing"));
    assert.ok(g.source.includes("totalFor("));
    assert.ok(g.covers.some((c) => c.includes("guard-derived")));
    assert.match(g.source, /assert\.throws/);
    assert.match(renderGeneratedMarkdown([g]), /review before keeping/);
  });

  it("casts intentionally wrong-typed probes so strict tsc keeps passing", () => {
    const [g] = generateTests(
      [sym({ name: "totalFor", signature: "export function totalFor(items: CartItem[], discountPct: number)" })],
      { readFile: () => `export interface CartItem { unit: number }\nexport function totalFor(items: CartItem[], discountPct: number) {\n  if (discountPct < 0) throw new Error("bad");\n  return 1;\n}` },
      "node:test",
    );
    assert.ok(g?.source.includes("import { totalFor, type CartItem }"));
    assert.ok(g?.source.includes("as unknown as CartItem[]"));
    assert.ok(g?.source.includes("as unknown as number"));
  });

  it("omits throws-tests when no guard is observed", () => {
    const [g] = generateTests([sym({ name: "pure", signature: "export function pure(a)" })], { readFile: () => `export function pure(a) { return a; }` }, "node:test");
    assert.ok(g && !g.source.includes("assert.throws"));
  });

  it("asserts live exports for endpoints", () => {
    const [g] = generateTests(
      [sym({ name: "/checkout", kind: "endpoint", signature: `app.post("/checkout")` })],
      { readFile: () => `export const routes = [{ path: "/checkout" }];` },
      "node:test",
    );
    assert.ok(g?.source.includes("routes"));
    assert.ok(g?.covers.some((c) => c.includes("contract")));
  });

  it("never overwrites without explicit force", () => {
    const store = new Map<string, string>([["src/p.test.ts", "mine"]]);
    const io2 = { exists: (p: string) => store.has(p), write: (p: string, c: string) => { store.set(p, c); } };
    const tests = generateTests([sym({ name: "totalFor" })], io, "node:test");
    const testPath = tests[0]?.path as string;
    store.set(testPath, "mine");
    const refused = writeGeneratedTests(tests, io2);
    assert.equal(refused.written.length, 0);
    assert.equal(store.get(testPath), "mine");
    const forced = writeGeneratedTests(tests, io2, { force: true });
    assert.deepEqual(forced.written, [testPath]);
  });
});
