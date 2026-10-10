// Chat types and persistence. Pure core with injected storage;
// VS Code/CLI are thin adapters over the same conversation model.

import type { ResponseBlock } from "./blocks.js";

export type ChatRole = "system" | "user" | "assistant" | "tool";

export interface ChatMessageItem {
  role: ChatRole;
  content: string;
  /** Tool call metadata when role === "assistant" and provider emitted tool calls. */
  toolCalls?: ToolCall[];
  /** Tool result when role === "tool". */
  toolResult?: ToolResult;
  /** Validated interactive blocks parsed from an assistant response. */
  blocks?: ResponseBlock[];
  /** Non-fatal warnings from block parsing (shown, never hidden). */
  blockWarnings?: string[];
  /** Visual selection attached as follow-up context (kind + label + source). */
  selection?: BlockSelection;
  /** Provider/model attribution for observability. */
  handledBy?: { provider: string; model: string };
  /** Timestamp for ordering and retention. */
  timestamp: string;
  /** Optional unique id for message-level operations (retry, delete). */
  id: string;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ToolResult {
  callId: string;
  name: string;
  output: string;
  error?: string;
}

export interface ConversationMeta {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  provider?: string;
  model?: string;
}

export interface Conversation {
  id: string;
  title: string;
  messages: ChatMessageItem[];
  createdAt: string;
  updatedAt: string;
  /** Provider/model used for this conversation (overrides global default). */
  provider?: string;
  model?: string;
  /** Context flags — what project context to include on each turn. */
  contextFlags: ContextFlags;
}

export interface ContextFlags {
  /** Include active file + selection. */
  activeFile: boolean;
  /** Include current working-tree diff. */
  diff: boolean;
  /** Include impact analysis results. */
  impact: boolean;
  /** Include test discovery + results. */
  tests: boolean;
  /** Include API contract symbols. */
  apiContracts: boolean;
  /** Include project docs (README, ADRs). */
  docs: boolean;
}

export const DEFAULT_CONTEXT_FLAGS: ContextFlags = {
  activeFile: true,
  diff: true,
  impact: true,
  tests: true,
  apiContracts: true,
  docs: true,
};

export interface ChatContextBundle {
  /** Active file path (relative to workspace root). */
  activeFile?: string;
  /** Selection range in active file. */
  selection?: { startLine: number; endLine: number };
  /** Capped excerpt of the active file (or selection). */
  activeFileExcerpt?: string;
  /** Working-tree diff text. */
  diff?: string;
  /** Impact analysis results (serialized). */
  impact?: ChatImpactSummary;
  /** Test discovery + results. */
  tests?: TestSummary;
  /** API contract symbols. */
  apiContracts?: ApiContractSymbol[];
  /** Project docs excerpts. */
  docs?: DocExcerpt[];
  /** Workspace root for path resolution. */
  workspaceRoot: string;
}

export interface ChatImpactSummary {
  directFiles: string[];
  indirectFiles: string[];
  testFiles: string[];
  scannedFiles: number;
  unresolved: string[];
}

export interface TestSummary {
  discovered: number;
  selected: number;
  passed: number;
  failed: number;
  results: Array<{ path: string; status: string; detail: string }>;
}

export interface ApiContractSymbol {
  name: string;
  kind: "endpoint" | "type" | "interface";
  file: string;
  line: number | null;
  signature: string;
}

export interface DocExcerpt {
  path: string;
  content: string;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: ToolParameters;
  /** If true, execution requires explicit user approval in the UI. */
  requiresApproval?: boolean;
}

export interface ToolParameters {
  type: "object";
  properties: Record<string, ToolParameter>;
  required: string[];
}

export interface ToolParameter {
  type: string;
  description: string;
  enum?: string[];
}

export interface ToolInvocation {
  name: string;
  args: Record<string, unknown>;
  callId: string;
}

/** A visual element the user selected (graph node, finding, test, endpoint)
 *  and sent as follow-up context. Plain data — backend re-validates paths. */
export interface BlockSelection {
  kind: string;
  label: string;
  file?: string;
  line?: number | null;
}

export interface ToolExecutionResult {
  callId: string;
  name: string;
  output: string;
  error?: string;
}

/** Tool execution context — injected by host (VS Code/CLI/tests). Single source; chatTools imports from here. */
export interface ToolExecutionContext {
  workspaceRoot: string;
  readFile(path: string): Promise<string | null>;
  writeFile(path: string, content: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  listFiles(root: string): Promise<string[] | null>;
  git(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }>;
  exec(cmd: string, args: string[], opts?: { cwd?: string; timeoutMs?: number }): Promise<{ stdout: string; stderr: string; exitCode: number }>;
  runTest?(path: string): Promise<{ status: string; output: string; exitCode: number | null }>;
}

/** Chat limits: validated on every send. */
export const CHAT_LIMITS = {
  maxMessageChars: 12000,
  maxTitleChars: 120,
  contextBudgetChars: 60000,
  maxToolIterations: 5,
  toolTimeoutMs: 60000,
} as const;

/** Validate user message text. Returns error string or null when ok. */
export function validateMessage(text: string): string | null {
  if (!text.trim()) return "Message is empty.";
  if (text.length > CHAT_LIMITS.maxMessageChars)
    return `Message too long (${text.length} chars, max ${CHAT_LIMITS.maxMessageChars}).`;
  return null;
}

/** Validate conversation title. */
export function validateTitle(title: string): string | null {
  if (!title.trim()) return "Title is empty.";
  if (title.length > CHAT_LIMITS.maxTitleChars)
    return `Title too long (max ${CHAT_LIMITS.maxTitleChars} chars).`;
  return null;
}

/** Validate tool arguments against its definition. Returns error or null. */
export function validateToolArgs(def: ToolDefinition, args: Record<string, unknown>): string | null {
  for (const req of def.parameters.required) {
    if (!(req in args) || args[req] === undefined || args[req] === null)
      return `Missing required argument: ${req}`;
  }
  for (const [k, v] of Object.entries(args)) {
    const param = def.parameters.properties[k];
    if (!param) return `Unknown argument: ${k}`;
    if (param.type === "string" && typeof v !== "string") return `Argument ${k} must be a string.`;
    if (param.type === "number" && typeof v !== "number") return `Argument ${k} must be a number.`;
    if (param.type === "array" && !Array.isArray(v)) return `Argument ${k} must be an array.`;
  }
  return null;
}

/** Pure storage interface. Implementations: file (VS Code), memory (tests). */
export interface ConversationStore {
  list(): Promise<ConversationMeta[]>;
  get(id: string): Promise<Conversation | null>;
  create(conv: Conversation): Promise<void>;
  update(conv: Conversation): Promise<void>;
  delete(id: string): Promise<void>;
}

/** Generate a compact, sortable conversation ID. */
export function newConversationId(): string {
  const b = new Uint8Array(10);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

/** Generate a message ID. */
export function newMessageId(): string {
  const b = new Uint8Array(8);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

/** Create a new empty conversation. */
export function createConversation(
  title: string,
  contextFlags: ContextFlags = DEFAULT_CONTEXT_FLAGS,
  provider?: string,
  model?: string,
): Conversation {
  const now = new Date().toISOString();
  return {
    id: newConversationId(),
    title,
    messages: [],
    createdAt: now,
    updatedAt: now,
    provider,
    model,
    contextFlags,
  };
}

/** Add a message to a conversation (immutable update). */
export function addMessage(conv: Conversation, message: ChatMessageItem): Conversation {
  return {
    ...conv,
    messages: [...conv.messages, message],
    updatedAt: new Date().toISOString(),
  };
}

/** Update conversation title. */
export function renameConversation(conv: Conversation, title: string): Conversation {
  return { ...conv, title, updatedAt: new Date().toISOString() };
}

/** Update context flags. */
export function updateContextFlags(conv: Conversation, flags: Partial<ContextFlags>): Conversation {
  return {
    ...conv,
    contextFlags: { ...conv.contextFlags, ...flags },
    updatedAt: new Date().toISOString(),
  };
}

/** Update provider/model for a conversation. */
export function updateProviderModel(conv: Conversation, provider?: string, model?: string): Conversation {
  return {
    ...conv,
    provider: provider ?? conv.provider,
    model: model ?? conv.model,
    updatedAt: new Date().toISOString(),
  };
}

/** Trim messages to fit a token budget (approximate: 1 token ≈ 4 chars). */
export function trimMessagesForBudget(
  messages: ChatMessageItem[],
  budgetChars: number,
  alwaysKeepFirst: number = 2,
): ChatMessageItem[] {
  if (messages.length <= alwaysKeepFirst) return messages;
  const head: ChatMessageItem[] = [];
  let total = 0;
  // Always keep first N messages (usually system + first user)
  for (let i = 0; i < alwaysKeepFirst && i < messages.length; i++) {
    head.push(messages[i] as ChatMessageItem);
    total += (messages[i] as ChatMessageItem).content.length;
  }
  // Add from the end (most recent) until budget, preserving order.
  const tail: ChatMessageItem[] = [];
  for (let i = messages.length - 1; i >= alwaysKeepFirst; i--) {
    const m = messages[i] as ChatMessageItem;
    if (total + m.content.length > budgetChars) break;
    tail.unshift(m);
    total += m.content.length;
  }
  return [...head, ...tail];
}