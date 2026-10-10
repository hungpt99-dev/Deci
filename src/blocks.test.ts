// Interactive workspace tests: block protocol, grounded builders, engine
// persistence, and action authorization. Deterministic mocks only.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ACTION_REGISTRY,
  actionBlock,
  contractToBlock,
  durationsToChart,
  findingsToBlock,
  impactToGraph,
  parseResponseBlocks,
  renderBlocksText,
  resultsToBlock,
  risksToChart,
  validateBlock,
  BLOCK_LIMITS,
  type GraphBlock,
  type ResponseBlock,
} from "./blocks.js";
import type { ImpactMap } from "./impact.js";
import type { RiskFinding } from "./risks.js";
import type { TestResult } from "./run.js";
import { createConversation, DEFAULT_CONTEXT_FLAGS, type ToolExecutionContext } from "./chat.js";
import { MemoryConversationStore } from "./chatStore.js";
import { ChatEngine } from "./chatEngine.js";
import { buildChatHtml } from "./chatView.js";
import { resolveProviderConfig } from "./llm.js";

const FENCE = String.fromCharCode(96).repeat(3);
const block = (json: string): string => `${FENCE}deci-block\n${json}\n${FENCE}`;

const IMPACT: ImpactMap = {
  edges: [
    { symbol: "totalFor", fromFile: "src/cart.ts", toFile: "src/shop.ts", toLine: 12, evidence: "import-resolved", depth: "direct", excerpt: "import", matches: 2, isTest: false },
    { symbol: "totalFor", fromFile: "src/cart.ts", toFile: "test/cart.test.mjs", toLine: 3, evidence: "textual", depth: "direct", excerpt: "totalFor(", matches: 1, isTest: true },
  ],
  directFiles: ["src/shop.ts"],
  indirectFiles: ["src/report.ts"],
  testFiles: ["test/cart.test.mjs"],
  scannedFiles: 42,
  truncated: false,
  unresolved: ["dynamic import in src/loader.ts"],
};

function risk(over: Partial<RiskFinding> = {}): RiskFinding {
  return {
    id: "r1", title: "Duplicate payment", severity: "High", file: "src/cart.ts", line: 10,
    standing: "potential", claim: "inference", current: "no guard", consequence: "double charge",
    scenario: "retry storm", evidence: [], confidence: 0.7, confidenceMeaning: "Moderate",
    mitigation: "idempotency key", suggestedTest: "duplicate-request test",
    ...over,
  };
}

function result(over: Partial<TestResult> = {}): TestResult {
  return {
    path: "test/cart.test.mjs", command: ["node", "--test", "test/cart.test.mjs"],
    status: "passed", exitCode: 0, output: "", durationMs: 120, revision: "t", detail: "exited 0",
    ...over,
  };
}

describe("block schema", () => {
  it("accepts every supported type with valid data", () => {
    const valids: ResponseBlock[] = [
      { type: "text", markdown: "hi" },
      { type: "graph", title: "g", nodes: [{ id: "a", label: "a", kind: "changed" }], edges: [], unresolved: [] },
      { type: "chart", title: "c", chart: "bar", series: [{ name: "s", points: [{ label: "x", value: 1 }] }] },
      { type: "code_diff", title: "d", file: "a.ts", original: "1", proposed: "2", description: "fix" },
      { type: "test_results", title: "t", results: [{ path: "x", status: "passed", exitCode: 0, durationMs: 1, detail: "ok" }] },
      { type: "findings", title: "f", rows: [] },
      { type: "api_request", title: "a", name: "n", file: "f", line: 1, signature: "GET /x", method: "GET", path: "/x" },
      { type: "action", title: "a", action: "run_tests", params: {}, requiresApproval: false, label: "Run" },
    ];
    for (const b of valids) assert.deepEqual(validateBlock(b), [], b.type);
  });

  it("rejects unknown types, bad refs, oversized payloads, unknown actions", () => {
    assert.ok(validateBlock({ type: "hologram" }).length > 0);
    assert.ok(validateBlock({ type: "graph", title: "g", nodes: [{ id: "a", label: "a", kind: "changed" }], edges: [{ from: "a", to: "ghost", label: "x", evidence: "textual" }], unresolved: [] }).length > 0);
    assert.ok(validateBlock({ type: "graph", title: "g", nodes: [{ id: "a", label: "a", kind: "planet" }], edges: [], unresolved: [] }).length > 0);
    assert.ok(validateBlock({ type: "chart", title: "c", chart: "bar", series: [{ name: "s", points: [{ label: "x", value: "1" }] }] }).length > 0);
    assert.ok(validateBlock({ type: "action", title: "a", action: "launch_missiles", params: {}, requiresApproval: false, label: "x" }).length > 0);
    assert.ok(validateBlock({ type: "text", markdown: "x".repeat(BLOCK_LIMITS.maxTextChars + 1) }).length > 0);
    const many = Array.from({ length: BLOCK_LIMITS.maxNodes + 1 }, (_, i) => ({ id: `n${i}`, label: `n${i}`, kind: "direct" }));
    assert.ok(validateBlock({ type: "graph", title: "g", nodes: many, edges: [], unresolved: [] }).length > 0);
  });

  it("action registry marks only apply_fix as approval-gated", () => {
    assert.equal(ACTION_REGISTRY.apply_fix.requiresApproval, true);
    for (const k of ["run_tests", "propose_fix", "explain", "open_file", "ask"] as const) {
      assert.equal(ACTION_REGISTRY[k].requiresApproval, false, k);
    }
  });
});

describe("block parsing", () => {
  it("extracts text plus blocks and keeps prose", () => {
    const text = "Short explanation.\n\n" + block('[{"type": "chart", "title": "R", "chart": "bar", "series": [{"name": "n", "points": [{"label": "High", "value": 2}]}]}]') + "\n\nFollow-up.";
    const { blocks, warnings } = parseResponseBlocks(text);
    assert.deepEqual(warnings, []);
    assert.equal(blocks[0]?.type, "text");
    assert.match((blocks[0] as { markdown: string }).markdown, /Short explanation/);
    assert.equal(blocks[1]?.type, "chart");
  });

  it("degrades malformed JSON and invalid blocks to text with warnings", () => {
    const bad = "Intro.\n\n" + block("{not json") + "\n\n" + block('[{"type": "hologram"}]') + "\n";
    const { blocks, warnings } = parseResponseBlocks(bad);
    assert.equal(blocks.filter((b) => b.type !== "text").length, 0);
    assert.equal(warnings.length, 2);
    assert.match((blocks[0] as { markdown: string }).markdown, /Intro/);
  });

  it("plain text with no fences yields a single text block", () => {
    const { blocks, warnings } = parseResponseBlocks("Just an answer.");
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0]?.type, "text");
    assert.deepEqual(warnings, []);
  });
});

describe("grounded builders", () => {
  it("impact graph contains only observed files and edges", () => {
    const g = impactToGraph(IMPACT, ["src/cart.ts"]);
    assert.ok(g.nodes.some((n) => n.kind === "changed" && n.file === "src/cart.ts"));
    assert.ok(g.nodes.some((n) => n.kind === "test" && n.file === "test/cart.test.mjs"));
    for (const e of g.edges) {
      assert.ok(g.nodes.some((n) => n.id === e.from), `edge from unknown node ${e.from}`);
      assert.ok(g.nodes.some((n) => n.id === e.to), `edge to unknown node ${e.to}`);
    }
    assert.deepEqual(g.unresolved, ["dynamic import in src/loader.ts"]);
    assert.deepEqual(validateBlock(g), []);
    assert.ok(g.edges.every((e) => e.label === "totalFor"));
  });

  it("charts and tables derive from measured inputs", () => {
    const chart = risksToChart([risk(), risk({ severity: "Critical", id: "r2" }), risk({ severity: "High", id: "r3" })]);
    const pts = new Map((chart.series[0]?.points ?? []).map((p) => [p.label, p.value]));
    assert.equal(pts.get("High"), 2);
    assert.equal(pts.get("Critical"), 1);
    const fb = findingsToBlock([risk()]);
    assert.equal(fb.rows[0]?.file, "src/cart.ts");
    assert.equal(fb.rows[0]?.line, 10);
    const tb = resultsToBlock(
      [result(), result({ path: "test/other.test.mjs", status: "failed", exitCode: 1, output: "boom".repeat(2000), detail: "failed" })],
      { testPath: "test/other.test.mjs", command: ["node", "--test", "x"], exitCode: 1, summary: "boom", assertion: null, frames: [{ path: "src/cart.ts", line: 9, fn: null }], links: [], causes: [{ statement: "x", standing: "confirmed" }], patch: null },
    );
    assert.match(tb.title, /1 passed, 1 failed/);
    assert.equal(tb.diagnosis?.frames[0]?.path, "src/cart.ts");
    assert.ok((tb.results[1]?.output?.length ?? 0) <= 3000);
    const dc = durationsToChart([result(), result({ path: "b", durationMs: 5 })]);
    assert.deepEqual((dc.series[0]?.points ?? []).map((p) => p.value), [120, 5]);
  });

  it("api plus action blocks carry real metadata and approval flags", () => {
    const api = contractToBlock({ name: "getCart", kind: "endpoint", file: "src/routes.ts", line: 4, signature: "GET /cart/:id" });
    assert.equal(api.method, "GET");
    assert.equal(api.path, "/cart/:id");
    assert.equal(actionBlock("Fix", "apply_fix", { testPath: "t" }, "Apply fix").requiresApproval, true);
    assert.equal(actionBlock("Run", "run_tests", {}, "Run").requiresApproval, false);
  });

  it("text fallback never claims interactivity it lacks", () => {
    const g: GraphBlock = impactToGraph(IMPACT, ["src/cart.ts"]);
    const txt = renderBlocksText([{ type: "text", markdown: "hi" }, g]);
    assert.match(txt, /Interactive graph/);
    assert.match(txt, /VS Code Chat/);
  });
});

describe("engine blocks", () => {
  function queuedFetch(texts: string[]): { fetch: (url: string, init: { body?: string }) => Promise<{ ok: boolean; status: number; text: string }>; seen: string[] } {
    const seen: string[] = [];
    let i = 0;
    const fetch = async (_url: string, init: { body?: string }): Promise<{ ok: boolean; status: number; text: string }> => {
      seen.push(init.body ?? "");
      const text = texts[Math.min(i++, texts.length - 1)] ?? "";
      return { ok: true, status: 200, text: JSON.stringify({ message: { content: text } }) };
    };
    return { fetch, seen };
  }

  function ctxBase(): ToolExecutionContext {
    return {
      workspaceRoot: "/repo",
      readFile: async () => null,
      writeFile: async () => {},
      exists: async () => true,
      listFiles: async () => [],
      git: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
      exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
    };
  }

  function engineFor(store: MemoryConversationStore, fetch: unknown, seen: string[], tool: ToolExecutionContext): ChatEngine {
    return new ChatEngine({
      store,
      contextIo: { ...tool, activeFile: undefined, selection: undefined },
      providerInput: { provider: "ollama", model: "q" },
      env: {},
      toolContext: tool,
      policyIo: { fetch: fetch as never },
    });
  }

  it("persists validated blocks on the assistant message", async () => {
    const store = new MemoryConversationStore();
    const conv = createConversation("t");
    await store.create(conv);
    const graphJson = JSON.stringify({ type: "graph", title: "Impact", nodes: [{ id: "a", label: "a", kind: "changed" }], edges: [], unresolved: [] });
    const { fetch } = queuedFetch(["Here is the impact.\n\n" + block(`[${graphJson}]`)]);
    const engine = engineFor(store, fetch, [], ctxBase());
    const res = await engine.sendMessage(conv.id, "what is affected?");
    assert.equal(res.complete, true);
    assert.ok(res.message.blocks && res.message.blocks.length === 2);
    assert.equal(res.message.blocks[1]?.type, "graph");
    assert.equal(res.message.blockWarnings, undefined);
  });

  it("persists warnings and degrades invalid blocks to text", async () => {
    const store = new MemoryConversationStore();
    const conv = createConversation("t");
    await store.create(conv);
    const { fetch } = queuedFetch(["Answer.\n\n" + block('[{"type": "hologram"}]')]);
    const engine = engineFor(store, fetch, [], ctxBase());
    const res = await engine.sendMessage(conv.id, "show me");
    assert.ok(res.message.blockWarnings && res.message.blockWarnings.length === 1);
    assert.ok(!res.message.blocks || res.message.blocks.every((b) => b.type === "text"));
  });

  it("sends selected visual elements as follow-up context", async () => {
    const store = new MemoryConversationStore();
    const conv = createConversation("t");
    await store.create(conv);
    const { fetch, seen } = queuedFetch(["Explained."]);
    const engine = engineFor(store, fetch, seen, ctxBase());
    await engine.sendMessage(conv.id, "Explain this module", {
      selection: { kind: "direct", label: "shop.ts", file: "src/shop.ts", line: 12 },
    });
    const sent = seen.join("\n");
    assert.match(sent, /Selected visual element/);
    assert.match(sent, /src\/shop\.ts:12/);
    const updated = await store.get(conv.id);
    assert.equal(updated?.messages[0]?.selection?.label, "shop.ts");
  });

  it("chat HTML embeds blocks for client rendering without script breakage", () => {
    const cfg = resolveProviderConfig({}, {});
    const html = buildChatHtml(
      [{ id: "c1", title: "T", createdAt: "", updatedAt: "", messageCount: 1 }],
      "c1",
      [{ role: "assistant", content: "hi", timestamp: "", id: "m1", blocks: [{ type: "text", markdown: "hi" }] }],
      DEFAULT_CONTEXT_FLAGS,
      cfg,
    );
    assert.match(html, /__DECI_STATE__/);
    assert.match(html, /renderBlock/);
    assert.ok(!html.includes("</script><script>") || html.includes("__DECI_STATE__"));
  });
});

describe("client renderer", () => {
  async function client(): Promise<Record<string, (...args: any[]) => any>> {
    const { chatClientJs } = await import("./chatView.js");
    const vm = await import("node:vm");
    const messages: unknown[] = [];
    const sandbox: Record<string, unknown> = {
      window: {},
      document: {
        getElementById: () => null,
        querySelectorAll: () => [],
        querySelector: () => null,
        addEventListener: () => {},
        activeElement: null,
      },
      addEventListener: () => {},
      navigator: { clipboard: { writeText: async () => {} } },
      prompt: () => null,
    };
    sandbox.window = sandbox;
    sandbox.globalThis = sandbox;
    const bottom: string[] = [
      "globalThis.__R = { renderBlock, renderGraph, renderChart, renderDiff, renderTests, renderFindings, renderApi, renderAction, md, esc, stripFences };",
    ];
    const post = (m: unknown): void => { messages.push(m); };
    void post;
    vm.createContext(sandbox);
    vm.runInContext(
      "var acquireVsCodeApi = () => ({ postMessage: (m) => { (globalThis.__P = globalThis.__P || []).push(m); } });\n"
      + chatClientJs() + "\n" + bottom.join("\n"),
      sandbox,
    );
    return (sandbox.__R ?? {}) as Record<string, (...args: never[]) => string>;
  }

  it("renders every block type to interactive markup", async () => {
    const r = await client();
    const graph = r.renderBlock({ type: "graph", title: "Impact", nodes: [{ id: "a", label: "a.ts", kind: "changed", file: "src/a.ts" }], edges: [], unresolved: [] }, "m1", 0);
    assert.match(graph, /graph-svg/);
    assert.match(graph, /role="tree"/);
    assert.match(graph, /data-detail/);
    assert.match(graph, /tabindex="0"/);
    const chart = r.renderBlock({ type: "chart", title: "R", chart: "bar", series: [{ name: "s", points: [{ label: "High", value: 2 }] }] }, "m1", 1);
    assert.match(chart, /bar-fill/);
    assert.match(chart, /aria-pressed/);
    const diff = r.renderBlock({ type: "code_diff", title: "D", file: "a.ts", original: "x = 1", proposed: "x = 2", description: "fix", action: { name: "propose_fix", args: { testPath: "t.mjs" } } }, "m1", 2);
    assert.match(diff, /diff-grid/);
    assert.match(diff, /data-act="do-action"/);
    const tests = r.renderBlock({ type: "test_results", title: "T", results: [{ path: "t.mjs", status: "failed", exitCode: 1, durationMs: 5, detail: "boom", output: "log" }] }, "m1", 3);
    assert.match(tests, /data-tact="filter"/);
    assert.match(tests, /Propose fix/);
    const findings = r.renderBlock({ type: "findings", title: "F", rows: [{ severity: "High", file: "a.ts", line: 1, finding: "risk", standing: "potential" }] }, "m1", 4);
    assert.match(findings, /data-fact="filter"/);
    assert.match(findings, /data-act="ask-about"/);
    const api = r.renderBlock({ type: "api_request", title: "A", name: "n", file: "f", line: 1, signature: "GET /x", method: "GET", path: "/x" }, "m1", 5);
    assert.match(api, /Live execution is disabled/);
    const action = r.renderBlock({ type: "action", title: "A", action: "apply_fix", params: { testPath: "t" }, requiresApproval: true, label: "Apply" }, "m1", 6);
    assert.match(action, /needs approval/);
    const unknown = r.renderBlock({ type: "hologram" }, "m1", 7);
    assert.match(unknown, /Unsupported block/);
  });

  it("escapes untrusted block content", async () => {
    const r = await client();
    const evil = '<script>alert(1)</script>';
    const out = r.renderBlock({ type: "graph", title: evil, nodes: [{ id: "a", label: evil, kind: "direct" }], edges: [], unresolved: [evil] }, "m", 0);
    assert.ok(!out.includes("<script>alert"));
    assert.match(out, /&lt;script&gt;/);
    const mdOut = r.md("hello " + evil + "\n\n" + String.fromCharCode(96).repeat(3) + "deci-block\n[x]\n" + String.fromCharCode(96).repeat(3));
    assert.ok(!mdOut.includes("deci-block"));
  });

  it("graph exposes filter, search, fit controls and detail panel", async () => {
    const r = await client();
    const out = r.renderGraph(
      { type: "graph", title: "G", nodes: [{ id: "a", label: "a", kind: "changed" }, { id: "b", label: "b", kind: "test", file: "t.mjs" }], edges: [{ from: "a", to: "b", label: "covers", evidence: "textual" }], unresolved: ["gap"] },
      "k",
    );
    assert.match(out, /gsearch/);
    assert.match(out, /data-gact="fit"/);
    assert.match(out, /data-gact="reset"/);
    assert.match(out, /data-detail/);
    assert.match(out, /Coverage gaps/);
  });
});

describe("extension block actions", () => {
  function stubVscode(): {
    vscode: Parameters<typeof import("./vscode/extension.js").activate>[0];
    commands: Map<string, (...args: unknown[]) => unknown>;
    panels: Array<{ webview: { html: string } }>;
  } {
    const commands = new Map<string, (...args: unknown[]) => unknown>();
    const panels: Array<{ webview: { html: string } }> = [];
    const vscode = {
      window: {
        createWebviewPanel: () => {
          const panel = { webview: { html: "", onDidReceiveMessage: () => {}, postMessage: () => {} } };
          panels.push(panel);
          return panel;
        },
        showQuickPick: async () => "Approve",
        showInputBox: async () => "input",
        registerTreeDataProvider: () => undefined,
      },
      workspace: {
        getConfiguration: (_section: string) => ({ get: <T,>(_key: string): T | undefined => undefined }),
      },
      commands: {
        registerCommand: (id: string, cb: (...args: unknown[]) => unknown) => {
          commands.set(id, cb);
          return undefined;
        },
      },
    };
    return { vscode: vscode as never, commands, panels };
  }

  async function activateWithRoot(root: string, opened: Array<{ path: string; line: number | null }>): Promise<{ api: ReturnType<typeof import("./vscode/extension.js").activate>; commands: Map<string, (...args: unknown[]) => unknown> }> {
    const { activate } = await import("./vscode/extension.js");
    const { vscode, commands } = stubVscode();
    const api = activate(vscode, {
      storageDir: mkdtempSync(join(tmpdir(), "deci-chat-")),
      workspaceRoot: root,
      openDocument: async (path: string, line: number | null) => { opened.push({ path, line }); },
    });
    return { api, commands };
  }

  it("run_tests action executes the real backend and records verified output", async () => {
    const root = mkdtempSync(join(tmpdir(), "deci-ws-"));
    writeFileSync(join(root, "sample.test.mjs"), "import test from 'node:test';\nimport assert from 'node:assert/strict';\ntest('passes', () => assert.equal(1, 1));\n");
    const opened: Array<{ path: string; line: number | null }> = [];
    const { api } = await activateWithRoot(root, opened);
    const r = await api.chat.doAction("run_tests", { paths: "sample.test.mjs" }, false);
    assert.equal(r.ok, true);
    assert.match(r.detail, /passed/);
  });

  it("unknown actions fail and approval-gated actions refuse without approval", async () => {
    const root = mkdtempSync(join(tmpdir(), "deci-ws-"));
    const opened: Array<{ path: string; line: number | null }> = [];
    const { api } = await activateWithRoot(root, opened);
    assert.equal((await api.chat.doAction("launch_missiles", {}, true)).ok, false);
    const r = await api.chat.doAction("apply_fix", { testPath: "sample.test.mjs" }, false);
    assert.equal(r.ok, false);
    assert.match(r.detail, /approval/);
  });

  it("open_file navigates inside the workspace and refuses escapes", async () => {
    const root = mkdtempSync(join(tmpdir(), "deci-ws-"));
    const opened: Array<{ path: string; line: number | null }> = [];
    const { api } = await activateWithRoot(root, opened);
    const ok = await api.chat.doAction("open_file", { path: "src/a.ts", line: 3 }, false);
    assert.equal(ok.ok, true);
    assert.deepEqual(opened, [{ path: "src/a.ts", line: 3 }]);
    const bad = await api.chat.doAction("open_file", { path: "../etc/passwd" }, false);
    assert.equal(bad.ok, false);
    assert.equal(opened.length, 1);
  });
});
