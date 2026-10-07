import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  collectEvidence,
  collectQueueEvidence,
  emptyContext,
  relatedCodeFor,
  renderEvidenceMarkdown,
  renderQueueEvidenceMarkdown,
  type EvidenceContext,
} from "./evidence.js";

const ctx = (over: Partial<EvidenceContext> = {}): EvidenceContext =>
  emptyContext({
    changedFiles: ["src/auth.ts", "src/auth.test.ts", "src/session.ts", "openapi.yaml"],
    fileExists: (p) => p === "src/auth.ts" || p === "src/auth.test.ts",
    readExcerpt: (p) => (p === "src/auth.ts" ? "jwt.verify(token);" : null),
    gitLogFor: (p) => (p === "src/auth.ts" ? ["abc123 fix login expiry", "def456 add jwt"] : []),
    docPaths: ["README.md", "docs/adr-001-auth.md"],
    ticket: { text: "AUTH-1 require re-login on expiry", unreachable: false, ref: "AUTH-1" },
    designDoc: { text: null, unreachable: false, ref: null },
    ...over,
  });

describe("evidence", () => {
  it("collects code/related/test/history/docs/contracts/ticket with present+missing", () => {
    const b = collectEvidence({ id: "D1 x", file: "src/auth.ts" }, ctx());
    const kinds = b.items.map((i) => i.kind);
    for (const k of ["code", "related-code", "test", "git-history", "doc-adr", "contract", "schema-config", "ticket", "design-doc"] as const)
      assert.ok(kinds.includes(k), `missing ${k}`);
    const by = (k: string) => b.items.find((i) => i.kind === k);
    assert.equal(by("code")?.status, "present");
    assert.match(by("code")?.excerpt ?? "", /jwt\.verify/);
    assert.equal(by("related-code")?.status, "present"); // src/session.ts same module
    assert.equal(by("test")?.status, "present");
    assert.equal(by("git-history")?.status, "present");
    assert.equal(by("doc-adr")?.status, "present");
    assert.equal(by("contract")?.status, "present"); // openapi.yaml in diff
    assert.equal(by("schema-config")?.status, "missing");
    assert.equal(by("ticket")?.status, "present");
    assert.match(by("ticket")?.excerpt ?? "", /AUTH-1/);
    assert.equal(by("design-doc")?.status, "missing");
    assert.equal(b.present + b.missing, b.items.length);
  });

  it("unreachable ticket/doc marks missing and never throws", () => {
    const b = collectEvidence(
      { id: "D1 x", file: "src/new.ts" },
      ctx({
        changedFiles: ["src/new.ts"],
        fileExists: () => false,
        readExcerpt: () => {
          throw new Error("disk gone");
        },
        gitLogFor: () => {
          throw new Error("no git");
        },
        docPaths: [],
        ticket: { text: null, unreachable: true, ref: "https://jira/x/AUTH-9" },
        designDoc: { text: null, unreachable: true, ref: "https://docs/x/design" },
      }),
    );
    assert.equal(b.items.find((i) => i.kind === "ticket")?.status, "missing");
    assert.match(b.items.find((i) => i.kind === "ticket")?.note ?? "", /Unreachable/);
    assert.equal(b.items.find((i) => i.kind === "design-doc")?.status, "missing");
    assert.equal(b.items.find((i) => i.kind === "git-history")?.status, "missing");
  });

  it("truncates long excerpts and caps related files", () => {
    const many = ["src/a.ts", ...Array.from({ length: 10 }, (_, i) => `src/r${i}.ts`)];
    assert.ok(relatedCodeFor("src/a.ts", many).length <= 5);
    const b = collectEvidence(
      { id: "D1 x", file: "src/a.ts" },
      ctx({ ticket: { text: "t".repeat(2000), unreachable: false, ref: "T-1" } }),
    );
    assert.ok((b.items.find((i) => i.kind === "ticket")?.excerpt?.length ?? 0) <= 501);
  });

  it("renders ✓/✗ per item and queue sections per decision", () => {
    const b = collectEvidence({ id: "D1 x", file: "src/auth.ts" }, ctx());
    const md = renderEvidenceMarkdown(b);
    assert.match(md, /✓/);
    assert.match(md, /✗/);
    assert.match(md, /D1 x/);
    const qmd = renderQueueEvidenceMarkdown(collectQueueEvidence([{ id: "D1 x", file: "src/auth.ts" }], ctx()));
    assert.match(qmd, /## Evidence \(1\)/);
    assert.match(renderQueueEvidenceMarkdown([]), /No decisions/);
  });
});
