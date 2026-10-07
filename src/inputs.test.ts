import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildManualDiff,
  collectDiffText,
  describeDiffSpec,
  diffCommandFor,
  parseDiffArgs,
  renderInputsMarkdown,
  resolveRefInput,
  type InputIo,
} from "./inputs.js";
import { parseUnifiedDiff } from "./reviewMap.js";

const io = (over: Partial<InputIo> = {}): InputIo => ({
  exec: () => "",
  exists: () => false,
  read: () => "",
  ...over,
});

describe("inputs", () => {
  it("parses diff flags with file > staged > range > working precedence", () => {
    assert.deepEqual(parseDiffArgs([]), { kind: "working" });
    assert.deepEqual(parseDiffArgs(["--staged"]), { kind: "staged" });
    assert.deepEqual(parseDiffArgs(["--diff", "main...HEAD"]), { kind: "range", range: "main...HEAD" });
    assert.deepEqual(parseDiffArgs(["--range", "a..b"]), { kind: "range", range: "a..b" });
    assert.deepEqual(parseDiffArgs(["--base", "main"]), { kind: "range", range: "main...HEAD" });
    assert.deepEqual(parseDiffArgs(["--file", "x.diff"]), { kind: "file", path: "x.diff" });
    assert.deepEqual(parseDiffArgs(["--staged", "--file", "x.diff"]), { kind: "file", path: "x.diff" });
  });

  it("maps specs to local git commands only (file → null, never a fetch)", () => {
    assert.equal(diffCommandFor({ kind: "working" }), "git diff HEAD");
    assert.equal(diffCommandFor({ kind: "staged" }), "git diff --staged");
    assert.equal(diffCommandFor({ kind: "range", range: "main...HEAD" }), "git diff main...HEAD");
    assert.equal(diffCommandFor({ kind: "file", path: "x" }), null);
    for (const spec of [{ kind: "working" }, { kind: "staged" }] as const)
      assert.ok(!(diffCommandFor(spec) as string).includes("fetch"));
  });

  it("collects git diff text and hints --file when git fails", () => {
    const text = collectDiffText({ kind: "range", range: "main...HEAD" }, io({ exec: (c) => `ran:${c}` }));
    assert.equal(text, "ran:git diff main...HEAD");
    assert.throws(
      () =>
        collectDiffText({ kind: "working" }, io({ exec: () => { throw new Error("not a repo"); } })),
      /--file/,
    );
  });

  it("reads single file and synthesizes folder picks via listFiles", () => {
    assert.equal(collectDiffText({ kind: "file", path: "a.diff" }, io({ read: () => "DIFF" })), "DIFF");
    const text = collectDiffText(
      { kind: "file", path: "picked" },
      io({ listFiles: () => ["a.ts", "b.ts"], read: (p) => `content of ${p}` }),
    );
    assert.equal(parseUnifiedDiff(text).length, 2);
    assert.throws(() => collectDiffText({ kind: "file", path: "nope" }, io({ read: () => { throw new Error("ENOENT"); } })), /cannot read nope/);
  });

  it("resolves ticket/doc refs: file wins, http unreachable, inline kept, never throws", () => {
    const warns: string[] = [];
    const files = io({ exists: (p) => p === "T.md", read: () => "TICKET-BODY", onRemote: (r) => warns.push(r) });
    assert.equal(resolveRefInput("T.md", files).text, "TICKET-BODY");
    const remote = resolveRefInput("https://jira/x/AUTH-9", files);
    assert.equal(remote.unreachable, true);
    assert.deepEqual(warns, ["https://jira/x/AUTH-9"]);
    assert.equal(resolveRefInput("AUTH-9 require login", files).text, "AUTH-9 require login");
    assert.deepEqual(resolveRefInput(null, files), { text: null, unreachable: false, ref: null });
    const throwing = io({ exists: () => { throw new Error("disk"); } });
    assert.equal(resolveRefInput("T.md", throwing).unreachable, true);
  });

  it("buildManualDiff round-trips through parseUnifiedDiff; empty → empty", () => {
    assert.equal(buildManualDiff([]), "");
    const diff = buildManualDiff([{ path: "src/a.ts", content: "line1\nline2" }]);
    const parsed = parseUnifiedDiff(diff);
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0]?.path, "src/a.ts");
    assert.equal((parsed[0]?.added ?? 0), 2);
  });

  it("renders inputs summary with diff + ticket/doc marks", () => {
    const md = renderInputsMarkdown(
      { kind: "range", range: "main...HEAD" },
      { text: "t", unreachable: false, ref: "AUTH-1" },
      { text: null, unreachable: true, ref: "https://docs/x" },
    );
    assert.match(md, /branch-vs-base/);
    assert.match(md, /✓ AUTH-1/);
    assert.match(md, /✗ https:\/\/docs\/x \(unreachable\)/);
    assert.match(renderInputsMarkdown({ kind: "working" }, { text: null, unreachable: false, ref: null }, { text: null, unreachable: false, ref: null }), /— not provided/);
    assert.ok(describeDiffSpec({ kind: "file", path: "p" }).includes("manual pick"));
  });
});
