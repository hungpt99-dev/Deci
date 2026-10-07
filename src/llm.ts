// US-009: LLM provider switch. Pure config + routing core; no I/O here.
// Local-first boundary: AST/diff processing (reviewMap/semantic/verify) never
// touches this module. Only the explicit `messages` passed to `complete()`
// leave the machine, and only to the configured provider's endpoint.

export type ProviderId = "openai-byok" | "ollama" | "vscode-lm";

export interface OpenAiByokSettings {
  baseURL: string;
  apiKey: string;
  model: string;
}

export interface OllamaSettings {
  baseURL: string;
  model: string;
}

export interface VscodeLmSettings {
  model: string | null;
}

export interface LlmConfig {
  provider: ProviderId;
  openai: OpenAiByokSettings;
  ollama: OllamaSettings;
  vscodeLm: VscodeLmSettings;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export const PROVIDERS: ProviderId[] = ["openai-byok", "ollama", "vscode-lm"];

export const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";
export const DEFAULT_OLLAMA_BASE_URL = "http://localhost:11434";
export const DEFAULT_OLLAMA_MODEL = "llama3.1";
export const DEFAULT_OPENAI_MODEL = "gpt-4o-mini";

function clean(v: string | undefined | null): string {
  return (v ?? "").trim();
}

function isProvider(v: string): v is ProviderId {
  return (PROVIDERS as string[]).includes(v);
}

/** Flat settings bag (VS Code `changepilot.*` or CLI flags); all fields optional. */
export interface ProviderSettingsInput {
  provider?: string;
  openaiBaseURL?: string;
  openaiApiKey?: string;
  openaiModel?: string;
  ollamaBaseURL?: string;
  ollamaModel?: string;
  vscodeLmModel?: string;
}

/** Pure: merge defaults <- settings <- env. Never reads fs/git/network. */
export function resolveProviderConfig(
  settings: ProviderSettingsInput = {},
  env: Record<string, string | undefined> = {},
): LlmConfig {
  const pick = (...vals: Array<string | undefined>): string =>
    clean(vals.find((v) => clean(v) !== undefined && clean(v) !== "") ?? "");
  const providerRaw = pick(settings.provider, env.CHANGEPILOT_PROVIDER, "ollama");
  const provider: ProviderId = isProvider(providerRaw) ? providerRaw : "ollama";
  return {
    provider,
    openai: {
      baseURL: pick(settings.openaiBaseURL, env.CHANGEPILOT_OPENAI_BASE_URL, DEFAULT_OPENAI_BASE_URL),
      apiKey: pick(settings.openaiApiKey, env.CHANGEPILOT_OPENAI_API_KEY, ""),
      model: pick(settings.openaiModel, env.CHANGEPILOT_OPENAI_MODEL, DEFAULT_OPENAI_MODEL),
    },
    ollama: {
      baseURL: pick(settings.ollamaBaseURL, env.CHANGEPILOT_OLLAMA_BASE_URL, DEFAULT_OLLAMA_BASE_URL),
      model: pick(settings.ollamaModel, env.CHANGEPILOT_OLLAMA_MODEL, DEFAULT_OLLAMA_MODEL),
    },
    vscodeLm: {
      model: pick(settings.vscodeLmModel, env.CHANGEPILOT_VSCODE_LM_MODEL, "") || null,
    },
  };
}

/** Pure: what is missing before the configured provider can run. */
export function validateConfig(config: LlmConfig): { ok: boolean; missing: string[] } {
  if (config.provider === "openai-byok") {
    const missing: string[] = [];
    if (!config.openai.baseURL) missing.push("openai.baseURL");
    if (!config.openai.apiKey) missing.push("openai.apiKey");
    if (!config.openai.model) missing.push("openai.model");
    return { ok: missing.length === 0, missing };
  }
  if (config.provider === "ollama") {
    const missing: string[] = [];
    if (!config.ollama.baseURL) missing.push("ollama.baseURL");
    if (!config.ollama.model) missing.push("ollama.model");
    return { ok: missing.length === 0, missing };
  }
  // vscode-lm uses the editor's entitlement — nothing to configure.
  return { ok: true, missing: [] };
}

/** Redacted one-liner for logs/panels. Never includes the API key. */
export function describeConfig(config: LlmConfig): string {
  if (config.provider === "openai-byok") {
    const key = config.openai.apiKey ? "set" : "missing";
    return `Provider: openai-byok (${config.openai.baseURL}, model ${config.openai.model}, key ${key})`;
  }
  if (config.provider === "ollama") {
    return `Provider: ollama (${config.ollama.baseURL}, model ${config.ollama.model}) — local`;
  }
  return `Provider: vscode-lm (${config.vscodeLm.model ?? "editor default"}) — editor entitlement`;
}

export function renderProviderMarkdown(config: LlmConfig): string {
  const v = validateConfig(config);
  const status = v.ok ? "ready" : `missing: ${v.missing.join(", ")}`;
  return [`## LLM Provider`, ``, `${describeConfig(config)} — ${status}.`, ``].join("\n");
}

// --- Completion boundary -------------------------------------------------

export type FetchFn = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ ok: boolean; status: number; text: string }>;

/** VS Code LM API host hook (editor entitlement). Injected — core has no vscode dep. */
export type VscodeLmFn = (messages: ChatMessage[], model: string | null) => Promise<string>;

export interface CompleteOptions {
  fetch?: FetchFn;
  vscodeLm?: VscodeLmFn;
}

function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, "")}${path}`;
}

function extractContent(provider: ProviderId, raw: string): string {
  let json: {
    choices?: Array<{ message?: { content?: string } }>;
    message?: { content?: string };
    response?: string;
  };
  try {
    json = JSON.parse(raw) as typeof json;
  } catch {
    throw new Error(`${provider} returned non-JSON response`);
  }
  const text =
    json.choices?.[0]?.message?.content ?? json.message?.content ?? json.response ?? "";
  if (!text.trim()) throw new Error(`${provider} returned empty completion`);
  return text;
}

/**
 * Send exactly `messages` to the configured provider and nothing else.
 * Callers build the prompt (e.g. a summary request) — diff/AST stay local
 * unless the caller puts them in the prompt. BYOK posts OpenAI-compatible
 * `/chat/completions`; Ollama posts `/api/chat` (local host by default);
 * vscode-lm delegates to the editor and never touches HTTP.
 */
export async function complete(
  messages: ChatMessage[],
  config: LlmConfig,
  opts: CompleteOptions = {},
): Promise<string> {
  if (messages.length === 0) throw new Error("complete requires at least one message");
  if (config.provider === "vscode-lm") {
    if (!opts.vscodeLm) throw new Error("vscode-lm requires the VS Code host (no HTTP fallback)");
    return opts.vscodeLm(messages, config.vscodeLm.model);
  }
  const fetch = opts.fetch ?? defaultFetch;
  if (config.provider === "openai-byok") {
    const v = validateConfig(config);
    if (!v.ok) throw new Error(`openai-byok misconfigured — missing: ${v.missing.join(", ")}`);
    const res = await fetch(joinUrl(config.openai.baseURL, "/chat/completions"), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.openai.apiKey}`,
      },
      body: JSON.stringify({ model: config.openai.model, messages }),
    });
    if (!res.ok) throw new Error(`openai-byok HTTP ${res.status}: ${res.text.slice(0, 300)}`);
    return extractContent("openai-byok", res.text);
  }
  // ollama — local by default; only the LLM call needs the daemon.
  const v = validateConfig(config);
  if (!v.ok) throw new Error(`ollama misconfigured — missing: ${v.missing.join(", ")}`);
  const res = await fetch(joinUrl(config.ollama.baseURL, "/api/chat"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: config.ollama.model, messages, stream: false }),
  });
  if (!res.ok) throw new Error(`ollama HTTP ${res.status}: ${res.text.slice(0, 300)}`);
  return extractContent("ollama", res.text);
}

async function defaultFetch(
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
): Promise<{ ok: boolean; status: number; text: string }> {
  const res = await fetch(url, {
    method: init.method,
    headers: init.headers,
    body: init.body,
  });
  return { ok: res.ok, status: res.status, text: await res.text() };
}
