// Test discovery across all project modules. Pure core with injected I/O;
// deterministic, bounded, local-first. Never invents tests: every entry
// names a real file, a detected (or explicitly unknown) framework, and the
// exact argv that would run it — or states why it cannot run.

export type TestCategory =
  | "unit"
  | "component"
  | "integration"
  | "api"
  | "contract"
  | "e2e"
  | "regression";

export type TestLayer = "frontend" | "backend" | "unknown";

export type TestFramework =
  | "node:test"
  | "jest"
  | "vitest"
  | "pytest"
  | "junit"
  | "go-test"
  | "unknown";

export interface DiscoveredTest {
  /** Repo-relative path as listed. */
  path: string;
  category: TestCategory;
  layer: TestLayer;
  framework: TestFramework;
  /** Shell-free argv run from `root` (with cwd=root). Empty = cannot run. */
  command: string[];
  /** Why command is empty, or null when runnable. */
  unrunnable: string | null;
}

export interface TestDiscovery {
  tests: DiscoveredTest[];
  root: string;
  scannedFiles: number;
  truncated: boolean;
  frameworks: TestFramework[];
  /** Coverage gaps: areas with sources but no discovered tests. */
  gaps: string[];
}

export interface DiscoverIo {
  listFiles: (root: string) => string[] | null;
  read: (path: string) => string;
}

const MAX_SCAN_FILES = 400;
const MAX_FILE_BYTES = 100_000;
// Agent-harness worktrees (.kilo/worktrees, .opencode, ...) hold copies of the
// repo — scanning them duplicates every test and corrupts selection counts.
const SKIP_RE = /(^|\/)(node_modules|\.git|dist|build|coverage|\.next|vendor|\.kilo|\.opencode|\.agents|\.cursor|worktrees)(\/|$)/;

const TEST_PATH_RE = /(\.test\.|\.spec\.|__tests__|__snapshots__|Test\.java$|Tests\.java$|(^|\/)tests?(\/|$)|(^|\/)test(\/|$)|(e2e|cypress|playwright)[\/.-])/i;

function isTestPath(p: string): boolean {
  if (/\/dist\//.test(p)) return false;
  return TEST_PATH_RE.test(p);
}

function categorize(path: string, content: string): { category: TestCategory; layer: TestLayer } {
  const lower = path.toLowerCase();
  const body = content.slice(0, 4000).toLowerCase();
  let category: TestCategory = "unit";
  if (/(e2e|cypress|playwright)[\/.-]|\.e2e\./.test(lower)) category = "e2e";
  else if (/contract|pact|openapi|schema/.test(lower)) category = body.includes("pact") || /contract/.test(lower) ? "contract" : "api";
  else if (/(^|\/)api[./-]|route|endpoint|handler|controller/.test(lower) || /supertest|request\(app|fetch\(|axios/.test(body)) category = "api";
  else if (/integration|integ/.test(lower)) category = "integration";
  else if (/regress/.test(lower)) category = "regression";
  else if (/\.(tsx|jsx)$/.test(lower) || /testing-library|enzyme|@vue\/test-utils|mount\(|shallow\(|render\(/.test(body)) category = "component";
  let layer: TestLayer = "unknown";
  if (/(^|\/)(frontend|web|client|app|ui|components)(\/|$)/.test(lower) || /\.(tsx|jsx)$/.test(lower)) layer = "frontend";
  else if (/(^|\/)(backend|server|api|src|lib|service|services)(\/|$)/.test(lower) || /\.py$|\.java$|\.go$/.test(lower)) layer = "backend";
  return { category, layer };
}

function detectFramework(path: string, content: string, pkg: { scripts: Record<string, string>; deps: string[] } | null): TestFramework {
  const head = content.slice(0, 4000);
  if (/\bfrom ["']node:test["']|require\(["']node:test["']\)/.test(head)) return "node:test";
  if (/from ["']vitest["']|require\(["']vitest["']\)|vitest\.config/.test(head) || pkg?.deps.includes("vitest")) return "vitest";
  if (/(@jest\/|require\(["']@jest|from ["']@jest)|jest\.config|@types\/jest/.test(head) || pkg?.deps.includes("jest")) return "jest";
  if (/\.test\.py$/.test(path) || /import pytest|from django.*test|unittest/.test(head)) return "pytest";
  if (/Test\.java$|.*Tests?\.java$/.test(path) || /org\.junit|@Test/.test(head)) return "junit";
  if (/_test\.go$/.test(path)) return "go-test";
  if (/\.test\.(ts|mts|js|mjs|cjs)$/.test(path)) return "node:test";
  if (/\.spec\.(ts|js)$/.test(path)) return pkg?.deps.includes("jasmine") ? "unknown" : "unknown";
  return "unknown";
}

interface PkgInfo {
  scripts: Record<string, string>;
  deps: string[];
}

function readTsOutDir(io: DiscoverIo, root: string): { outDir: string; base: string } | null {
  const norm = root.endsWith("/") ? root.slice(0, -1) : root;
  for (const p of [`${norm}/tsconfig.json`, "tsconfig.json"]) {
    try {
      const j = JSON.parse(io.read(p)) as { compilerOptions?: { outDir?: string } };
      const base = p.includes("/") ? p.split("/").slice(0, -1).join("/") || "." : ".";
      if (j.compilerOptions?.outDir) return { outDir: j.compilerOptions.outDir.replace(/\/$/, ""), base };
      return { outDir: "dist", base };
    } catch {
      continue;
    }
  }
  return null;
}

/** Minimal posix relative path (core stays free of node:path). Null when not portable. */
export function relPosix(from: string, to: string): string | null {
  const norm = (p: string): string[] =>
    p.replace(/\/$/, "").split("/").filter((s) => s !== "" && s !== ".");
  const f = norm(from);
  const t = norm(to);
  if (from.startsWith("/") !== to.startsWith("/")) return null;
  let i = 0;
  while (i < f.length && i < t.length && f[i] === t[i]) i++;
  if (i === 0 && from.startsWith("/")) return null; // different absolute roots
  const rel = [...Array(f.length - i).fill(".."), ...t.slice(i)].join("/");
  return rel === "" ? "." : rel;
}

/**
 * Plain `node --test` cannot run TS sources (relative `./x.js` imports have
 * no on-disk target). When a tsconfig outDir exists AND the compiled test
 * file is verifiably present, run that instead — never assumed, always
 * checked. Commands stay relative to the discovery root (the run cwd).
 * jest/vitest transform TS themselves and keep source commands.
 */
function maybeCompiledCommand(
  io: DiscoverIo,
  root: string,
  test: DiscoveredTest,
  ts: { outDir: string; base: string } | null,
): { command: string[]; mapped: boolean } {
  if (test.framework !== "node:test" || !ts || !/\.(ts|tsx|mts|cts)$/.test(test.path)) {
    return { command: test.command, mapped: false };
  }
  const js = test.path.replace(/\.(tsx|mts|cts)$/, ".js").replace(/\.ts$/, ".js");
  // tsc strips rootDir (conventionally src/); candidates are absolute-ish
  // `base/outDir/...` paths, relativized back to the discovery root.
  const stripped = js.replace(/^src\//, "");
  for (const abs of [`${ts.base}/${ts.outDir}/${js}`, `${ts.base}/${ts.outDir}/${stripped}`]) {
    const rel = relPosix(root, abs);
    if (!rel) continue;
    try {
      io.read(rel);
      return { command: ["node", "--test", rel], mapped: true };
    } catch {
      continue;
    }
  }
  return { command: test.command, mapped: false };
}

function readPkg(io: DiscoverIo, root: string): PkgInfo | null {
  const norm = root.endsWith("/") ? root.slice(0, -1) : root;
  for (const p of [`${norm}/package.json`, "package.json"]) {
    try {
      const raw = io.read(p);
      const j = JSON.parse(raw) as { scripts?: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
      return {
        scripts: j.scripts ?? {},
        deps: [...Object.keys(j.dependencies ?? {}), ...Object.keys(j.devDependencies ?? {})],
      };
    } catch {
      continue;
    }
  }
  return null;
}

/** Preferred runnable command for one test file. Empty argv = cannot run. */
function commandFor(path: string, framework: TestFramework, pkg: PkgInfo | null): { command: string[]; unrunnable: string | null } {
  // Directly-runnable frameworks get per-file argv (finest granularity for
  // change-aware runs). The project script is the fallback for unknown
  // frameworks only — suite scripts often build/lint too, which is not a
  // single test's command.
  switch (framework) {
    case "node:test":
      return { command: ["node", "--test", path], unrunnable: null };
    case "pytest":
      return { command: ["pytest", path], unrunnable: null };
    case "go-test":
      return { command: ["go", "test", "./..."], unrunnable: null };
    case "junit":
      return { command: [], unrunnable: "JUnit needs a build tool (gradle/maven) — run via the project's own wrapper." };
    case "jest":
      return { command: ["npx", "jest", path], unrunnable: null };
    case "vitest":
      return { command: ["npx", "vitest", "run", path], unrunnable: null };
    default: {
      const script = pkg ? preferredScript(pkg.scripts) : null;
      if (script) return { command: script, unrunnable: null };
      return { command: [], unrunnable: `Unknown framework for \`${path}\` — no safe default command.` };
    }
  }
}

function preferredScript(scripts: Record<string, string>): string[] | null {
  for (const name of ["test", "test:unit"]) {
    const cmd = scripts[name];
    if (cmd && !/watch|coverage|e2e|playwright|cypress/i.test(cmd)) {
      // Scripts are maintainer-authored; split on spaces keeps them shell-free.
      // Refs like `npm run build && node --test ...` contain chaining — refuse those.
      if (/[&|;`$]/.test(cmd)) return null;
      return cmd.split(" ").filter(Boolean);
    }
  }
  return null;
}

/** Scan `root` for tests. Deterministic; disclosed caps and gaps. */
export function discoverTests(io: DiscoverIo, root: string): TestDiscovery {
  let listed: string[] | null;
  try {
    listed = io.listFiles(root);
  } catch (err) {
    return { tests: [], root, scannedFiles: 0, truncated: false, frameworks: [], gaps: [`Could not list ${root}: ${(err as Error).message}.`] };
  }
  if (!listed) return { tests: [], root, scannedFiles: 0, truncated: false, frameworks: [], gaps: [`${root} is not a directory.`] };
  const pkg = readPkg(io, root);
  const ts = readTsOutDir(io, root);
  const candidates = listed.filter((p) => !SKIP_RE.test(p) && isTestPath(p));
  const truncated = candidates.length > MAX_SCAN_FILES;
  const tests: DiscoveredTest[] = [];
  const gaps: string[] = [];
  let scanned = 0;
  let mappedCompiled = 0;
  for (const p of candidates.slice(0, MAX_SCAN_FILES)) {
    let raw: string;
    try {
      raw = io.read(p);
    } catch {
      gaps.push(`Unreadable: \`${p}\` — category unknown.`);
      continue;
    }
    if (raw.length > MAX_FILE_BYTES) {
      gaps.push(`Skipped oversized file: \`${p}\`.`);
      continue;
    }
    scanned += 1;
    const { category, layer } = categorize(p, raw);
    const framework = detectFramework(p, raw, pkg);
    const { command, unrunnable } = commandFor(p, framework, pkg);
    const base: DiscoveredTest = { path: p, category, layer, framework, command, unrunnable };
    const { command: finalCommand, mapped } = maybeCompiledCommand(io, root, base, ts);
    if (mapped) mappedCompiled += 1;
    tests.push({ ...base, command: finalCommand });
  }
  // Gap scan: source dirs without any test in scope.
  const sourceDirs = new Set(
    (listed.filter((p) => /\.(ts|tsx|js|jsx|py|java|go)$/.test(p) && !SKIP_RE.test(p) && !isTestPath(p)) ?? [])
      .slice(0, MAX_SCAN_FILES)
      .map((p) => p.split("/").slice(0, -1).join("/") || "(root)"),
  );
  const testDirs = new Set(tests.map((t) => t.path.split("/").slice(0, -1).join("/") || "(root)"));
  for (const d of [...sourceDirs].sort().slice(0, 10)) {
    if (!testDirs.has(d) && ![...testDirs].some((t) => t === `${d}/test` || t === `${d}/tests` || d === `${t}/src` || t.startsWith(`${d}/`))) {
      gaps.push(`No tests discovered near sources in \`${d}\`.`);
    }
  }
  tests.sort((a, b) => a.path.localeCompare(b.path));
  if (mappedCompiled > 0) {
    gaps.unshift(`${mappedCompiled} TypeScript test(s) mapped to compiled output (tsconfig outDir) — run the project's build first, or the run fails on missing modules.`);
  }
  return {
    tests,
    root,
    scannedFiles: scanned,
    truncated,
    frameworks: [...new Set(tests.map((t) => t.framework))].sort(),
    gaps: gaps.slice(0, 20),
  };
}

/** CLI markdown: discovery table with file, category, framework, command. */
export function renderDiscoveryMarkdown(d: TestDiscovery): string {
  const head = `## Test discovery (${d.tests.length} file(s) in ${d.scannedFiles} scanned)`;
  if (d.tests.length === 0) return [head, ``, `No tests discovered under \`${d.root}\`.`, ``, ...d.gaps.map((g) => `- ${g}`), ``].join("\n");
  const rows = d.tests.map((t) => {
    const run = t.command.length ? `\`${t.command.join(" ")}\`` : `— ${t.unrunnable}`;
    return `| \`${t.path}\` | ${t.category} | ${t.layer} | ${t.framework} | ${run} |`;
  });
  return [
    head,
    ``,
    `| File | Category | Layer | Framework | Run |`,
    `| --- | --- | --- | --- | --- |`,
    ...rows,
    ``,
    ...(d.gaps.length ? [`Gaps:`, ...d.gaps.map((g) => `- ${g}`), ``] : []),
    ...(d.truncated ? [`Scan capped — results beyond the cap are unknown.`, ``] : []),
  ].join("\n");
}
