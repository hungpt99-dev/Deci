import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { redactSecrets, renderResultsMarkdown, runTests, summarizeResults } from "./run.js";
import type { SelectedTest } from "./select.js";

const t = (path: string, command: string[] = ["node", "--test", path]): SelectedTest => ({
  path, command, category: "unit", layer: "backend", framework: "node:test",
  unrunnable: null, reason: "test", basis: "confirmed",
});

describe("run", () => {
  it("reports pass/fail from real exit codes with durations", async () => {
    const results = await runTests(
      [t("a"), t("b")],
      {
        revision: "r1",
        spawn: (cmd) => cmd[2] === "a"
          ? { exitCode: 0, output: "ok", timedOut: false }
          : { exitCode: 1, output: "not ok 1 boom\nat x (a.js:3:1)", timedOut: false },
      },
    );
    assert.equal(results[0]?.status, "passed");
    assert.equal(results[0]?.exitCode, 0);
    assert.equal(results[0]?.output, "");
    assert.equal(results[1]?.status, "failed");
    assert.ok((results[1]?.output.length ?? 0) > 0);
    assert.ok(results.every((r) => r.revision === "r1" && r.durationMs >= 0));
    assert.deepEqual(summarizeResults(results), { passed: 1, failed: 1, skipped: 0, blocked: 0, unexecuted: 0 });
    assert.match(renderResultsMarkdown(results), /1 passed, 1 failed/);
  });

  it("treats timeouts as failures and missing tools as skip", async () => {
    const results = await runTests(
      [t("slow"), t("gone")],
      {
        spawn: (cmd) => cmd[2] === "slow"
          ? { exitCode: null, output: "Timed out after 10ms.", timedOut: true }
          : (() => { throw new Error("spawn gone ENOENT"); })(),
      },
    );
    assert.equal(results[0]?.status, "failed");
    assert.match(results[0]?.detail ?? "", /Timed out/);
    assert.equal(results[1]?.status, "skipped");
  });

  it("blocks unrunnable entries and honors cancellation", async () => {
    const blocked = await runTests([{ ...t("x"), command: [], unrunnable: "nope" }]);
    assert.equal(blocked[0]?.status, "blocked");
    const ctl = new AbortController();
    ctl.abort();
    const cancelled = await runTests([t("a")], { signal: ctl.signal, spawn: () => ({ exitCode: 0, output: "", timedOut: false }) });
    assert.equal(cancelled[0]?.status, "unexecuted");
  });

  it("redacts credential-shaped values from logs", () => {
    assert.equal(redactSecrets("api_key=supersecret123 ok"), "api_key=*** ok");
    assert.equal(redactSecrets("token: abc"), "token=***");
  });
});
