// Vertical slice, real tools end to end (in a tmp copy — the repo is never
// touched): discover → select → generate → RUN (node --test, real exit
// codes) → diagnose failure → approved patch → re-run green.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { discoverTests, type DiscoverIo } from "./discover.js";
import { selectTests } from "./select.js";
import { runTests, summarizeResults } from "./run.js";
import { generateTests, writeGeneratedTests } from "./generate.js";
import { applyProposedPatch, diagnoseFailure } from "./diagnose.js";
import { buildImpactMap, type ImpactIo } from "./impact.js";
import { symbolsForHunks } from "./symbols.js";
import { parseFileHunks } from "./semantic.js";

function walk(root: string, out: string[] = []): string[] {
  for (const e of readdirSync(root)) {
    const p = join(root, e);
    if (statSync(p).isDirectory()) {
      if (e === "node_modules" || e === ".git") continue;
      walk(p, out);
    } else out.push(p);
  }
  return out;
}

describe("pipeline", () => {
  it("change → select → generate → run → diagnose → fix → green", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "deci-e2e-"));
    const calcSrc = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "calc");
    cpSync(calcSrc, tmp, { recursive: true });
    const rel = (p: string) => p.slice(tmp.length + 1);
    const io = {
      listFiles: () => walk(tmp).map(rel),
      read: (p: string) => readFileSync(join(tmp, p), "utf8"),
    };

    // 1. Discover real tests with real commands.
    const discovery = discoverTests(io as DiscoverIo, ".");
    assert.ok(discovery.tests.some((t) => t.path.endsWith("calc.test.mjs")));
    const existing = discovery.tests.find((t) => t.path.endsWith("calc.test.mjs"))!;
    assert.ok(existing.command.length > 0);

    // 2. A change to calc.mjs selects the sibling test (confirmed).
    const hunks = parseFileHunks(
      `diff --git a/calc.mjs b/calc.mjs\n--- a/calc.mjs\n+++ b/calc.mjs\n@@ -6,5 +6,5 @@\n export function totalFor(items, discountPct) {\n-  if (discountPct < 0 || discountPct > 50) throw new RangeError("discount out of range");\n+  if (discountPct < 0) throw new RangeError("discount out of range");\n   const subtotal = 1;\n   return subtotal;\n }`,
    );
    const symbols = symbolsForHunks(hunks);
    assert.ok(symbols.some((s) => s.name === "totalFor"));
    const impact = buildImpactMap(symbols, ["calc.mjs"], io as ImpactIo, ".");
    const sel = selectTests(["calc.mjs"], impact, discovery.tests);
    assert.ok(sel.selected.some((t) => t.path.endsWith("calc.test.mjs")));

    // 3. Generate a guard test from the real symbol (reviewable scaffold).
    // previousLines pin the REMOVED guard so the scaffold asserts the old
    // contract (discount 51 must throw) — it fails honestly on buggy code.
    const gen = generateTests(
      symbols,
      { readFile: (p) => { try { return io.read(p); } catch { return null; } } },
      "node:test",
      { previousLines: [`if (discountPct < 0 || discountPct > 50) throw new RangeError("discount out of range");`] },
    );
    assert.ok(gen.length > 0 && gen.every((g) => g.generated));
    const written = writeGeneratedTests(gen, {
      exists: (p) => existsSync(join(tmp, p)),
      write: (p, c) => writeFileSync(join(tmp, p), c),
    });
    assert.ok(written.written.length > 0);

    // 4. Run for real: existing passes, generated guard test FAILS honestly.
    const rediscover = discoverTests(io as DiscoverIo, ".");
    const runSel = selectTests(["calc.mjs"], impact, rediscover.tests);
    const results = await runTests(runSel.selected, { cwd: tmp, revision: "e2e-tmp", timeoutMs: 30000 });
    const s = summarizeResults(results);
    assert.ok(s.passed >= 1, `expected a pass, got ${JSON.stringify(s)}`);
    assert.ok(s.failed >= 1, `expected a real failure, got ${JSON.stringify(s)}`);
    const failed = results.find((r) => r.status === "failed")!;
    assert.ok(failed.exitCode !== 0 && failed.output.length > 0);

    // 5. Diagnose: frame lands in the changed file → confirmed suspect.
    const removedGuard = {
      path: "calc.mjs",
      lines: [`if (discountPct < 0 || discountPct > 50) throw new RangeError("discount out of range");`],
    };
    const d = diagnoseFailure(failed, {
      changedFiles: ["calc.mjs"],
      symbols,
      readFile: (p) => readFileSync(join(tmp, p), "utf8"),
      removedGuard,
    });
    assert.ok(d.causes.some((c) => c.standing === "confirmed"));
    assert.ok(d.patch, "expected a proposed guard patch");

    // 6. Approval gate respected, then approved fix → re-run green.
    const noApproval = applyProposedPatch(d.patch!, removedGuard.lines, {
      read: (p) => readFileSync(join(tmp, p), "utf8"),
      write: (p, c) => writeFileSync(join(tmp, p), c),
    }, { approve: false });
    assert.equal(noApproval.applied, false);
    const yesApproval = applyProposedPatch(d.patch!, removedGuard.lines, {
      read: (p) => readFileSync(join(tmp, p), "utf8"),
      write: (p, c) => writeFileSync(join(tmp, p), c),
    }, { approve: true });
    assert.equal(yesApproval.applied, true);
    const rerun = await runTests(runSel.selected, { cwd: tmp, revision: "e2e-tmp-fixed", timeoutMs: 30000 });
    assert.deepEqual(summarizeResults(rerun), { passed: rerun.length, failed: 0, skipped: 0, blocked: 0, unexecuted: 0 });
  });
});
