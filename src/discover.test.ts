import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { discoverTests, renderDiscoveryMarkdown, type DiscoverIo } from "./discover.js";

const memIo = (files: Record<string, string>): DiscoverIo => ({
  listFiles: () => Object.keys(files),
  read: (p) => {
    if (!(p in files)) throw new Error(`ENOENT ${p}`);
    return files[p] as string;
  },
});

const PKG = JSON.stringify({ scripts: { test: "node --test dist/" }, devDependencies: { vitest: "^1.0.0" } });

describe("discover", () => {
  const files = {
    "package.json": PKG,
    "src/a.test.ts": `import { describe, it } from "node:test";\ndescribe("a", () => {});`,
    "src/b.test.ts": `import { describe, it } from "vitest";\ndescribe("b", () => {});`,
    "e2e/login.e2e.ts": `import { test } from "@playwright/test";`,
    "src/api/users.test.ts": `import request from "supertest";\ndescribe("users", () => {});`,
    "src/ui/Button.test.tsx": `import { render } from "@testing-library/react";`,
    "src/plain.txt": `not a test`,
  };

  it("categorizes by path and content with real commands", () => {
    const d = discoverTests(memIo(files), ".");
    assert.equal(d.tests.length, 5);
    const by = new Map(d.tests.map((t) => [t.path, t]));
    assert.equal(by.get("src/a.test.ts")?.framework, "node:test");
    assert.deepEqual(by.get("src/a.test.ts")?.command, ["node", "--test", "src/a.test.ts"]);
    assert.equal(by.get("e2e/login.e2e.ts")?.category, "e2e");
    assert.equal(by.get("src/api/users.test.ts")?.category, "api");
    assert.equal(by.get("src/ui/Button.test.tsx")?.category, "component");
    assert.equal(by.get("src/ui/Button.test.tsx")?.layer, "frontend");
    assert.match(renderDiscoveryMarkdown(d), /Test discovery \(5/);
  });

  it("maps TS tests to verified compiled output, never assumed", () => {
    const withDist = memIo({
      "tsconfig.json": JSON.stringify({ compilerOptions: { outDir: "dist" } }),
      "src/a.test.ts": `import { describe, it } from "node:test";`,
      "dist/a.test.js": `// compiled`,
    });
    const d = discoverTests(withDist, ".");
    assert.deepEqual(d.tests[0]?.command, ["node", "--test", "dist/a.test.js"]);
    const rooted = memIo({
      "tsconfig.json": JSON.stringify({ compilerOptions: { outDir: "dist" } }),
      "src/a.test.ts": `import { describe, it } from "node:test";`,
      "../dist/a.test.js": `// compiled`,
    });
    const dRooted = discoverTests(rooted, "src");
    assert.deepEqual(dRooted.tests[0]?.command, ["node", "--test", "../dist/a.test.js"]);
    const noDist = memIo({
      "tsconfig.json": JSON.stringify({ compilerOptions: { outDir: "dist" } }),
      "src/a.test.ts": `import { describe, it } from "node:test";`,
    });
    const d2 = discoverTests(noDist, ".");
    assert.deepEqual(d2.tests[0]?.command, ["node", "--test", "src/a.test.ts"]);
  });

  it("marks unrunnable frameworks instead of inventing commands", () => {
    const d = discoverTests(memIo({ "svc/FooTest.java": `import org.junit.Test;` }), ".");
    assert.equal(d.tests[0]?.framework, "junit");
    assert.deepEqual(d.tests[0]?.command, []);
    assert.ok(d.tests[0]?.unrunnable);
  });

  it("reports gaps and unreadable files, never throws", () => {
    const d = discoverTests(memIo({ "src/lonely.ts": `export const x = 1;` }), ".");
    assert.equal(d.tests.length, 0);
    assert.ok(d.gaps.some((g) => g.includes("lonely") || g.includes("No tests")));
    const bad: DiscoverIo = { listFiles: () => { throw new Error("disk"); }, read: () => "" };
    assert.ok(discoverTests(bad, ".").gaps.length > 0);
  });

  it("skips agent-harness worktrees holding repo copies", () => {
    const d = discoverTests(memIo({
      "src/a.test.ts": `import { test } from "node:test";`,
      ".kilo/worktrees/w/src/a.test.ts": `import { test } from "node:test";`,
      ".opencode/x.test.ts": `import { test } from "node:test";`,
    }), ".");
    assert.deepEqual(d.tests.map((t) => t.path), ["src/a.test.ts"]);
  });

  it("refuses chained package scripts instead of executing them", () => {
    const d = discoverTests(memIo({
      "package.json": JSON.stringify({ scripts: { test: "npm run build && node --test dist/" } }),
      "test/weird.test.xyz": `some unknown runner format`,
    }), ".");
    // Unknown framework + chained script → unrunnable, never split on spaces.
    assert.deepEqual(d.tests[0]?.command, []);
    assert.ok(d.tests[0]?.unrunnable);
  });
});
