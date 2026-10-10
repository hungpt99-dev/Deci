import { test } from "node:test";
import assert from "node:assert/strict";
import { esc, safeJson, makeNonce, emptyState, banner, severityPill } from "./vscode/ui/html.js";
import { parseDiffHunks, anchorLine } from "./vscode/ui/diffModel.js";
import { DECI_CSS } from "./vscode/ui/css.js";

test("esc neutralises markup, quotes and script payloads", () => {
  assert.equal(esc('<script>alert("x")</script>'), "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
  assert.equal(esc("a'b&c"), "a&#39;b&amp;c");
  assert.equal(esc(null), "");
});

test("safeJson escapes < for script embedding", () => {
  assert.ok(!safeJson({ x: "</script>" }).includes("</"));
});

test("nonces differ per call", () => {
  assert.notEqual(makeNonce(), makeNonce());
});

test("emptyState escapes and optional action", () => {
  const h = emptyState("T <b>", "B &", { id: "run", label: "Go >" });
  assert.ok(h.includes("T &lt;b&gt;") && h.includes('data-act="run"') && h.includes("Go &gt;"));
  assert.ok(!emptyState("T", "B").includes("data-act"));
});

test("banner roles and severity pills pair label with letter", () => {
  assert.ok(banner("hi").includes('role="status"'));
  assert.ok(severityPill("Critical").includes("C Critical"));
  assert.ok(severityPill("Low").includes("L Low"));
});

test("shared CSS uses theme vars, no hard-coded dark background", () => {
  assert.ok(DECI_CSS.includes("var(--vscode-editor-background)"));
  assert.ok(!/#1e1e1e|#252526|#111/.test(DECI_CSS));
});

const DIFF = [
  "diff --git a/src/a.ts b/src/a.ts",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1,3 +1,4 @@",
  " ctx",
  "-old",
  "+new1",
  "+new2",
  " end",
  "diff --git a/new.ts b/new.ts",
  "--- /dev/null",
  "+++ b/new.ts",
  "@@ -0,0 +1 @@",
  "+hi",
].join("\n");

test("parseDiffHunks tracks old/new line numbers per file", () => {
  const files = parseDiffHunks(DIFF);
  assert.equal(files.length, 2);
  assert.equal(files[0]?.path, "src/a.ts");
  const kinds = files[0]?.hunks[0]?.lines.map((l: { kind: string; oldLine: number | null; newLine: number | null }) => [l.kind, l.oldLine, l.newLine]);
  assert.deepEqual(kinds, [
    ["context", 1, 1],
    ["del", 2, null],
    ["add", null, 2],
    ["add", null, 3],
    ["context", 3, 4],
  ]);
  assert.equal(files[0]?.added, 2);
  assert.equal(files[0]?.removed, 1);
  assert.equal(files[1]?.isNew, true);
  assert.equal(files[1]?.hunks[0]?.lines[0]?.newLine, 1);
});

test("parseDiffHunks tolerates empty and malformed input", () => {
  assert.deepEqual(parseDiffHunks(""), []);
  assert.deepEqual(parseDiffHunks("not a diff\n@@ broken"), []);
});

test("anchorLine accepts positive finite lines only", () => {
  assert.equal(anchorLine(3), 3);
  assert.equal(anchorLine(0), null);
  assert.equal(anchorLine(null), null);
  assert.equal(anchorLine(NaN), null);
});
