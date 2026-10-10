import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  applyProposedPatch,
  diagnoseFailure,
  parseFrames,
  renderDiagnosisMarkdown,
} from "./diagnose.js";
import type { TestResult } from "./run.js";

const OUT = `not ok 1 total rejects invalid discount
  error: 'Expected 60 to throw'
  at totalFor (calc.mjs:4:11)
  at TestContext.<anonymous> (test/calc.test.mjs:9:3)`;

const failed = (over: Partial<TestResult> = {}): TestResult => ({
  path: "test/calc.test.mjs",
  command: ["node", "--test", "test/calc.test.mjs"],
  status: "failed", exitCode: 1, output: OUT, durationMs: 12,
  revision: "r1", detail: "exited 1",
  ...over,
});

describe("diagnose", () => {
  it("parses frames and links changed files", () => {
    assert.deepEqual(parseFrames(OUT)[0], { path: "calc.mjs", line: 4, fn: "totalFor" });
    const d = diagnoseFailure(failed(), { changedFiles: ["calc.mjs"] });
    assert.ok(d.links.some((l) => l.why.includes("changed file")));
    assert.ok(d.causes.some((c) => c.standing === "confirmed"));
    assert.match(renderDiagnosisMarkdown(d), /Possible causes/);
  });

  it("withholds blame without changed-file frames", () => {
    const d = diagnoseFailure(failed(), { changedFiles: ["other.mjs"] });
    assert.ok(d.causes.some((c) => c.standing === "hypothesis" && /without more evidence/.test(c.statement)));
    assert.equal(d.patch, null);
  });

  it("links the changed symbol when the stack never enters source", () => {
    const output = `not ok 1 rejects 51\n  error: 'Expected values to be strictly equal'`;
    const d = diagnoseFailure(failed({ output }), {
      changedFiles: ["calc.mjs"],
      symbols: [{ name: "totalFor", file: "calc.mjs", line: 8 }],
      readFile: () => `assert.throws(() => totalFor([], 51));`,
    });
    assert.ok(d.links.some((l) => l.path === "calc.mjs" && /changed symbol/.test(l.why)));
    assert.ok(d.causes.some((c) => c.standing === "confirmed"));
  });

  it("proposes the removed guard only for throw-expecting failures", () => {
    const guard = { path: "calc.mjs", lines: [`if (d < 0 || d > 50) throw new Error("range");`] };
    const withThrow = diagnoseFailure(failed({ output: `${OUT}\nExpected function to throw` }), { changedFiles: ["calc.mjs"], removedGuard: guard });
    assert.ok(withThrow.patch?.diff.includes("+if (d < 0"));
    const withoutThrow = diagnoseFailure(failed({ output: "not ok 1 x\nat f (a.mjs:1:1)" }), { changedFiles: ["a.mjs"], removedGuard: guard });
    assert.equal(withoutThrow.patch, null);
  });

  it("refuses to apply without explicit approval, idempotent with it", () => {
    const patch = { path: "calc.mjs", diff: "diff", description: "guard" };
    const store = new Map([["calc.mjs", `export function f(d) {\n  return d;\n}`]]);
    const io = { read: (p: string) => store.get(p) as string, write: (p: string, c: string) => { store.set(p, c); } };
    const refused = applyProposedPatch(patch, [`if (d < 0) throw new Error("x");`], io, { approve: false });
    assert.equal(refused.applied, false);
    assert.ok(store.get("calc.mjs")?.startsWith("export function"));
    const applied = applyProposedPatch(patch, [`if (d < 0) throw new Error("x");`], io, { approve: true });
    assert.equal(applied.applied, true);
    assert.ok(store.get("calc.mjs")?.includes(`if (d < 0) throw`));
    const noop = applyProposedPatch(patch, [`if (d < 0) throw new Error("x");`], io, { approve: true });
    assert.match(noop.detail, /No-op/);
  });
});
