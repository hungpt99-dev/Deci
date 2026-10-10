// Adapter contract tests: every protocol adapter must satisfy these.
// All HTTP is mocked — these prove normalization and policy behavior,
// NOT real provider connectivity (see live smoke below, opt-in).
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  checkProvider,
  completeWithPolicy,
  describeProvider,
  PROVIDER_SPECS,
  redactSecrets,
  requireCapabilities,
  resolveProvider,
  routeFor,
  routesFromEnv,
  sendOnce,
  specFor,
  validateProvider,
  ProviderError,
  type ChatMessage,
  type HttpFn,
} from "./providers.js";

const msg = (content: string): ChatMessage[] => [{ role: "user", content }];

function mockFetch(handler: (url: string, body: string, headers: Record<string, string>) => { status: number; text: string }): HttpFn & { calls(): number } {
  let n = 0;
  const seen: Array<{ url: string; body: string }> = [];
  const fn = (async (url: string, init: { body: string; headers: Record<string, string> }) => {
    n += 1;
    seen.push({ url, body: init.body });
    const r = handler(url, init.body, init.headers);
    return { ok: r.status >= 200 && r.status < 300, status: r.status, text: r.text };
  }) as unknown as HttpFn & { calls(): number };
  fn.calls = () => n;
  (fn as unknown as { seen(): Array<{ url: string; body: string }> }).seen = () => seen;
  return fn;
}

const openAiOk = (text = "hi", usage = true): { status: number; text: string } => ({
  status: 200,
  text: JSON.stringify({
    choices: [{ message: { content: text } }],
    model: "gpt-4o-mini",
    ...(usage ? { usage: { prompt_tokens: 10, completion_tokens: 5 } } : {}),
  }),
});

describe("registry", () => {
  it("covers the candidate integrations with honest capability flags", () => {
    for (const id of ["openai", "anthropic", "gemini", "openai-compatible", "openrouter", "litellm", "ollama", "vllm", "vscode-lm"]) {
      assert.ok(specFor(id), `missing spec: ${id}`);
    }
    // Legacy id still resolves.
    assert.equal(specFor("openai-byok")?.id, "openai");
    assert.equal(specFor("nope"), null);
    // No adapter claims streaming/tools (no consumer exists).
    for (const s of PROVIDER_SPECS) {
      assert.equal(s.capabilities.stream, false, s.id);
      assert.equal(s.capabilities.tools, false, s.id);
    }
  });

  it("resolves unified config with per-provider env and redacted describe", () => {
    const p = resolveProvider({}, {
      DECI_PROVIDER: "anthropic",
      DECI_ANTHROPIC_API_KEY: "sk-ant-x",
      DECI_ANTHROPIC_MODEL: "claude-sonnet-4-5",
    });
    assert.equal(p.spec.id, "anthropic");
    assert.equal(p.model, "claude-sonnet-4-5");
    assert.equal(p.dataClass, "cloud");
    assert.ok(!describeProvider(p).includes("sk-ant-x"));
    assert.deepEqual(validateProvider(p), { ok: true, missing: [] });
    const missing = resolveProvider({ provider: "openai" }, {});
    assert.deepEqual(validateProvider(missing).missing, ["openai.apiKey"]);
  });
});

describe("adapter normalization", () => {
  it("openai-chat posts bearer + model and normalizes usage", async () => {
    const fetch = mockFetch(() => openAiOk());
    const p = resolveProvider({ provider: "openai", apiKey: "sk-x", model: "m" }, {});
    const res = await sendOnce(p, { messages: msg("hello") }, { fetch });
    assert.equal(res.text, "hi");
    assert.deepEqual(res.usage, { input: 10, output: 5 });
    assert.deepEqual(res.handledBy, { provider: "openai", model: "m" });
  });

  it("anthropic sends version headers, splits system, maps errors", async () => {
    const seen: Array<{ url: string; body: string; headers: Record<string, string> }> = [];
    const fetch = (async (url: string, init: { body: string; headers: Record<string, string> }) => {
      seen.push({ url, body: init.body, headers: init.headers });
      return { ok: true, status: 200, text: JSON.stringify({ content: [{ type: "text", text: "yo" }], usage: { input_tokens: 3, output_tokens: 4 } }) };
    }) as HttpFn;
    const p = resolveProvider({ provider: "anthropic", apiKey: "k", model: "m" }, {});
    const res = await sendOnce(p, { messages: [{ role: "system", content: "sys" }, ...msg("hi")] }, { fetch });
    assert.equal(res.text, "yo");
    assert.deepEqual(res.usage, { input: 3, output: 4 });
    const body = JSON.parse(seen[0]?.body ?? "{}") as { system?: string; messages: unknown[] };
    assert.equal(body.system, "sys");
    assert.equal(seen[0]?.headers["anthropic-version"], "2023-06-01");
    // Auth failure classifies (no retry).
    const bad = mockFetch(() => ({ status: 401, text: `{"error":{"message":"bad key"}}` }));
    await assert.rejects(sendOnce(p, { messages: msg("x") }, { fetch: bad }), (e: unknown) => {
      assert.ok(e instanceof ProviderError && e.kind === "auth" && !e.retryable);
      return true;
    });
  });

  it("gemini targets generateContent with key param and mime config", async () => {
    let url = "";
    const fetch = (async (u: string, init: { body: string }) => {
      url = u;
      return { ok: true, status: 200, text: JSON.stringify({ candidates: [{ content: { parts: [{ text: "g" }] } }] }) };
    }) as HttpFn;
    const p = resolveProvider({ provider: "gemini", apiKey: "gk", model: "gemini-2.0-flash" }, {});
    const res = await sendOnce(p, { messages: msg("hi"), need: { jsonMode: true } }, { fetch });
    assert.equal(res.text, "g");
    assert.ok(url.includes(":generateContent"));
    assert.ok(url.includes("key="));
  });

  it("ollama posts local chat without key and reads message/response shapes", async () => {
    const fetch = mockFetch(() => ({ status: 200, text: JSON.stringify({ message: { content: "local" } }) }));
    const p = resolveProvider({ provider: "ollama", model: "q" }, {});
    assert.equal((await sendOnce(p, { messages: msg("yo") }, { fetch })).text, "local");
    const legacy = mockFetch(() => ({ status: 200, text: JSON.stringify({ response: "old" }) }));
    assert.equal((await sendOnce(p, { messages: msg("yo") }, { fetch: legacy })).text, "old");
  });

  it("malformed and empty responses are bad-response, never empty text", async () => {
    const p = resolveProvider({ provider: "openai", apiKey: "k", model: "m" }, {});
    for (const text of ["not json", JSON.stringify({ choices: [{ message: { content: "  " } }] })]) {
      await assert.rejects(
        sendOnce(p, { messages: msg("x") }, { fetch: mockFetch(() => ({ status: 200, text })) }),
        (e: unknown) => (e as ProviderError).kind === "bad-response",
      );
    }
  });
});

describe("capabilities", () => {
  it("unsupported jsonMode fails with compatible alternatives, never pretends", async () => {
    const p = resolveProvider({ provider: "anthropic", apiKey: "k", model: "m" }, {});
    await assert.rejects(sendOnce(p, { messages: msg("x"), need: { jsonMode: true } }, { fetch: mockFetch(() => openAiOk()) }), (e: unknown) => {
      const pe = e as ProviderError;
      return pe.kind === "bad-request" && /openai/.test(pe.message) && /gemini/.test(pe.message);
    });
    assert.throws(() => requireCapabilities(p, { stream: true }), /stream/);
  });
});

describe("resilience", () => {
  it("retries rate limits with backoff, never auth errors", async () => {
    let n = 0;
    const fetch = mockFetch(() => (++n < 3 ? { status: 429, text: "slow down" } : openAiOk("recovered")));
    const p = resolveProvider({ provider: "openai", apiKey: "k", model: "m" }, {});
    const res = await completeWithPolicy({ messages: msg("x") }, p, { retries: 3, backoffMs: 1 }, { fetch });
    assert.equal(res.text, "recovered");
    assert.equal(fetch.calls(), 3);
    const authFetch = mockFetch(() => ({ status: 401, text: "nope" }));
    await assert.rejects(completeWithPolicy({ messages: msg("x") }, p, { retries: 3, backoffMs: 1 }, { fetch: authFetch }), /authentication failed/);
    assert.equal(authFetch.calls(), 1);
  });

  it("context-length is terminal and reported, not retried", async () => {
    const fetch = mockFetch(() => ({ status: 400, text: '{"error":{"message":"maximum context length exceeded"}}' }));
    const p = resolveProvider({ provider: "openai", apiKey: "k", model: "m" }, {});
    await assert.rejects(completeWithPolicy({ messages: msg("x") }, p, { retries: 2, backoffMs: 1 }, { fetch }), (e: unknown) => {
      assert.ok((e as ProviderError).kind === "context-length" || /context length exceeded/.test((e as Error).message));
      return true;
    });
    assert.equal(fetch.calls(), 1);
  });

  it("fallback respects capabilities and never crosses local→cloud silently", async () => {
    const down = mockFetch(() => ({ status: 500, text: "boom" }));
    const local = resolveProvider({ provider: "ollama", model: "q" }, {});
    const cloud = resolveProvider({ provider: "openai", apiKey: "k", model: "m" }, {});
    const io = { fetch: down, resolve: (id: string) => (id === "openai" ? cloud : null) };
    // Default: local primary refuses cloud fallback.
    await assert.rejects(
      completeWithPolicy({ messages: msg("x") }, local, { retries: 0, fallback: ["openai"] }, io),
      /All providers failed/,
    );
    // Explicit opt-in allows it: ollama endpoint 500s, OpenAI endpoint answers.
    const routed = mockFetch((url) => (url.includes("/api/chat") ? { status: 500, text: "boom" } : openAiOk("via-cloud")));
    const res = await completeWithPolicy({ messages: msg("x") }, local, { retries: 0, fallback: ["openai"], allowCloudFallback: true }, { fetch: routed, resolve: (id: string) => (id === "openai" ? cloud : null) });
    assert.equal(res.text, "via-cloud");
    assert.ok(res.handledBy.provider.includes("(fallback)"));
  });

  it("cancellation aborts before send and is not retried", async () => {
    const ctl = new AbortController();
    ctl.abort();
    const p = resolveProvider({ provider: "openai", apiKey: "k", model: "m" }, {});
    await assert.rejects(
      sendOnce(p, { messages: msg("x"), signal: ctl.signal }, { fetch: mockFetch(() => openAiOk()) }),
      (e: unknown) => (e as ProviderError).kind === "cancelled",
    );
  });
});

describe("routing", () => {
  it("is deterministic with per-operation overrides and env", () => {
    assert.deepEqual(routeFor("fix", "ollama", {}), { providerId: "ollama", model: null });
    assert.deepEqual(routeFor("fix", "ollama", { fix: "openai:gpt-4o" }), { providerId: "openai", model: "gpt-4o" });
    assert.deepEqual(routeFor("fix", "ollama", { fix: "nope" }), { providerId: "ollama", model: null });
    assert.deepEqual(routesFromEnv({ DECI_ROUTE_DIAGNOSE: "anthropic" }), { diagnose: "anthropic" });
  });
});

describe("secrets", () => {
  it("redacts bearer, api keys, and query keys", () => {
    assert.equal(redactSecrets("Authorization: Bearer sk-live-123"), "Authorization: Bearer ***");
    assert.equal(redactSecrets(`"x-api-key": "sk-ant-x"`), `"x-api-key": "***"`);
    assert.equal(redactSecrets("https://x/models?key=AIza123"), "https://x/models?key=***");
    assert.equal(redactSecrets("token: abc"), "token=***");
  });
});

describe("provider switching", () => {
  it("same request runs on another provider without code changes", async () => {
    const messages = msg("explain this");
    const openai = resolveProvider({ provider: "openai", apiKey: "k", model: "m" }, {});
    const r1 = await sendOnce(openai, { messages }, { fetch: mockFetch(() => openAiOk("from-openai")) });
    const anthropic = resolveProvider({ provider: "anthropic", apiKey: "k2", model: "m2" }, {});
    const r2 = await sendOnce(anthropic, { messages }, {
      fetch: mockFetch(() => ({ status: 200, text: JSON.stringify({ content: [{ type: "text", text: "from-anthropic" }] }) })),
    });
    assert.equal(r1.text, "from-openai");
    assert.equal(r2.text, "from-anthropic");
    assert.equal(r1.handledBy.provider, "openai");
    assert.equal(r2.handledBy.provider, "anthropic");
  });
});
