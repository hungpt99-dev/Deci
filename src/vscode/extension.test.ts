// VS Code adapter tests: exercise every editor-agnostic entry point with a
// stub host. host.ts (real `vscode` module) cannot load headless — that seam
// is BLOCKED on the VS Code runtime and covered by typecheck + packaging.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  activate,
  applyDecisionDecorations,
  applyPickedAlternative,
  createListProvider,
  decisionsForDiff,
  manualDiffForFiles,
  noteReview,
  pickStudioAlternative,
  previewImplementation,
  promptReviewInputs,
  providerForHost,
  registerDecisionCommands,
  showAlternatives,
  showDecisions,
  showEvidence,
  showHistory,
  showImpactReport,
  showInputsPanel,
  showOutputBundle,
  showProviderStatus,
  showReviewMap,
  viewIds,
} from "./extension.js";
import type { DecisionPoint } from "../decisions.js";
import { rejectDecision } from "../decisions.js";

type Vscode = Parameters<typeof showReviewMap>[0];
interface Panel {
  viewType: string;
  title: string;
  webview: {
    html: string;
    messages: unknown[];
    postMessage(m: unknown): void;
    onDidReceiveMessage(cb: (msg: Record<string, unknown>) => void): void;
    handler: ((msg: Record<string, unknown>) => void) | null;
  };
}
interface Stub {
  vscode: Vscode;
  panels: Panel[];
  commands: Map<string, (...args: unknown[]) => unknown>;
}

const DIFF = `diff --git a/src/auth/login.ts b/src/auth/login.ts
--- a/src/auth/login.ts
+++ b/src/auth/login.ts
@@ -10,2 +20,2 @@
-const old = 1;
+jwt.verify(token);
`;

function stubVscode(over: { pickPrefix?: string; inputBox?: string; editor?: unknown } = {}): Stub {
  const panels: Panel[] = [];
  const commands = new Map<string, (...args: unknown[]) => unknown>();
  const vscode = {
    window: {
      createWebviewPanel: (viewType: string, title: string, _column: number, _opts: unknown): Panel => {
        const panel: Panel = {
          viewType,
          title,
          webview: {
            html: "",
            messages: [],
            postMessage(m: unknown) {
              panel.webview.messages.push(m);
            },
            onDidReceiveMessage(cb: (msg: Record<string, unknown>) => void) {
              panel.webview.handler = cb;
            },
            handler: null,
          },
        };
        panels.push(panel);
        return panel;
      },
      showQuickPick: async (items: string[]) =>
        (over.pickPrefix ? items.find((i) => i.startsWith(over.pickPrefix as string)) : undefined) ?? items[0],
      showInputBox: async () => over.inputBox ?? "input",
      ...(over.editor ? { activeTextEditor: over.editor } : {}),
      createTextEditorDecorationType: (opts: unknown) => opts,
      registerTreeDataProvider: () => undefined,
    },
    workspace: {
      getConfiguration: (_section: string) => ({ get: <T,>(_key: string): T | undefined => undefined }),
      fs: (() => {
        const files = new Map<string, string>();
        return {
          exists: (p: string) => files.has(p),
          read: (p: string) => {
            const c = files.get(p);
            if (c === undefined) throw new Error(`missing ${p}`);
            return c;
          },
          write: (p: string, c: string) => {
            files.set(p, c);
          },
        };
      })(),
    },
    languages: {
      registerHoverProvider: () => undefined,
    },
    commands: {
      registerCommand: (id: string, cb: (...args: unknown[]) => unknown) => {
        // Mirror the real API: duplicate registration throws and fails
        // activation. This pin caught the deci.showDecisions double-register
        // that silently killed the extension in a live window.
        if (commands.has(id)) throw new Error(`command '${id}' already exists`);
        commands.set(id, cb);
        return undefined;
      },
    },
  };
  return { vscode: vscode as unknown as Vscode, panels, commands };
}

function first(queue: DecisionPoint[]): DecisionPoint {
  assert.ok(queue[0]);
  return queue[0];
}

describe("vscode panels", () => {
  it("renders review, decisions, evidence, bundle, history, inputs, provider panels", () => {
    const { vscode, panels } = stubVscode();
    showReviewMap(vscode, DIFF);
    const queue = showDecisions(vscode, DIFF);
    assert.ok(queue.length > 0);
    showEvidence(vscode, queue);
    showOutputBundle(vscode, DIFF, queue);
    showHistory(vscode, []);
    showInputsPanel(vscode, { kind: "working" }, null, null);
    showProviderStatus(vscode);
    const titles = panels.map((p) => p.title);
    assert.ok(titles.includes("Review Map") && titles.includes("Decisions") && titles.includes("Evidence"));
    const review = panels.find((p) => p.title === "Review Map");
    assert.match(review?.webview.html ?? "", /Review Map/);
  });

  it("renders prebuilt impact HTML verbatim (no escaping)", () => {
    const { vscode, panels } = stubVscode();
    showImpactReport(vscode, "<html><body>live</body></html>");
    assert.equal(panels[panels.length - 1]?.webview.html, "<html><body>live</body></html>");
  });

  it("alternative studio picks and previews without writes", () => {
    const { vscode } = stubVscode();
    const queue = decisionsForDiff(DIFF);
    const rejected = rejectDecision(queue, first(queue).id, "wrong-security", "keep auth strict");
    const set = showAlternatives(vscode, first(rejected));
    assert.equal(set.options.length, 3);
    const second = set.options[1]?.id;
    assert.ok(second);
    const picked = pickStudioAlternative(vscode, set, second);
    assert.equal(picked.pickedId, second);
    previewImplementation(vscode, picked);
    const result = applyPickedAlternative(vscode, picked, rejected, DIFF);
    assert.ok(result.patch.files.length > 0);
  });
});

describe("vscode decorations + commands", () => {
  it("no-ops without an editor, decorates with one", () => {
    const queue = decisionsForDiff(DIFF);
    applyDecisionDecorations(stubVscode().vscode, queue); // must not throw
    const decorated: unknown[][] = [];
    const editor = {
      document: { uri: { fsPath: "x" }, lineCount: 10 },
      setDecorations: (_kind: unknown, ranges: unknown[]) => { decorated.push(ranges); },
    };
    applyDecisionDecorations(stubVscode({ editor }).vscode, queue, () => 7);
    assert.equal(decorated.length, 4); // one decoration kind per severity
    assert.ok(decorated.flat().some((r) => (r as { line: number }).line === 20));
  });

  it("emits plain {line, character} points — the real host must translate to vscode.Range", () => {
    // Regression pin for the live-host failure where setDecorations received
    // plain points and the real API threw. Core stays editor-agnostic here;
    // host.ts maps these to vscode.Range at the seam.
    const queue = decisionsForDiff(DIFF);
    const seen: unknown[][] = [];
    const editor = {
      document: { uri: { fsPath: "x" }, lineCount: 10 },
      setDecorations: (_kind: unknown, ranges: unknown[]) => { seen.push(ranges); },
    };
    applyDecisionDecorations(stubVscode({ editor }).vscode, queue, () => 3);
    for (const ranges of seen) {
      for (const r of ranges) {
        assert.deepEqual(Object.keys(r as Record<string, unknown>).sort(), ["character", "line"]);
      }
    }
  });

  it("registers each command exactly once (duplicates fail activation live)", async () => {
    const solo = stubVscode();
    const queue = decisionsForDiff(DIFF);
    registerDecisionCommands(solo.vscode, queue);
    // showDecisions lives with the other show* commands in activate().
    assert.ok(!solo.commands.has("deci.showDecisions"));
    const first = stubVscode();
    const api = activate(first.vscode, { storageDir: `mem://${Math.random()}`, workspaceRoot: "/repo" });
    void api;
    assert.ok(first.commands.has("deci.showDecisions"));
    // Second activation on a fresh stub must also succeed (no cross-call state).
    const second = stubVscode();
    activate(second.vscode, { storageDir: `mem://${Math.random()}`, workspaceRoot: "/repo" });
    assert.ok(second.commands.has("deci.showDecisions"));
    assert.ok(second.commands.has("deci.showReviewMap"));
    assert.ok(second.commands.has("deci.openChat"));
  });

  it("accept/investigate transition, reject requires reason + constraint", async () => {
    const { vscode, commands } = stubVscode({ pickPrefix: "wrong-security", inputBox: "stay consistent" });
    const queue = decisionsForDiff(DIFF);
    const handle = registerDecisionCommands(vscode, queue);
    const id = first(queue).id;
    await commands.get("deci.decisionAccept")?.(id);
    assert.equal(handle.get().find((d) => d.id === id)?.status, "accepted");
    await commands.get("deci.decisionInvestigate")?.(id);
    assert.equal(handle.get().find((d) => d.id === id)?.status, "investigating");
    await commands.get("deci.decisionReject")?.(id);
    assert.equal(handle.get().find((d) => d.id === id)?.status, "rejected");
    // Missing constraint aborts the reject.
    const s2 = stubVscode({ pickPrefix: "other", inputBox: "   " });
    const handle2 = registerDecisionCommands(s2.vscode, queue);
    await s2.commands.get("deci.decisionReject")?.(id);
    assert.equal(handle2.get().find((d) => d.id === id)?.status, "pending");
  });

  it("prompts diff source, range, and manual pick", async () => {
    const r = await promptReviewInputs(stubVscode({ pickPrefix: "working tree", inputBox: "" }).vscode);
    assert.deepEqual(r.spec, { kind: "working" });
    const manual = await promptReviewInputs(stubVscode({ pickPrefix: "manual", inputBox: "" }).vscode, {
      manualFiles: [{ path: "a.ts", content: "x" }],
    });
    assert.ok(manual.manualDiff?.includes("a.ts"));
    assert.ok(manualDiffForFiles([{ path: "a.ts", content: "x" }]).includes("a.ts"));
  });

  it("provider reads env, activate wires views + history", () => {
    const { vscode } = stubVscode();
    const cfg = providerForHost(vscode, { DECI_PROVIDER: "ollama" });
    assert.equal(cfg.provider, "ollama");
    const { providers, history } = activate(vscode);
    assert.deepEqual(viewIds().sort(), ["deci.alternatives", "deci.chat", "deci.decisions", "deci.evidence", "deci.history", "deci.review"]);
    const queue = decisionsForDiff(DIFF);
    history.note("review 1", DIFF, queue);
    assert.equal(history.list().length, 1);
    assert.ok(providers["deci.decisions"].nodes.length >= 0);
    assert.ok(noteReview([], "r", DIFF, queue).length === 1);
    assert.ok(createListProvider().getChildren().length === 0);
  });

  it("showReviewMap populates the evidence sidebar (no stale placeholder)", () => {
    const { vscode, commands } = stubVscode();
    const { providers } = activate(vscode);
    commands.get("deci.showReviewMap")?.(DIFF);
    const nodes = providers["deci.evidence"].getChildren() as Array<{ label?: unknown }>;
    assert.ok(nodes.length > 0);
    assert.ok(!String(nodes[0]?.label ?? "").includes("run analysis first"));
  });
});

describe("interactive review UI", () => {
  it("dead commands are bound now", () => {
    const { vscode, commands } = stubVscode();
    activate(vscode);
    for (const id of ["deci.showAlternatives", "deci.showEvidence", "deci.newReview", "deci.openDiffReview", "deci.openSettings", "deci.openTests", "deci.openHistory", "deci.compareRuns"]) {
      assert.ok(commands.has(id), id);
    }
  });

  it("Diff Review opens with findings, strict CSP and nonce", async () => {
    const { vscode, panels, commands } = stubVscode();
    activate(vscode);
    await commands.get("deci.openDiffReview")?.(DIFF);
    const p = panels.find((x) => x.viewType === "deci.diffReview");
    assert.ok(p, "diff panel created");
    assert.ok(p.webview.html.includes("Diff Review"));
    assert.ok(p.webview.html.includes("Content-Security-Policy") && p.webview.html.includes("nonce-"));
    assert.ok(p.webview.html.includes("src/auth/login.ts"));
    assert.ok(p.webview.handler, "message handler wired");
  });

  it("decision + note round-trip patches the diff", async () => {
    const { vscode, panels, commands } = stubVscode();
    activate(vscode);
    await commands.get("deci.openDiffReview")?.(DIFF);
    const p = panels.find((x) => x.viewType === "deci.diffReview");
    assert.ok(p?.webview.handler);
    const send = p.webview.handler as (m: Record<string, unknown>) => Promise<void>;
    const idMatch = /data-finding="([^"]+)"/.exec(p.webview.html);
    assert.ok(idMatch, "finding id rendered");
    const fid = idMatch[1] as string;
    await send({ type: "decision", id: fid, action: "accept" });
    const patches = p.webview.messages.filter((m) => (m as { type?: string }).type === "patch");
    assert.ok(patches.length > 0, "decision pushes a patch");
    assert.ok(JSON.stringify(patches).includes("accepted"));
    await send({ type: "note", op: "add", file: "src/auth/login.ts", line: 20, text: "check <this>", findingId: fid });
    const patches2 = p.webview.messages.filter((m) => (m as { type?: string }).type === "patch");
    const last = JSON.stringify(patches2[patches2.length - 1]);
    assert.ok(last.includes("check &lt;this&gt;"), "note text escaped in patch");
    await send({ type: "view", view: "split" });
    assert.ok(JSON.stringify(p.webview.messages).includes("diff-grid"), "split view renders");
  });

  it("settings, new-review, tests and history panels render", async () => {
    const { vscode, panels, commands } = stubVscode();
    activate(vscode);
    await commands.get("deci.openSettings")?.();
    const s = panels.find((x) => x.viewType === "deci.settings");
    assert.ok(s && s.webview.html.includes("OpenAI") && s.webview.html.includes("Anthropic") && s.webview.html.includes("Allow cloud AI"));
    assert.ok(s.webview.html.includes("key: none needed"), "vscode-lm needs no key");
    await commands.get("deci.newReview")?.();
    assert.ok(panels.find((x) => x.viewType === "deci.newReview")?.webview.html.includes("Branch range"));
    await commands.get("deci.openTests")?.();
    assert.ok(panels.find((x) => x.viewType === "deci.tests")?.webview.html.includes("Verification"));
    await commands.get("deci.openHistory")?.();
    const h = panels.find((x) => x.viewType === "deci.historyView");
    assert.ok(h?.webview.handler, "history handler wired");
    await (h.webview.handler as (m: Record<string, unknown>) => Promise<void>)({ type: "compareSelect", id: "x" });
    assert.ok(h.webview.messages.some((m) => (m as { type?: string }).type === "patch"));
  });

  it("malformed UI messages never throw", async () => {
    const { vscode, panels, commands } = stubVscode();
    activate(vscode);
    await commands.get("deci.openDiffReview")?.(DIFF);
    const p = panels.find((x) => x.viewType === "deci.diffReview");
    const send = p?.webview.handler as (m: Record<string, unknown>) => Promise<void>;
    await send({});
    await send({ type: "decision" });
    await send({ type: "note", op: "add" });
    await send({ type: "nope" });
  });

  it("notes and decisions persist under .deci/", async () => {
    const { vscode, panels, commands } = stubVscode();
    activate(vscode);
    await commands.get("deci.openDiffReview")?.(DIFF);
    const p = panels.find((x) => x.viewType === "deci.diffReview");
    const send = p?.webview.handler as (m: Record<string, unknown>) => Promise<void>;
    const idMatch = /data-finding="([^"]+)"/.exec(p?.webview.html ?? "");
    const fid = (idMatch?.[1] ?? "") as string;
    await send({ type: "note", op: "add", file: "src/auth/login.ts", line: 20, text: "persist me", findingId: fid });
    await send({ type: "decision", id: fid, action: "accept" });
    const fs = vscode.workspace.fs as unknown as { read(p: string): string; exists(p: string): boolean };
    let rev = "worktree";
    try {
      rev = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim() || rev;
    } catch {
      /* outside a repo */
    }
    assert.ok(fs.exists(join(process.cwd(), `.deci/notes/${rev}.json`)), "note file written");
    assert.ok(fs.read(join(process.cwd(), `.deci/notes/${rev}.json`)).includes("persist me"), "note content persisted");
    assert.ok(fs.exists(join(process.cwd(), `.deci/decisions/${rev}.json`)), "decision file written");
    assert.ok(fs.read(join(process.cwd(), `.deci/decisions/${rev}.json`)).includes("accepted"), "decision choice persisted");
  });
});
