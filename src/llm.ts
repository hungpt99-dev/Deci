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

export type { ChatMessage } from "./providers.js";
// (Single-sourced: index.ts star-exports resolve to one symbol.)

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

/** Flat settings bag (VS Code `deci.*` or CLI flags); all fields optional. */
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
  const providerRaw = pick(settings.provider, env.DECI_PROVIDER, "ollama");
  const provider: ProviderId = isProvider(providerRaw) ? providerRaw : "ollama";
  return {
    provider,
    openai: {
      baseURL: pick(settings.openaiBaseURL, env.DECI_OPENAI_BASE_URL, DEFAULT_OPENAI_BASE_URL),
      apiKey: pick(settings.openaiApiKey, env.DECI_OPENAI_API_KEY, ""),
      model: pick(settings.openaiModel, env.DECI_OPENAI_MODEL, DEFAULT_OPENAI_MODEL),
    },
    ollama: {
      baseURL: pick(settings.ollamaBaseURL, env.DECI_OLLAMA_BASE_URL, DEFAULT_OLLAMA_BASE_URL),
      model: pick(settings.ollamaModel, env.DECI_OLLAMA_MODEL, DEFAULT_OLLAMA_MODEL),
    },
    vscodeLm: {
      model: pick(settings.vscodeLmModel, env.DECI_VSCODE_LM_MODEL, "") || null,
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
// Delegates to the provider-agnostic adapters in providers.ts. This module
// keeps the historical LlmConfig surface (settings, env, describe) so
// existing callers and tests are unaffected; new code should prefer
// providers.ts (registry, capabilities, retry/fallback, routing) directly.

import {
  sendOnce,
  specFor,
  type ChatMessage as ProviderMessage,
  type HttpFn,
  type ResolvedProvider,
} from "./providers.js";

export type FetchFn = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ ok: boolean; status: number; text: string }>;

/** VS Code LM API host hook (editor entitlement). Injected — core has no vscode dep. */
export type VscodeLmFn = (messages: ProviderMessage[], model: string | null) => Promise<string>;

export interface CompleteOptions {
  fetch?: FetchFn;
  vscodeLm?: VscodeLmFn;
}

/**
 * Send exactly `messages` to the configured provider and nothing else.
 * Behavior-preserving delegate to providers.sendOnce: same endpoints,
 * same auth, same validation order. Throws classified ProviderError
 * (an Error subclass — existing `rejects(/.../)` assertions still match).
 */
export async function complete(
  messages: ProviderMessage[],
  config: LlmConfig,
  opts: CompleteOptions = {},
): Promise<string> {
  const spec = specFor(config.provider) ?? specFor("ollama");
  if (!spec) throw new Error(`unknown provider: ${config.provider}`);
  // "openai-byok" resolves to the openai spec via registry alias.
  const resolved: ResolvedProvider = {
    spec,
    baseURL: spec.id === "openai" ? config.openai.baseURL : spec.id === "ollama" ? config.ollama.baseURL : spec.defaultBaseURL,
    apiKey: spec.id === "openai" ? config.openai.apiKey : "",
    hasKey: spec.id === "openai" ? config.openai.apiKey !== "" : false,
    model: spec.id === "openai" ? config.openai.model : spec.id === "ollama" ? config.ollama.model : (config.vscodeLm.model ?? ""),
    capabilities: { ...spec.capabilities },
    dataClass: spec.local ? "local" : "cloud",
  };
  const fetch: HttpFn | undefined = opts.fetch
    ? (url, init) => opts.fetch!(url, { method: init.method, headers: init.headers, body: init.body ?? "" }).then((r) => ({ ok: r.ok, status: r.status, text: r.text }))
    : undefined;
  const res = await sendOnce(resolved, { messages }, { fetch, vscodeLm: opts.vscodeLm });
  return res.text;
}
