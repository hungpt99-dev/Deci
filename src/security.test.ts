// Security regression tests: untrusted diffs must not direct writes
// outside the analysis scope, and secrets must not leak into output.
// These spawn the real CLI (black-box) in disposable temp dirs.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(REPO, "dist", "cli.js");

function runCli(args: string[], cwd: string): { code: number; out: string } {
  try {
    const out = execFileSync("node", [CLI, ...args], { cwd, encoding: "utf8", timeout: 60000 }) as string;
    return { code: 0, out };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? 1, out: `${e.stdout ?? ""}\n${e.stderr ?? ""}` };
  }
}

describe("security", () => {
  it("refuses diff-directed writes outside the analysis scope", () => {
    const base = mkdtempSync(join(tmpdir(), "deci-sec-"));
    const root = join(base, "root");
    mkdirSync(root, { recursive: true });
    writeFileSync(join(base, "victim.mjs"), `export function totalFor(items, discountPct) {\n  if (discountPct < 0) throw new Error("bad");\n  return 1;\n}\n`);
    writeFileSync(join(base, "attack.diff"), `diff --git a/../victim.mjs b/../victim.mjs\n--- a/../victim.mjs\n+++ b/../victim.mjs\n@@ -1,3 +1,4 @@\n export function totalFor(items, discountPct) {\n+export const EXTRA = 1;\n   if (discountPct < 0) throw new Error("bad");\n`);
    const r = runCli(["analyze", "--root", root, "--file", join(base, "attack.diff"), "--generate-tests", "--write-tests"], REPO);
    assert.ok(!existsSync(join(base, "victim.test.mjs")), "must not write outside scope");
    assert.match(r.out, /escapes the analysis scope/);
  });

  it("rejects shell metacharacters in --diff ranges without executing", () => {
    const marker = join(tmpdir(), `deci-pwn-${Date.now()}`);
    const r = runCli(["analyze", "--diff", `main; touch ${marker}`], REPO);
    assert.equal(r.code, 1);
    assert.ok(!existsSync(marker));
    assert.match(r.out, /unsafe --diff range/);
  });

  it("redacts keys from provider output and errors", async () => {
    const { redactSecrets } = await import("./providers.js");
    assert.equal(redactSecrets("Authorization: Bearer sk-live-123"), "Authorization: Bearer ***");
    assert.ok(!redactSecrets("key=sk-x").includes("sk-x"));
  });
});
