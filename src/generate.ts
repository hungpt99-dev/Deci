// Deterministic test scaffolding from real code. No LLM, no invented APIs:
// every generated case imports the actual source file, calls a real
// exported symbol with derived arguments, and labels its assertion basis:
// - structural: type/defined checks (always safe).
// - guard-derived: `throws` only when a `throw` is observed near the symbol.
// - contract: route/handler presence for endpoint symbols.
// - TODO-pin: expected values a human must supply (marked, never faked).
//
// Generated files are NEVER written implicitly — see writeGeneratedTests,
// which refuses to overwrite without explicit force (approval gate).

import type { ChangedSymbol } from "./symbols.js";

export type GenFramework = "node:test" | "jest" | "vitest";

export interface GeneratedTest {
  /** Proposed repo-relative path (sibling or new). */
  path: string;
  framework: GenFramework;
  source: string;
  covers: string[];
  target: string;
  generated: true;
}

export interface GenerateIo {
  readFile: (path: string) => string | null;
}

function importOf(fromPath: string, targetFile: string): string {
  const fromDir = fromPath.split("/").slice(0, -1);
  const toParts = targetFile.split("/");
  let i = 0;
  while (i < fromDir.length && i < toParts.length - 1 && fromDir[i] === toParts[i]) i++;
  const up = fromDir.length - i;
  const rel = [...Array(up).fill(".."), ...toParts.slice(i)].join("/") || ".";
  // NodeNext/ESM needs an explicit specifier: TS sources resolve to .js,
  // JS sources keep their extension.
  const mapped = rel.replace(/\.(ts|tsx|mts|cts)$/, ".js");
  return mapped.startsWith(".") ? mapped : `./${mapped}`;
}

/** Sibling test path for a source file (same dir, same language toolchain). Exported so callers can re-place it. */
export function siblingTestPath(sourceFile: string, framework: GenFramework): string {
  // Same-language siblings so the repo's own toolchain (tsc, jest, vitest,
  // or plain node --test for .mjs) picks them up unchanged.
  if (framework === "node:test" && /\.mjs$/.test(sourceFile)) return sourceFile.replace(/\.mjs$/, ".test.mjs");
  const m = sourceFile.match(/^(.*)\.([^./]+)$/);
  return m ? `${m[1]}.test.${m[2]}` : `${sourceFile}.test`;
}

/** Source window around a symbol's declaration for guards/docs evidence. */
function windowFor(content: string, symbol: ChangedSymbol, radius = 15): string[] {
  const lines = content.split("\n");
  let at = -1;
  if (symbol.line) at = symbol.line - 1;
  else {
    const re = new RegExp(`(function|class)\\s+${symbol.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
    at = lines.findIndex((l) => re.test(l));
  }
  if (at < 0) return [];
  return lines.slice(Math.max(0, at - radius), at + radius + 1);
}

function zeroValue(param: string): string {
  const p = param.trim();
  if (/^\[/.test(p) || /array|list|items|cart/i.test(p)) return "[]";
  if (/^{/.test(p) || /obj|opts|config|body|item$/i.test(p)) return "{}";
  if (/str|name|sku|role|path|url/i.test(p)) return `""`;
  if (/pct|percent|num|count|qty|price|total|index|size|len/i.test(p)) return "0";
  return "undefined";
}

function paramDetailsOf(signature: string): Array<{ name: string; type: string | null }> {
  const m = /\(([^)]*)\)/.exec(signature);
  if (!m) return [];
  return m[1].split(",").map((p) => p.trim()).filter(Boolean).map((p) => {
    const [left, ...rest] = p.split(":");
    const type = rest.length > 0 ? rest.join(":").split("=")[0]?.trim() || null : null;
    return { name: (left ?? "").split("=")[0]?.trim() ?? "", type };
  });
}

/**
 * Cast an intentionally wrong-typed probe value so strict `tsc` builds keep
 * passing (a generated test must not break the repo's own type gate).
 * Exported named types are imported in the header; anything else falls back
 * to `as never` (compiles without inventing an import that does not exist).
 * No type info (JS targets) → value unchanged.
 */
function castAs(value: string, type: string | null, exported: Set<string>): string {
  if (!type || /^(any|unknown|never)$/.test(type)) return value;
  const base = /[A-Za-z_$][\w$]*/.exec(type)?.[0] ?? "";
  // Primitives and built-ins need no import; custom names do.
  if (/^(number|string|boolean|bigint|symbol|void|null|undefined|object|Function|Array|Record|Partial|Pick|Omit|Readonly|Promise|Date|RegExp|Error|Map|Set)$/.test(base)) {
    return `(${value} as unknown as ${type})`;
  }
  if (base && exported.has(base)) return `(${value} as unknown as ${type})`;
  return `(${value} as never)`;
}

/** Exported type/interface/class/enum names in a source file. */
function exportedTypes(content: string): Set<string> {
  const out = new Set<string>();
  const re = /export\s+(?:interface|type|class|enum)\s+([A-Za-z_$][\w$]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) out.add(m[1] as string);
  return out;
}

/** Type identifiers a generated source needs imported (from cast types). */
function neededTypeImports(source: string, exported: Set<string>): string[] {
  const used = new Set<string>();
  const re = /as unknown as ([A-Za-z_$][\w$]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    if (exported.has(m[1] as string)) used.add(m[1] as string);
  }
  return [...used].sort();
}

function asserts(framework: GenFramework): { imp: string; ok: (v: string, msg: string) => string; eq: (a: string, b: string, msg: string) => string; throws: (fn: string, msg: string, expected?: string) => string } {
  if (framework === "node:test") {
    return {
      imp: `import assert from "node:assert/strict";`,
      ok: (v: string, msg: string) => `assert.ok(${v}, ${msg});`,
      eq: (a: string, b: string, msg: string) => `assert.equal(${a}, ${b}, ${msg});`,
      throws: (fn: string, msg: string, expected?: string) =>
        expected ? `assert.throws(${fn}, ${expected}, ${msg});` : `assert.throws(${fn}, ${msg});`,
    };
  }
  return {
    imp: `// jest/vitest: uses global describe/it/expect`,
    ok: (v: string, msg: string) => `expect(${v}).toBeTruthy(); // ${msg}`,
    eq: (a: string, b: string, msg: string) => `expect(${a}).toBe(${b}); // ${msg}`,
    throws: (fn: string, msg: string, expected?: string) => `expect(${fn}).toThrow(${expected ?? ""}); // ${msg}`,
  };
}

/** Error constructor named by an observed `throw new X` (for typed throw assertions). */
function throwNameOf(win: string[]): string | null {
  for (const l of win) {
    const m = /\bthrow\s+new\s+([A-Za-z_$][\w$]*)/.exec(l);
    if (m) return m[1] as string;
  }
  return null;
}

function testFn(framework: GenFramework, name: string, body: string): string {
  return framework === "node:test"
    ? `test(${JSON.stringify(name)}, () => {\n${body}\n});`
    : `it(${JSON.stringify(name)}, () => {\n${body}\n});`;
}

/** Symbols → reviewable scaffolds. Pure; unknown input → []. */
export function generateTests(
  symbols: ChangedSymbol[],
  io: GenerateIo,
  framework: GenFramework = "node:test",
  opts: { previousLines?: string[] } = {},
): GeneratedTest[] {
  const out: GeneratedTest[] = [];
  const A = asserts(framework);
  for (const s of symbols) {
    if (s.kind === "unknown") continue;
    let content: string | null = null;
    try {
      content = io.readFile(s.file);
    } catch {
      content = null;
    }
    if (!content) continue;
    if (s.kind === "endpoint") {
      out.push(endpointTest(s, content, framework));
      continue;
    }
    if (s.kind !== "function" && s.kind !== "method") continue;
    const win = windowFor(content, s);
    const hasThrow = win.some((l) => /\bthrow\b/.test(l));
    const throwName = throwNameOf(win);
    const details = paramDetailsOf(s.signature);
    const params = details.map((d) => d.name);
    const typeOf = (name: string): string | null => details.find((d) => d.name === name)?.type ?? null;
    const exp = exportedTypes(content);
    const cast = (value: string, param: string): string => castAs(value, typeOf(param), exp);
    const args = params.map(zeroValue);
    const imp = importOf(siblingTestPath(s.file, framework), s.file);
    const cases: string[] = [];
    const covers: string[] = [];
    cases.push(testFn(framework, `${s.name}: happy path returns a defined value`, `  const result = ${s.name}(${args.join(", ")});\n  ${A.ok("result !== undefined", JSON.stringify("result defined"))}\n  // TODO-pin(reviewer): replace with the exact expected value for these inputs.`) );
    covers.push("happy path (structural)");
    // Null probe: crash-safe by construction (try/catch documents the
    // outcome instead of failing on it). Plain JS when the target is JS —
    // type annotations would be a syntax error there. Tighten to an
    // assertion once the intended null behavior is confirmed.
    const isTs = /\.(ts|tsx|mts|cts)$/.test(s.file);
    const decl = isTs ? `let noted: string;` : `let noted;`;
    const errName = isTs ? `(err as Error)?.constructor?.name` : `(err)?.constructor?.name`;
    cases.push(testFn(framework, `${s.name}: null/empty inputs are handled`, [
      `  ${decl}`,
      `  try { ${s.name}(${params.map((p) => cast(/array|list|items|cart/i.test(p) ? "[]" : "undefined", p)).join(", ")}); noted = "returned"; }`,
      `  catch (err) { noted = \`threw \${${errName} ?? "unknown"}\`; }`,
      `  ${A.ok("typeof noted === \"string\"", JSON.stringify("documents current null behavior — tighten once intended behavior is confirmed"))}`,
    ].join("\n")));
    covers.push("null/empty (documents current behavior)");
    if (hasThrow && params.length > 0) {
      const expected = throwName ? `/${throwName}/` : undefined;
      const badArgs = params.map((p) => cast("-1", p)).join(", ");
      cases.push(testFn(framework, `${s.name}: invalid input throws (guard observed in source)`, `  ${A.throws(`() => ${s.name}(${badArgs})`, JSON.stringify("guard-derived: throw observed near declaration"), expected)}`));
      covers.push("invalid input (guard-derived)");
    }
    // Regression pins: boundary values from PREVIOUS (removed) guard lines.
    // These assert the old contract still holds — if the change was
    // intentional, the failure tells the reviewer to update the test, not
    // the code. Values are derived, never invented: `x > 50` → 51.
    for (const pin of regressionPins(s, opts.previousLines ?? [], exp)) {
      const expected = throwNameOf(opts.previousLines ?? []);
      const expArg = expected ? `/${expected}/` : undefined;
      cases.push(testFn(framework, `${s.name}: still rejects ${pin.value} (previous behavior)`, `  ${A.throws(`() => ${s.name}(${pin.args})`, JSON.stringify(`regression: pinned from removed guard "${pin.guard}" — update me if the change was intentional`), expArg)}`));
      covers.push(`regression (pinned: ${pin.guard})`);
    }
    const body = cases.join("\n\n");
    const typeImports = neededTypeImports(body, exp);
    const named = [s.name, ...typeImports.map((t) => `type ${t}`)].join(", ");
    const header = framework === "node:test"
      ? `${A.imp}\nimport { test } from "node:test";\nimport { ${named} } from ${JSON.stringify(imp)};`
      : `${A.imp}\nimport { ${named} } from ${JSON.stringify(imp)};`;
    out.push({
      path: siblingTestPath(s.file, framework),
      framework,
      source: `${header}\n\n// Generated by Deci for \`${s.file}#${s.name}\` — review, tighten TODO-pins, then keep.\n\n${body}\n`,
      covers,
      target: `${s.file}#${s.name}`,
      generated: true,
    });
  }
  return out;
}

interface RegressionPin {
  value: number;
  args: string;
  guard: string;
}

/**
 * Derive violating inputs from removed guard comparisons mentioning the
 * symbol's parameters: `discountPct > 50` → call with 51 and expect the
 * throw the old code produced. Only guards that also throw (same line has
 * `throw`, or a sibling removed line does) qualify.
 */
function regressionPins(s: ChangedSymbol, previousLines: string[], exported: Set<string> = new Set()): RegressionPin[] {
  const details = paramDetailsOf(s.signature);
  const params = details.map((d) => d.name);
  if (params.length === 0) return [];
  const throwsNearby = previousLines.some((l) => /\bthrow\b/.test(l));
  if (!throwsNearby) return [];
  const pins: RegressionPin[] = [];
  for (const line of previousLines) {
    const re = /([A-Za-z_$][\w$]*)\s*(>=|<=|>|<)\s*(\d+)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(line)) !== null) {
      const [, name, op, bound] = m as unknown as [string, string, string, string];
      const idx = params.indexOf(name as string);
      if (idx < 0) continue;
      const b = parseInt(bound as string, 10);
      const value = op === ">" || op === ">=" ? b + 1 : op === "<" || op === "<=" ? b - 1 : null;
      if (value === null || value === -1) continue; // -1 already covered by guard-derived case
      const typeOf = (name: string): string | null => details.find((d) => d.name === name)?.type ?? null;
      const args = params.map((p, i) => castAs(i === idx ? String(value) : zeroValue(p), typeOf(p), exported)).join(", ");
      pins.push({ value, args, guard: line.trim().slice(0, 120) });
      if (pins.length >= 2) return pins;
    }
  }
  return pins;
}

function endpointTest(s: ChangedSymbol, content: string, framework: GenFramework): GeneratedTest {
  const imp = importOf(siblingTestPath(s.file, framework), s.file);
  const A = asserts(framework);
  const header = framework === "node:test"
    ? `${A.imp}\nimport { test } from "node:test";`
    : A.imp;
  // Real exports observed in source — assert each is live on the module.
  const exports = [...content.matchAll(/export\s+(?:async\s+)?(?:const|function|class)\s+([A-Za-z_$][\w$]*)/g)]
    .map((m) => m[1] as string).filter((n, i, a) => a.indexOf(n) === i).slice(0, 5);
  const exportAsserts = exports.length
    ? exports.map((n) => `  ${A.ok(`(mod as any)[${JSON.stringify(n)}] !== undefined`, JSON.stringify(`contract: export ${n} is live`))}`).join("\n")
    : `  ${A.ok("Object.keys(mod).length > 0", JSON.stringify("contract: module has exports — TODO-pin(reviewer): assert the route/handler by name"))}`;
  const routeAssert = s.name.startsWith("/")
    ? `\n${testFn(framework, `route ${s.name} is registered`, `  ${A.ok(JSON.stringify(content.includes(s.name)), JSON.stringify(`contract (static): ${s.name} present in ${s.file} — promote to a live router assertion once the app boots in tests`))}`)}`
    : "";
  const body = testFn(framework, `endpoint ${s.name}: module surface is live`, exportAsserts);
  return {
    path: siblingTestPath(s.file, framework),
    framework,
    source: `${header}\nimport * as mod from ${JSON.stringify(imp)};\n\n// Generated by Deci for endpoint \`${s.name}\` in \`${s.file}\`.\n\n${body}${routeAssert}\n`,
    covers: ["endpoint exports live (contract)", ...(s.name.startsWith("/") ? ["route registered (static)"] : [])],
    target: `${s.file}#${s.name}`,
    generated: true,
  };
}

export interface WriteResult {
  written: string[];
  skipped: Array<{ path: string; why: string }>;
}

export interface WriteIo {
  exists: (path: string) => boolean;
  write: (path: string, content: string) => void;
}

/**
 * Approval gate: writes only with explicit caller intent (CLI --write-tests),
 * and never overwrites an existing file unless force:true. Returns what
 * happened per file — no silent overwrites, ever.
 */
export function writeGeneratedTests(
  tests: GeneratedTest[],
  io: WriteIo,
  opts: { force?: boolean } = {},
): WriteResult {
  const written: string[] = [];
  const skipped: Array<{ path: string; why: string }> = [];
  for (const t of tests) {
    let exists = false;
    try {
      exists = io.exists(t.path);
    } catch {
      exists = false;
    }
    if (exists && !opts.force) {
      skipped.push({ path: t.path, why: "Exists — pass force:true to overwrite (your changes are preserved by default)." });
      continue;
    }
    try {
      io.write(t.path, t.source);
      written.push(t.path);
    } catch (err) {
      skipped.push({ path: t.path, why: `Write failed: ${(err as Error).message}` });
    }
  }
  return { written, skipped };
}

/** CLI markdown: proposed files with covers + first-line preview. */
export function renderGeneratedMarkdown(tests: GeneratedTest[]): string {
  if (tests.length === 0) return `## Generated tests\n\nNo generatable symbols in this change.\n`;
  return [
    `## Generated tests (${tests.length} — review before keeping)`,
    ``,
    ...tests.flatMap((t) => [
      `### \`${t.path}\` — targets \`${t.target}\` (${t.framework})`,
      ``,
      `Covers: ${t.covers.join("; ")}.`,
      ``,
      "```ts",
      t.source,
      "```",
      ``,
    ]),
  ].join("\n");
}
