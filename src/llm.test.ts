import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  complete,
  describeConfig,
  resolveProviderConfig,
  validateConfig,
  type ChatMessage,
  type LlmConfig,
} from "./llm.js";

const msg = (content: string): ChatMessage[] => [{ role: "user", content }];

describe("resolveProviderConfig", () => {
  it("defaults to local ollama", () => {
    const c = resolveProviderConfig({}, {});
    assert.equal(c.provider, "ollama");
    assert.equal(c.ollama.baseURL, "http://localhost:11434");
    assert.equal(c.ollama.model, "llama3.1");
  });
  it("honors vscode setting + env with settings winning", () => {
    const c = resolveProviderConfig(
      { provider: "openai-byok", openaiModel: "gpt-4o" },
      { DECI_PROVIDER: "ollama", DECI_OPENAI_MODEL: "o3" },
    );
    assert.equal(c.provider, "openai-byok");
    assert.equal(c.openai.model, "gpt-4o");
  });
  it("falls back to ollama on unknown provider", () => {
    assert.equal(resolveProviderConfig({ provider: "nope" }, {}).provider, "ollama");
  });
  it("reads BYOK baseURL/key and ollama model from env", () => {
    const c = resolveProviderConfig(
      {},
      {
        DECI_PROVIDER: "openai-byok",
        DECI_OPENAI_BASE_URL: "https://proxy/v1",
        DECI_OPENAI_API_KEY: "sk-x",
        DECI_OLLAMA_MODEL: "qwen2.5-coder",
      },
    );
    assert.equal(c.openai.baseURL, "https://proxy/v1");
    assert.equal(c.openai.apiKey, "sk-x");
    assert.equal(c.ollama.model, "qwen2.5-coder");
  });
});

describe("validateConfig/describe", () => {
  it("BYOK missing key fails, vscode-lm always ready", () => {
    const byok = resolveProviderConfig({ provider: "openai-byok" }, {});
    assert.deepEqual(validateConfig(byok), { ok: false, missing: ["openai.apiKey"] });
    const lm = resolveProviderConfig({ provider: "vscode-lm" }, {});
    assert.deepEqual(validateConfig(lm), { ok: true, missing: [] });
  });
  it("never leaks the api key in describe", () => {
    const c = resolveProviderConfig({ provider: "openai-byok" }, { DECI_OPENAI_API_KEY: "sk-secret" });
    assert.ok(!describeConfig(c).includes("sk-secret"));
    assert.ok(describeConfig(c).includes("key set"));
  });
});

describe("complete routing", () => {
  it("BYOK posts OpenAI-compatible endpoint with bearer + model, body carries only messages", async () => {
    let seen = { url: "", headers: {} as Record<string, string>, body: "" };
    const fetch = async (url: string, init: { method: string; headers: Record<string, string>; body: string }) => {
      seen = { url, headers: init.headers, body: init.body };
      return { ok: true, status: 200, text: JSON.stringify({ choices: [{ message: { content: "hi" } }] }) };
    };
    const c: LlmConfig = resolveProviderConfig(
      { provider: "openai-byok" },
      { DECI_OPENAI_BASE_URL: "https://proxy/v1", DECI_OPENAI_API_KEY: "sk-x", DECI_OPENAI_MODEL: "m" },
    );
    assert.equal(await complete(msg("hello"), c, { fetch }), "hi");
    assert.equal(seen.url, "https://proxy/v1/chat/completions");
    assert.equal(seen.headers.authorization, "Bearer sk-x");
    const body = JSON.parse(seen.body) as { model: string; messages: unknown };
    assert.equal(body.model, "m");
    assert.deepEqual(body.messages, [{ role: "user", content: "hello" }]);
  });
  it("ollama posts local /api/chat with stream:false", async () => {
    let seen = { url: "", body: "" };
    const fetch = async (url: string, init: { body: string; method: string; headers: Record<string, string> }) => {
      seen = { url, body: init.body };
      return { ok: true, status: 200, text: JSON.stringify({ message: { content: "local-hi" } }) };
    };
    const c = resolveProviderConfig({ provider: "ollama", ollamaModel: "qwen" }, {});
    assert.equal(await complete(msg("yo"), c, { fetch }), "local-hi");
    assert.equal(seen.url, "http://localhost:11434/api/chat");
    assert.equal((JSON.parse(seen.body) as { stream: boolean }).stream, false);
  });
  it("vscode-lm delegates to host fn and never touches HTTP", async () => {
    let fetched = false;
    const c = resolveProviderConfig({ provider: "vscode-lm" }, {});
    const out = await complete(msg("ed"), c, {
      fetch: async () => {
        fetched = true;
        return { ok: true, status: 200, text: "{}" };
      },
      vscodeLm: async (msgs, model) => `lm:${model ?? "default"}:${msgs[0]?.content}`,
    });
    assert.equal(out, "lm:default:ed");
    assert.equal(fetched, false);
  });
  it("vscode-lm without host throws instead of falling back to HTTP", async () => {
    const c = resolveProviderConfig({ provider: "vscode-lm" }, {});
    await assert.rejects(() => complete(msg("x"), c, { fetch: async () => ({ ok: true, status: 200, text: "{}" }) }), /VS Code host/);
  });
  it("BYOK without key throws before any fetch", async () => {
    let fetched = false;
    const c = resolveProviderConfig({ provider: "openai-byok" }, {});
    await assert.rejects(
      () =>
        complete(msg("x"), c, {
          fetch: async () => {
            fetched = true;
            return { ok: true, status: 200, text: "{}" };
          },
        }),
      /missing: openai\.apiKey/,
    );
    assert.equal(fetched, false);
  });
});
