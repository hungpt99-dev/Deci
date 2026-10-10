// Provider-agnostic AI architecture. Pure config + protocol adapters;
// no SDKs (fetch only), no business logic, no UI coupling.
//
// Layering:
// - ProviderSpec registry: WHAT each vendor speaks (protocol, auth, key
//   needs, locality, default capabilities). 9 entries, 4 wire protocols.
// - ResolvedProvider: a validated, redacted-safe runtime handle.
// - Adapters: protocol HTTP in/out plus error taxonomy. Vendor quirks live
//   here and nowhere else.
// - completeWithPolicy: bounded retry + capability-gated fallback.
// - routeFor: deterministic per-operation provider selection.
//
// What is deliberately NOT here: streaming and tool calling. No Deci
// feature consumes them; requesting either throws an honest error naming
// compatible alternatives instead of pretending.

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export type Protocol = "openai-chat" | "anthropic-messages" | "gemini-generate" | "ollama-chat" | "editor";
export type AuthKind = "bearer" | "x-api-key" | "none" | "editor";
export type DataClass = "local" | "cloud";

export interface Capabilities {
  /** Stable text completion (the only capability Deci operations require). */
  text: boolean;
  /** Streaming responses. No Deci consumer — always false, honestly. */
  stream: boolean;
  /** Tool/function calling. No Deci consumer — always false, honestly. */
  tools: boolean;
  /** Native JSON-mode response format. */
  jsonMode: boolean;
  /** Long-context input (>=100k tokens class). Informational. */
  longContext: boolean;
}

export interface ProviderSpec {
  id: string;
  label: string;
  protocol: Protocol;
  auth: AuthKind;
  defaultBaseURL: string | null;
  needsKey: boolean;
  local: boolean;
  aliases?: string[];
  capabilities: Capabilities;
  notes: string;
}

const NO_STREAM_TOOLS: Pick<Capabilities, "stream" | "tools"> = { stream: false, tools: false };

export const PROVIDER_SPECS: ProviderSpec[] = [
  { id: "openai", label: "OpenAI", protocol: "openai-chat", auth: "bearer", defaultBaseURL: "https://api.openai.com/v1", needsKey: true, local: false, aliases: ["openai-byok"], capabilities: { text: true, jsonMode: true, longContext: true, ...NO_STREAM_TOOLS }, notes: "Chat Completions API. Key via Authorization: Bearer." },
  { id: "anthropic", label: "Anthropic", protocol: "anthropic-messages", auth: "x-api-key", defaultBaseURL: "https://api.anthropic.com", needsKey: true, local: false, capabilities: { text: true, jsonMode: false, longContext: true, ...NO_STREAM_TOOLS }, notes: "Messages API with x-api-key + anthropic-version headers. No native JSON mode — request jsonMode fails honestly." },
  { id: "gemini", label: "Google Gemini", protocol: "gemini-generate", auth: "bearer", defaultBaseURL: "https://generativelanguage.googleapis.com", needsKey: true, local: false, capabilities: { text: true, jsonMode: true, longContext: true, ...NO_STREAM_TOOLS }, notes: "generateContent; key as ?key= query param." },
  { id: "openai-compatible", label: "OpenAI-compatible endpoint", protocol: "openai-chat", auth: "bearer", defaultBaseURL: null, needsKey: true, local: false, capabilities: { text: true, jsonMode: true, longContext: false, ...NO_STREAM_TOOLS }, notes: "Any server speaking POST {base}/chat/completions. Compatibility is endpoint-tested, not assumed from the name." },
  { id: "openrouter", label: "OpenRouter", protocol: "openai-chat", auth: "bearer", defaultBaseURL: "https://openrouter.ai/api/v1", needsKey: true, local: false, capabilities: { text: true, jsonMode: true, longContext: true, ...NO_STREAM_TOOLS }, notes: "OpenAI-compatible gateway; model ids are vendor/model." },
  { id: "litellm", label: "LiteLLM proxy", protocol: "openai-chat", auth: "bearer", defaultBaseURL: "http://localhost:4000", needsKey: true, local: false, capabilities: { text: true, jsonMode: true, longContext: false, ...NO_STREAM_TOOLS }, notes: "Self-hosted OpenAI-compatible proxy. longContext varies by backing model — left false until configured." },
  { id: "ollama", label: "Ollama (local)", protocol: "ollama-chat", auth: "none", defaultBaseURL: "http://localhost:11434", needsKey: false, local: true, capabilities: { text: true, jsonMode: false, longContext: false, ...NO_STREAM_TOOLS }, notes: "Local daemon; no key. /api/chat non-streaming." },
  { id: "vllm", label: "vLLM (self-hosted)", protocol: "openai-chat", auth: "bearer", defaultBaseURL: "http://localhost:8000/v1", needsKey: false, local: true, capabilities: { text: true, jsonMode: false, longContext: false, ...NO_STREAM_TOOLS }, notes: "Self-hosted OpenAI-compatible server. Key optional (often --api-key unset); jsonMode off unless --guided-json is on." },
  { id: "vscode-lm", label: "VS Code Language Model", protocol: "editor", auth: "editor", defaultBaseURL: null, needsKey: false, local: false, capabilities: { text: true, jsonMode: false, longContext: false, ...NO_STREAM_TOOLS }, notes: "Editor entitlement; never touches HTTP. Locality follows the editor's own policy." },
];

export function specFor(id: string): ProviderSpec | null {
  const want = id.trim().toLowerCase();
  return PROVIDER_SPECS.find((s) => s.id === want || s.aliases?.includes(want)) ?? null;
}

// --- Resolution -----------------------------------------------------------

export interface ProviderInput {
  provider?: string;
  baseURL?: string;
  apiKey?: string;
  model?: string;
  /** Explicit capability overrides (user knows their deployment best). */
  capabilities?: Partial<Capabilities>;
}

export interface ResolvedProvider {
  spec: ProviderSpec;
  baseURL: string | null;
  /** Present but never logged; use hasKey for display. */
  apiKey: string;
  hasKey: boolean;
  model: string;
  capabilities: Capabilities;
  dataClass: DataClass;
}

function clean(v: string | undefined | null): string {
  return (v ?? "").trim();
}

/**
 * Resolve provider + model + endpoint + key from explicit input, falling
 * back to DECI_* env, then spec defaults. Unknown provider ids fall back
 * to ollama (local-first default) rather than failing config time.
 */
export function resolveProvider(
  input: ProviderInput = {},
  env: Record<string, string | undefined> = {},
): ResolvedProvider {
  const pick = (...vals: Array<string | undefined>): string =>
    clean(vals.find((v) => clean(v) !== undefined && clean(v) !== "") ?? "");
  const raw = pick(input.provider, env.DECI_PROVIDER, "ollama");
  const spec = specFor(raw) ?? (specFor("ollama") as ProviderSpec);
  const upper = spec.id.toUpperCase().replace(/-/g, "_");
  const baseURL = pick(input.baseURL, env[`DECI_${upper}_BASE_URL`], env.DECI_BASE_URL, spec.defaultBaseURL ?? "") || null;
  const apiKey = pick(input.apiKey, env[`DECI_${upper}_API_KEY`], env.DECI_API_KEY, "");
  const model = pick(input.model, env[`DECI_${upper}_MODEL`], env.DECI_MODEL, defaultModelFor(spec));
  return {
    spec,
    baseURL,
    apiKey,
    hasKey: apiKey !== "",
    model,
    capabilities: { ...spec.capabilities, ...(input.capabilities ?? {}) },
    dataClass: spec.local ? "local" : "cloud",
  };
}

function defaultModelFor(spec: ProviderSpec): string {
  switch (spec.id) {
    case "openai": return "gpt-4o-mini";
    case "anthropic": return "claude-sonnet-4-5";
    case "gemini": return "gemini-2.0-flash";
    case "openrouter": return "openai/gpt-4o-mini";
    case "ollama": return "llama3.1";
    case "vllm": return "meta-llama/Llama-3.1-8B-Instruct";
    case "litellm": return "gpt-4o-mini";
    default: return "";
  }
}

/** What is missing before this provider can run. Pure. */
export function validateProvider(p: ResolvedProvider): { ok: boolean; missing: string[] } {
  const missing: string[] = [];
  if (p.spec.needsKey && !p.hasKey) missing.push(`${p.spec.id}.apiKey`);
  if (p.spec.protocol !== "editor" && !p.spec.defaultBaseURL && !p.baseURL) missing.push(`${p.spec.id}.baseURL`);
  if (p.spec.protocol !== "editor" && !p.model) missing.push(`${p.spec.id}.model`);
  return { ok: missing.length === 0, missing };
}

/** One-liner for logs/panels. Key presence only, never the value. */
export function describeProvider(p: ResolvedProvider): string {
  const key = p.spec.needsKey ? (p.hasKey ? "key set" : "key missing") : "no key";
  const where = p.baseURL ?? "editor";
  return `Provider: ${p.spec.id} (${where}, model ${p.model || "—"}, ${key})${p.spec.local ? " — local" : ""}`;
}

/** Scrub credential material from any string destined for logs/errors. */
export function redactSecrets(s: string): string {
  return s
    .replace(/(Bearer\s+)[^\s"'}]+/g, "$1***")
    .replace(/(api[_-]?key|secret|token|password|passwd|pwd)\s*[:=]\s*(\S+)/gi, "$1=***")
    .replace(/\bkey\s*[:=]\s*["']?[^"'\s,}]+/gi, "key=***")
    .replace(/(api[_-]?key["'\s:=]+)[^"'\s,}]+/gi, "$1***")
    .replace(/([?&]key=)[^&\s"'}]+/g, "$1***");
}

// --- Request / response model ---------------------------------------------

export interface ChatRequest {
  messages: ChatMessage[];
  /** Requested capabilities; gated before any network call. */
  need?: Partial<Pick<Capabilities, "jsonMode" | "stream" | "tools">>;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface ChatResponse {
  text: string;
  model?: string;
  usage?: { input: number; output: number };
  handledBy: { provider: string; model: string };
}

export type ErrorKind =
  | "auth" | "rate-limit" | "network" | "timeout" | "context-length"
  | "bad-request" | "bad-response" | "unavailable" | "cancelled";

export class ProviderError extends Error {
  readonly kind: ErrorKind;
  readonly provider: string;
  readonly status: number | null;
  readonly retryable: boolean;
  constructor(kind: ErrorKind, provider: string, message: string, opts: { status?: number | null; retryable?: boolean } = {}) {
    super(message);
    this.name = "ProviderError";
    this.kind = kind;
    this.provider = provider;
    this.status = opts.status ?? null;
    this.retryable = opts.retryable ?? (kind === "rate-limit" || kind === "network" || kind === "timeout" || kind === "unavailable");
  }
}

export type HttpFn = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; text: string }>;

export interface SendOpts {
  fetch?: HttpFn;
  vscodeLm?: (messages: ChatMessage[], model: string | null) => Promise<string>;
}

function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, "")}${path}`;
}

async function postJson(fetch: HttpFn, url: string, headers: Record<string, string>, body: unknown, provider: string, timeoutMs: number, signal?: AbortSignal): Promise<{ status: number; text: string }> {
  const ctrl = new AbortController();
  const onAbort = (): void => ctrl.abort();
  let timer: ReturnType<typeof setTimeout> | null = null;
  if (signal?.aborted) throw new ProviderError("cancelled", provider, `${provider}: request cancelled before send`, { retryable: false });
  if (signal) signal.addEventListener("abort", onAbort, { once: true });
  if (timeoutMs > 0) timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal: ctrl.signal });
    return { status: res.status, text: res.text };
  } catch (err) {
    if (ctrl.signal.aborted && !signal?.aborted) throw new ProviderError("timeout", provider, `${provider}: timed out after ${timeoutMs}ms`, { retryable: true });
    if (signal?.aborted || /abort/i.test((err as Error).message ?? "")) throw new ProviderError("cancelled", provider, `${provider}: request cancelled`, { retryable: false });
    throw new ProviderError("network", provider, `${provider}: network error: ${redactSecrets((err as Error).message ?? String(err)).slice(0, 200)}`, { retryable: true });
  } finally {
    if (timer) clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

function classifyStatus(provider: string, status: number, text: string): ProviderError {
  const clip = redactSecrets(text).slice(0, 300);
  if (status === 401 || status === 403) return new ProviderError("auth", provider, `${provider}: authentication failed (HTTP ${status}): ${clip}`, { status, retryable: false });
  if (status === 429) return new ProviderError("rate-limit", provider, `${provider}: rate limited (HTTP 429): ${clip}`, { status, retryable: true });
  if (status === 400 && /context|maximum|tokens|too (long|large)|length/i.test(text)) return new ProviderError("context-length", provider, `${provider}: context length exceeded: ${clip}`, { status, retryable: false });
  if (status === 400 || status === 404 || status === 422) return new ProviderError("bad-request", provider, `${provider}: rejected request (HTTP ${status}): ${clip}`, { status, retryable: false });
  if (status >= 500) return new ProviderError("unavailable", provider, `${provider}: server error (HTTP ${status}): ${clip}`, { status, retryable: true });
  return new ProviderError("bad-response", provider, `${provider}: unexpected HTTP ${status}: ${clip}`, { status, retryable: false });
}

// --- Protocol adapters -----------------------------------------------------

function asText(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function sendOpenAIChat(baseURL: string, apiKey: string | null, model: string, req: ChatRequest, fetch: HttpFn, provider: string): Promise<{ status: number; text: string }> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  const body: Record<string, unknown> = { model, messages: req.messages, stream: false };
  if (req.need?.jsonMode) body.response_format = { type: "json_object" };
  return postJson(fetch, joinUrl(baseURL, "/chat/completions"), headers, body, provider, req.timeoutMs ?? 120_000, req.signal);
}

function parseOpenAIChat(provider: string, raw: string): { text: string; model?: string; usage?: { input: number; output: number } } {
  let json: { choices?: Array<{ message?: { content?: unknown } }>; model?: string; usage?: { prompt_tokens?: number; completion_tokens?: number }; error?: { message?: string } };
  try {
    json = JSON.parse(raw) as typeof json;
  } catch {
    throw new ProviderError("bad-response", provider, `${provider}: returned non-JSON response`, { retryable: false });
  }
  if (json.error) throw new ProviderError("bad-response", provider, `${provider}: error payload: ${redactSecrets(json.error.message ?? "unknown").slice(0, 200)}`, { retryable: false });
  const text = asText(json.choices?.[0]?.message?.content);
  if (!text.trim()) throw new ProviderError("bad-response", provider, `${provider}: returned empty completion`, { retryable: false });
  return {
    text,
    model: json.model,
    usage: json.usage ? { input: json.usage.prompt_tokens ?? 0, output: json.usage.completion_tokens ?? 0 } : undefined,
  };
}

function sendAnthropic(baseURL: string, apiKey: string, model: string, req: ChatRequest, fetch: HttpFn, provider: string): Promise<{ status: number; text: string }> {
  const system = req.messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
  const messages = req.messages.filter((m) => m.role !== "system").map((m) => ({ role: m.role, content: m.content }));
  const body: Record<string, unknown> = { model, max_tokens: 1024, messages };
  if (system) body.system = system;
  return postJson(fetch, joinUrl(baseURL, "/v1/messages"), {
    "content-type": "application/json",
    "x-api-key": apiKey,
    "anthropic-version": "2023-06-01",
  }, body, provider, req.timeoutMs ?? 120_000, req.signal);
}

function parseAnthropic(provider: string, raw: string): { text: string; model?: string; usage?: { input: number; output: number } } {
  let json: { content?: Array<{ type?: string; text?: string }>; model?: string; usage?: { input_tokens?: number; output_tokens?: number }; error?: { message?: string } };
  try {
    json = JSON.parse(raw) as typeof json;
  } catch {
    throw new ProviderError("bad-response", provider, `${provider}: returned non-JSON response`, { retryable: false });
  }
  if (json.error) throw new ProviderError("bad-response", provider, `${provider}: error payload: ${redactSecrets(json.error.message ?? "unknown").slice(0, 200)}`, { retryable: false });
  const text = (json.content ?? []).filter((b) => b.type === "text").map((b) => b.text ?? "").join("");
  if (!text.trim()) throw new ProviderError("bad-response", provider, `${provider}: returned empty completion`, { retryable: false });
  return { text, model: json.model, usage: json.usage ? { input: json.usage.input_tokens ?? 0, output: json.usage.output_tokens ?? 0 } : undefined };
}

function toGeminiRole(role: ChatMessage["role"]): string {
  return role === "assistant" ? "model" : "user";
}

function sendGemini(baseURL: string, apiKey: string, model: string, req: ChatRequest, fetch: HttpFn, provider: string): Promise<{ status: number; text: string }> {
  const contents = req.messages.filter((m) => m.content.trim()).map((m) => ({ role: toGeminiRole(m.role), parts: [{ text: m.content }] }));
  const body: Record<string, unknown> = { contents };
  if (req.need?.jsonMode) body.generationConfig = { responseMimeType: "application/json" };
  return postJson(fetch, `${joinUrl(baseURL, `/v1beta/models/${model}:generateContent`)}?key=${encodeURIComponent(apiKey)}`, { "content-type": "application/json" }, body, provider, req.timeoutMs ?? 120_000, req.signal);
}

function parseGemini(provider: string, raw: string): { text: string; model?: string; usage?: { input: number; output: number } } {
  let json: { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>; usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number }; error?: { message?: string } };
  try {
    json = JSON.parse(raw) as typeof json;
  } catch {
    throw new ProviderError("bad-response", provider, `${provider}: returned non-JSON response`, { retryable: false });
  }
  if (json.error) throw new ProviderError("bad-response", provider, `${provider}: error payload: ${redactSecrets(json.error.message ?? "unknown").slice(0, 200)}`, { retryable: false });
  const text = (json.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? "").join("");
  if (!text.trim()) throw new ProviderError("bad-response", provider, `${provider}: returned empty completion`, { retryable: false });
  return {
    text,
    usage: json.usageMetadata ? { input: json.usageMetadata.promptTokenCount ?? 0, output: json.usageMetadata.candidatesTokenCount ?? 0 } : undefined,
  };
}

function sendOllama(baseURL: string, model: string, req: ChatRequest, fetch: HttpFn, provider: string): Promise<{ status: number; text: string }> {
  const body: Record<string, unknown> = { model, messages: req.messages, stream: false };
  if (req.need?.jsonMode) body.format = "json";
  return postJson(fetch, joinUrl(baseURL, "/api/chat"), { "content-type": "application/json" }, body, provider, req.timeoutMs ?? 120_000, req.signal);
}

function parseOllama(provider: string, raw: string): { text: string; model?: string } {
  let json: { message?: { content?: unknown }; response?: unknown; model?: string; error?: string };
  try {
    json = JSON.parse(raw) as typeof json;
  } catch {
    throw new ProviderError("bad-response", provider, `${provider}: returned non-JSON response`, { retryable: false });
  }
  if (json.error) throw new ProviderError("bad-response", provider, `${provider}: error payload: ${redactSecrets(json.error).slice(0, 200)}`, { retryable: false });
  const text = asText(json.message?.content ?? json.response);
  if (!text.trim()) throw new ProviderError("bad-response", provider, `${provider}: returned empty completion`, { retryable: false });
  return { text, model: json.model };
}

/** Capability gate: fail fast with a compatible-model hint, never pretend. */
export function requireCapabilities(p: ResolvedProvider, need: ChatRequest["need"]): void {
  const missing: string[] = [];
  if (need?.jsonMode && !p.capabilities.jsonMode) missing.push("jsonMode");
  if (need?.stream && !p.capabilities.stream) missing.push("stream");
  if (need?.tools && !p.capabilities.tools) missing.push("tools");
  if (missing.length > 0) {
    const alt = PROVIDER_SPECS.filter((s) => missing.every((m) => (s.capabilities as Capabilities)[m as keyof Capabilities])).map((s) => s.id);
    throw new ProviderError("bad-request", p.spec.id,
      `${p.spec.id} (model ${p.model || "—"}) does not support: ${missing.join(", ")}. Compatible providers: ${alt.join(", ") || "none configured"}. No fallback was attempted.`,
      { retryable: false });
  }
}

/** Single attempt against one resolved provider. Throws classified ProviderError. */
export async function sendOnce(p: ResolvedProvider, req: ChatRequest, opts: SendOpts = {}): Promise<ChatResponse> {
  if (req.messages.length === 0) throw new ProviderError("bad-request", p.spec.id, "complete requires at least one message", { retryable: false });
  requireCapabilities(p, req.need);
  const v = validateProvider(p);
  if (!v.ok) throw new ProviderError("bad-request", p.spec.id, `${p.spec.id} misconfigured — missing: ${v.missing.join(", ")}`, { retryable: false });
  const handledBy = { provider: p.spec.id, model: p.model };
  if (p.spec.protocol === "editor") {
    if (!opts.vscodeLm) throw new ProviderError("unavailable", p.spec.id, "vscode-lm requires the VS Code host (no HTTP fallback)", { retryable: false });
    try {
      const text = await opts.vscodeLm(req.messages, p.model || null);
      if (!text.trim()) throw new ProviderError("bad-response", p.spec.id, "vscode-lm returned empty completion", { retryable: false });
      return { text, handledBy };
    } catch (err) {
      if (err instanceof ProviderError) throw err;
      throw new ProviderError("unavailable", p.spec.id, `vscode-lm host error: ${redactSecrets((err as Error).message ?? String(err)).slice(0, 200)}`, { retryable: false });
    }
  }
  const fetch = opts.fetch ?? defaultFetch;
  const base = p.baseURL as string;
  let raw: { status: number; text: string };
  let parsed: { text: string; model?: string; usage?: { input: number; output: number } };
  switch (p.spec.protocol) {
    case "openai-chat":
      raw = await sendOpenAIChat(base, p.hasKey ? p.apiKey : null, p.model, req, fetch, p.spec.id);
      if (raw.status < 200 || raw.status >= 300) throw classifyStatus(p.spec.id, raw.status, raw.text);
      parsed = parseOpenAIChat(p.spec.id, raw.text);
      break;
    case "anthropic-messages":
      raw = await sendAnthropic(base, p.apiKey, p.model, req, fetch, p.spec.id);
      if (raw.status < 200 || raw.status >= 300) throw classifyStatus(p.spec.id, raw.status, raw.text);
      parsed = parseAnthropic(p.spec.id, raw.text);
      break;
    case "gemini-generate":
      raw = await sendGemini(base, p.apiKey, p.model, req, fetch, p.spec.id);
      if (raw.status < 200 || raw.status >= 300) throw classifyStatus(p.spec.id, raw.status, raw.text);
      parsed = parseGemini(p.spec.id, raw.text);
      break;
    case "ollama-chat":
      raw = await sendOllama(base, p.model, req, fetch, p.spec.id);
      if (raw.status < 200 || raw.status >= 300) throw classifyStatus(p.spec.id, raw.status, raw.text);
      parsed = parseOllama(p.spec.id, raw.text);
      break;
    default:
      throw new ProviderError("bad-request", p.spec.id, `Unknown protocol for ${p.spec.id}`, { retryable: false });
  }
  return { ...parsed, handledBy };
}

async function defaultFetch(url: string, init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal }): Promise<{ ok: boolean; status: number; text: string }> {
  const res = await fetch(url, {
    method: init.method,
    headers: init.headers,
    body: init.body,
    signal: init.signal,
  });
  return { ok: res.ok, status: res.status, text: await res.text() };
}

// --- Resilience ------------------------------------------------------------

export interface Policy {
  /** Retries per provider (bounded; default 1). Only retryable kinds. */
  retries?: number;
  /** Base backoff ms between retries (doubles each attempt; default 500). */
  backoffMs?: number;
  /** Ordered fallback provider ids. Capability + privacy gated. */
  fallback?: string[];
  /** Allow local→cloud fallback. Default false: never exfiltrate silently. */
  allowCloudFallback?: boolean;
}

export interface PolicyIo extends SendOpts {
  resolve?: (id: string) => ResolvedProvider | null;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Send with bounded retries (retryable kinds only, exponential backoff)
 * and optional capability- + privacy-gated fallback. Fallback never sends
 * repository content to a provider the policy forbids: local primaries
 * stay local unless allowCloudFallback is explicit, and every candidate
 * must satisfy the request's capability requirements.
 */
export async function completeWithPolicy(
  req: ChatRequest,
  primary: ResolvedProvider,
  policy: Policy = {},
  io: PolicyIo = {},
): Promise<ChatResponse> {
  const retries = Math.max(0, Math.min(policy.retries ?? 1, 3));
  const backoffMs = Math.max(0, policy.backoffMs ?? 500);
  const attempts: Array<{ p: ResolvedProvider; fromFallback: boolean }> = [{ p: primary, fromFallback: false }];
  for (const id of policy.fallback ?? []) {
    const fb = io.resolve?.(id) ?? null;
    if (!fb) continue;
    if (fb.dataClass === "cloud" && primary.dataClass === "local" && !policy.allowCloudFallback) continue;
    // Capability gate applies to fallback too — an incompatible fallback is
    // skipped with the chain intact, never attempted blindly.
    try {
      requireCapabilities(fb, req.need);
    } catch {
      continue;
    }
    if (fb.spec.id !== primary.spec.id || fb.model !== primary.model) attempts.push({ p: fb, fromFallback: true });
  }
  const errors: string[] = [];
  for (const { p, fromFallback } of attempts) {
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const res = await sendOnce(p, req, io);
        return { ...res, handledBy: { ...res.handledBy, provider: `${res.handledBy.provider}${fromFallback ? " (fallback)" : ""}` } };
      } catch (err) {
        const pe = err instanceof ProviderError ? err : new ProviderError("unavailable", p.spec.id, String(err), { retryable: false });
        errors.push(`[${p.spec.id}] ${pe.kind}: ${pe.message}`);
        if (!pe.retryable || attempt >= retries) break;
        await sleep(backoffMs * 2 ** attempt);
      }
    }
  }
  throw new ProviderError("unavailable", primary.spec.id,
    `All providers failed (${attempts.length} tried). ${errors.join(" | ").slice(0, 800)}`,
    { retryable: false });
}

// --- Health checks --------------------------------------------------------

export interface HealthResult {
  provider: string;
  ok: boolean;
  /** kind: config (no network) or live (endpoint probed). */
  kind: "config" | "live";
  detail: string;
}

/**
 * Config check is always offline (validation only). Live check probes the
 * cheapest read-only endpoint per protocol (model list / tags). Anthropic
 * exposes no list endpoint, so live check sends a 1-token message — only
 * with explicit opt-in, documented as non-free.
 */
export async function checkProvider(
  p: ResolvedProvider,
  opts: { live?: boolean; fetch?: HttpFn; timeoutMs?: number } = {},
): Promise<HealthResult> {
  const v = validateProvider(p);
  if (!v.ok) return { provider: p.spec.id, ok: false, kind: "config", detail: `Missing: ${v.missing.join(", ")}.` };
  if (!opts.live) return { provider: p.spec.id, ok: true, kind: "config", detail: `Config valid (${describeProvider(p)}). No network call made.` };
  if (p.spec.protocol === "editor") {
    return { provider: p.spec.id, ok: true, kind: "live", detail: "Editor entitlement — availability depends on the VS Code host at call time." };
  }
  const timeoutMs = opts.timeoutMs ?? 15000;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const headers: Record<string, string> = {};
    let url: string;
    let init: { method: string; headers: Record<string, string>; body?: string } = { method: "GET", headers };
    if (p.spec.protocol === "ollama-chat") {
      url = joinUrl(p.baseURL as string, "/api/tags");
    } else if (p.spec.protocol === "gemini-generate") {
      url = `${joinUrl(p.baseURL as string, "/v1beta/models")}?key=${encodeURIComponent(p.apiKey)}`;
    } else if (p.spec.protocol === "anthropic-messages") {
      url = joinUrl(p.baseURL as string, "/v1/messages");
      init = { method: "POST", headers: { "content-type": "application/json", "x-api-key": p.apiKey, "anthropic-version": "2023-06-01" }, body: JSON.stringify({ model: p.model, max_tokens: 1, messages: [{ role: "user", content: "hi" }] }) };
    } else {
      url = joinUrl(p.baseURL as string, "/models");
      if (p.hasKey) headers.authorization = `Bearer ${p.apiKey}`;
    }
    const fetch = opts.fetch ?? defaultFetch;
    const reqInit: { method: string; headers: Record<string, string>; body?: string } = { ...init };
    if (reqInit.body === undefined || reqInit.body === "") delete reqInit.body;
    const res = await fetch(url, { ...reqInit, signal: ctrl.signal });
    if (res.ok) return { provider: p.spec.id, ok: true, kind: "live", detail: `Endpoint reachable (HTTP ${res.status}).` };
    if (res.status === 401 || res.status === 403) return { provider: p.spec.id, ok: false, kind: "live", detail: `Reachable but credentials rejected (HTTP ${res.status}) — check the API key.` };
    if (res.status === 404 && p.spec.protocol === "anthropic-messages") return { provider: p.spec.id, ok: false, kind: "live", detail: `Unexpected 404 from Anthropic — check the base URL.` };
    return { provider: p.spec.id, ok: false, kind: "live", detail: `Endpoint answered HTTP ${res.status}: ${redactSecrets(res.text).slice(0, 160)}` };
  } catch (err) {
    const msg = (err as Error).message ?? String(err);
    if (/abort/i.test(msg)) return { provider: p.spec.id, ok: false, kind: "live", detail: `No response within ${timeoutMs}ms — daemon down or network blocked?` };
    return { provider: p.spec.id, ok: false, kind: "live", detail: `Unreachable: ${redactSecrets(msg).slice(0, 160)}` };
  } finally {
    clearTimeout(timer);
  }
}

// --- Operation routing -----------------------------------------------------

export type DeciOperation = "explain" | "impact" | "test-plan" | "test-gen" | "diagnose" | "fix";

export const OPERATIONS: DeciOperation[] = ["explain", "impact", "test-plan", "test-gen", "diagnose", "fix"];

/**
 * Deterministic per-operation routing. `routes` maps operation → provider
 * id (optionally `provider:model`). Unmapped operations use the default.
 * Unknown ids fall back to the default provider rather than failing.
 */
export function routeFor(
  op: DeciOperation,
  defaultProviderId: string,
  routes: Partial<Record<DeciOperation, string>> = {},
): { providerId: string; model: string | null } {
  const raw = (routes[op] ?? "").trim();
  if (!raw) return { providerId: defaultProviderId, model: null };
  const [id, ...rest] = raw.split(":");
  const spec = id ? specFor(id) : null;
  if (!spec) return { providerId: defaultProviderId, model: null };
  return { providerId: spec.id, model: rest.join(":") || null };
}

/** Read `DECI_ROUTE_<OP>` overrides from env (e.g. DECI_ROUTE_FIX=openai:gpt-4o). */
export function routesFromEnv(env: Record<string, string | undefined> = {}): Partial<Record<DeciOperation, string>> {
  const out: Partial<Record<DeciOperation, string>> = {};
  for (const op of OPERATIONS) {
    const v = (env[`DECI_ROUTE_${op.toUpperCase().replace(/-/g, "_")}`] ?? "").trim();
    if (v) out[op] = v;
  }
  return out;
}
