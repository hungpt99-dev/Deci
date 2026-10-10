// Live smoke tests — OPT-IN ONLY (DECI_LIVE_SMOKE=1).
// These make real network calls and are NEVER part of ordinary unit-test
// execution. They verify actual connectivity, not mocks:
// - default: Ollama on localhost (free, local). Skipped if unreachable?
//   No — when explicitly requested, unreachable means FAIL so CI notices.
// - any provider: set DECI_PROVIDER + credentials, the smoke exercises
//   checkProvider(live) plus one tiny explanation round-trip.
//
// Levels, kept distinct: mocked (providers.test.ts) → local daemon
// (this file, free) → live cloud (this file with cloud env, may cost
// tokens only for providers without a list endpoint, e.g. Anthropic).
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { checkProvider, resolveProvider } from "./providers.js";
import { explainChange } from "./operations.js";

const LIVE = process.env.DECI_LIVE_SMOKE === "1";

describe("live smoke (opt-in)", () => {
  it("local daemon answers config + live check", async (t) => {
    if (!LIVE) {
      t.skip("Set DECI_LIVE_SMOKE=1 with a reachable provider to run live verification.");
      return;
    }
    const p = resolveProvider({}, process.env as Record<string, string | undefined>);
    const h = await checkProvider(p, { live: true, timeoutMs: 10000 });
    assert.ok(h.ok, `live check failed: ${h.detail}`);
  });

  it("explanation round-trip records its handler", async (t) => {
    if (!LIVE) {
      t.skip("Set DECI_LIVE_SMOKE=1 with a reachable provider to run live verification.");
      return;
    }
    const allowCloud = (process.env.DECI_ALLOW_CLOUD_AI ?? "") !== "";
    const p = resolveProvider({}, process.env as Record<string, string | undefined>);
    if (p.dataClass === "cloud" && !allowCloud) {
      t.skip("Cloud provider needs DECI_ALLOW_CLOUD_AI=1 — refusing to send content in a smoke test.");
      return;
    }
    const res = await explainChange(
      { defaultProvider: p, env: process.env as Record<string, string | undefined> },
      { summary: "smoke", files: ["smoke.ts"], diffExcerpt: "+const a = 1;" },
    );
    assert.ok(res.text.trim().length > 0);
    assert.equal(res.handledBy.provider, p.spec.id);
  });
});
