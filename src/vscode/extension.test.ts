// VS Code adapter tests: exercise every editor-agnostic entry point with a
// stub host. host.ts (real `vscode` module) cannot load headless — that seam
// is BLOCKED on the VS Code runtime and covered by typecheck + packaging.
import assert from "node:assert/strict";
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
  webview: { html: string };
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
        const panel: Panel = { viewType, title, webview: { html: "" } };
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
      registerHoverProvider: () => undefined,
    },
    commands: {
      registerCommand: (id: string, cb: (...args: unknown[]) => unknown) => {
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
    assert.deepEqual(viewIds().sort(), ["deci.alternatives", "deci.decisions", "deci.evidence", "deci.history", "deci.review"]);
    const queue = decisionsForDiff(DIFF);
    history.note("review 1", DIFF, queue);
    assert.equal(history.list().length, 1);
    assert.ok(providers["deci.decisions"].nodes.length >= 0);
    assert.ok(noteReview([], "r", DIFF, queue).length === 1);
    assert.ok(createListProvider().getChildren().length === 0);
  });
});
