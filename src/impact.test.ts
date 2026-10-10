import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildImpactMap, renderImpactMarkdown, type ImpactIo } from "./impact.js";
import type { ChangedSymbol } from "./symbols.js";

const sym = (over: Partial<ChangedSymbol> & { name: string }): ChangedSymbol => ({
  kind: "function",
  file: "src/pricing.ts",
  line: 1,
  change: "modified",
  signature: "export function totalFor",
  ...over,
});

const memIo = (files: Record<string, string>): ImpactIo => ({
  listFiles: () => Object.keys(files),
  read: (p) => {
    if (!(p in files)) throw new Error(`ENOENT ${p}`);
    return files[p] as string;
  },
});

describe("impact", () => {
  const repo = {
    "src/cart.ts": `import { totalFor } from "./pricing.js";\nexport const r = totalFor([], 0);`,
    "src/api.ts": `import { checkout } from "./cart.js";\ncheckout([], 0);`,
    "src/other.ts": `export const x = 1;`,
    "test/pricing.test.ts": `import { totalFor } from "../src/pricing.js";\ntotalFor([], 0);`,
  };

  it("finds direct referrers with evidence class and lines", () => {
    const map = buildImpactMap([sym({ name: "totalFor" })], ["src/pricing.ts"], memIo(repo), ".");
    assert.ok(map.directFiles.includes("src/cart.ts"));
    assert.ok(map.directFiles.includes("test/pricing.test.ts"));
    assert.ok(!map.directFiles.includes("src/other.ts"));
    assert.ok(!map.directFiles.includes("src/pricing.ts"));
    const cart = map.edges.find((e) => e.toFile === "src/cart.ts");
    assert.equal(cart?.evidence, "import-resolved");
    assert.equal(cart?.toLine, 1);
    assert.equal(cart?.depth, "direct");
    assert.ok((cart?.matches ?? 0) >= 1);
    assert.ok(map.testFiles.includes("test/pricing.test.ts"));
  });

  it("never creates edges from filename similarity alone", () => {
    const map = buildImpactMap(
      [sym({ name: "totalFor" })],
      ["src/pricing.ts"],
      memIo({ "src/pricing-helper.ts": `export const x = 1;` }),
      ".",
    );
    assert.equal(map.edges.length, 0);
    assert.ok(map.unresolved.some((u) => u.includes("No references")));
  });

  it("traces indirect importers one hop out", () => {
    const map = buildImpactMap([sym({ name: "totalFor" })], ["src/pricing.ts"], memIo(repo), ".");
    const indirect = map.edges.find((e) => e.toFile === "src/api.ts");
    assert.equal(indirect?.depth, "indirect");
    assert.equal(indirect?.evidence, "import-resolved");
  });

  it("discloses scan failures instead of implying coverage", () => {
    const empty: ImpactIo = { listFiles: () => null, read: () => { throw new Error("x"); } };
    const map = buildImpactMap([sym({ name: "totalFor" })], ["src/pricing.ts"], empty, "nope");
    assert.equal(map.edges.length, 0);
    assert.ok(map.unresolved.length > 0);
    assert.match(renderImpactMarkdown(map), /Coverage gaps|scanned/);
  });

  it("caps the scan and says so", () => {
    const many: Record<string, string> = {};
    for (let i = 0; i < 250; i++) many[`src/f${i}.ts`] = `totalFor();`;
    const map = buildImpactMap([sym({ name: "totalFor" })], ["src/pricing.ts"], memIo(many), ".");
    assert.equal(map.truncated, true);
    assert.ok(map.unresolved.some((u) => u.includes("capped")));
    assert.match(renderImpactMarkdown(map), /direct/);
  });

  it("ignores agent-harness worktrees holding repo copies", () => {
    const map = buildImpactMap(
      [sym({ name: "totalFor" })],
      ["src/pricing.ts"],
      memIo({ ".kilo/worktrees/w/src/cart.ts": `import { totalFor } from "./pricing.js";` }),
      ".",
    );
    assert.equal(map.edges.length, 0);
    assert.equal(map.scannedFiles, 0);
  });
});
