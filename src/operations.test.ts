// Operations contract: prompts stay local-first, routing is deterministic,
// results record their handler, and AI text is always separable.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { assistDiagnosis, explainChange, renderAiMarkdown } from "./operations.js";
import { resolveProvider } from "./providers.js";
import type { HttpFn } from "./providers.js";

const ollamaOk = (text: string): HttpFn => (async () => ({
  ok: true, status: 200, text: JSON.stringify({ message: { content: text } }),
})) as HttpFn;

const openAiOk = (text: string): HttpFn => (async () => ({
  ok: true, status: 200, text: JSON.stringify({ choices: [{ message: { content: text } }] }),
})) as HttpFn;

describe("operations", () => {
  it("explain records its handler and keeps AI text separable", async () => {
    const ctx = {
      defaultProvider: resolveProvider({ provider: "ollama", model: "llama3.1" }, {}),
      io: { fetch: ollamaOk("summary here") },
    };
    const res = await explainChange(ctx, { summary: "High", files: ["a.ts"], diffExcerpt: "+x" });
    assert.equal(res.operation, "explain");
    assert.equal(res.handledBy.provider, "ollama");
    assert.match(renderAiMarkdown(res, "AI explain"), /AI-generated/);
    assert.match(renderAiMarkdown(res, "AI explain"), /ollama/);
  });

  it("per-operation routes override without moving credentials", async () => {
    const seen: string[] = [];
    const fetch = (async (url: string) => {
      seen.push(url);
      return { ok: true, status: 200, text: JSON.stringify({ choices: [{ message: { content: "dx" } }] }) };
    }) as HttpFn;
    const ctx = {
      defaultProvider: resolveProvider({ provider: "openai", apiKey: "sk-x", model: "gpt-4o-mini" }, {}),
      routes: { diagnose: "openai:gpt-4o" } as const,
      io: { fetch },
    };
    const res = await assistDiagnosis(ctx, { testPath: "t", summary: "s", causes: ["c"], logExcerpt: "l" });
    assert.equal(res.handledBy.model, "gpt-4o");
    assert.ok(seen[0]?.includes("/chat/completions"));
  });

  it("routing to another provider resolves from its own config, never inherits keys", async () => {
    const ctx = {
      defaultProvider: resolveProvider({ provider: "openai", apiKey: "sk-openai", model: "m" }, {}),
      routes: { explain: "anthropic" } as const,
      io: { fetch: openAiOk("x") },
    };
    // Anthropic has no key configured here → loud validation failure,
    // not a request carrying OpenAI's key to Anthropic.
    await assert.rejects(explainChange(ctx, { summary: "s", files: [], diffExcerpt: "d" }), /anthropic\.apiKey/);
  });
});
