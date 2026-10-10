// US-003: Auto-verification. Static checks pure/local; command checks run per
// language via injectable exec (tests stub it, CLI uses real shell).
// Verified Low-risk files collapse into the Review Map "Verified" bucket but
// stay listed in an expandable <details> section — never silently dropped.

import { execFileSync } from "node:child_process";
import { classifyRisk, parseUnifiedDiff, type ReviewMap } from "./reviewMap.js";

export type VerifyStatus = "pass" | "fail" | "skip";

export type VerifyCheckId =
  | "typescript-build"
  | "typescript-unit-tests"
  | "typescript-lint"
  | "typescript-format"
  | "java-build"
  | "java-unit-tests"
  | "java-lint"
  | "java-format"
  | "api-schema"
  | "forbidden-deps";

export interface VerifyCheckSpec {
  id: VerifyCheckId;
  label: string;
  command: string | null; // null = pure static check, no shell needed
}

export interface VerifyCheckResult extends VerifyCheckSpec {
  status: VerifyStatus;
  detail: string;
  /** Stable anchor for the failure log; CLI prints it, webview links it. */
  logRef: string | null;
  output: string;
}

export interface VerifyReport {
  checks: VerifyCheckResult[];
  passed: number;
  failed: number;
  skipped: number;
  allPass: boolean;
  /** Low-risk paths covered when allPass; empty otherwise. Expandable, not dropped. */
  verifiedPaths: string[];
  generatedAt: string;
}

export type ExecFn = (cmd: string) => { exitCode: number; output: string };

const MAX_LOG_CHARS = 2000;
const CMD_TIMEOUT_MS = 120_000;

const TS_COMMANDS: Array<[VerifyCheckId, string, string]> = [
  ["typescript-build", "build (typescript)", "npx tsc --noEmit"],
  ["typescript-unit-tests", "unit tests (typescript)", "npm test"],
  ["typescript-lint", "lint (typescript)", "npx eslint ."],
  ["typescript-format", "format (typescript)", "npx prettier --check ."],
];

const JAVA_COMMANDS: Array<[VerifyCheckId, string, string]> = [
  ["java-build", "build (java)", "./gradlew build -x test"],
  ["java-unit-tests", "unit tests (java)", "./gradlew test"],
  ["java-lint", "lint (java)", "./gradlew check"],
  ["java-format", "format (java)", "./gradlew spotlessCheck"],
];

const isTs = (p: string) => /\.(ts|tsx|mts|cts|js|jsx)$/i.test(p);
const isJava = (p: string) => /\.java$/i.test(p) || /(^|\/)(pom\.xml|build\.gradle(\.kts)?)$/i.test(p);

const CONTRACT_RE = /\.proto$|openapi|swagger|schema\.(graphql|json)$|\.graphql$/i;

/** ponytail: substring deny-list; full SCA/SBOM out of MVP scope. */
export const DEFAULT_FORBIDDEN_DEPS = ["event-stream", "node-ipc", "left-pad", "faker"];

const DEP_ADD_RE = /import\s|require\(|from\s+['"]|implementation\(|api\(|<dependency>|"\w[\w@/-]*"\s*:\s*["'^~]/i;

/** Pure: which shell checks apply to this change. Static checks always run. */
export function planChecks(changedPaths: string[]): VerifyCheckSpec[] {
  const specs: VerifyCheckSpec[] = [];
  if (changedPaths.some(isTs))
    for (const [id, label, command] of TS_COMMANDS) specs.push({ id, label, command });
  if (changedPaths.some(isJava))
    for (const [id, label, command] of JAVA_COMMANDS) specs.push({ id, label, command });
  return specs;
}

/** Pure: fail when the diff touches API contract surface. */
export function checkApiSchemaUnchanged(diffText: string): VerifyCheckResult {
  const paths = changedPathsOf(diffText);
  const touched = [...new Set(paths.filter((p) => CONTRACT_RE.test(p)))].sort();
  return touched.length === 0
    ? {
        id: "api-schema",
        label: "api schema unchanged",
        command: null,
        status: "pass",
        detail: "No contract surface touched.",
        logRef: null,
        output: "",
      }
    : {
        id: "api-schema",
        label: "api schema unchanged",
        command: null,
        status: "fail",
        detail: `Contract surface changed: ${touched.join(", ")} — needs human review.`,
        logRef: "verify-logs/api-schema.log",
        output: touched.join("\n").slice(0, MAX_LOG_CHARS),
      };
}

/** Pure: fail when added lines pull in a forbidden dependency. */
export function checkForbiddenDeps(
  diffText: string,
  forbidden: string[] = DEFAULT_FORBIDDEN_DEPS,
): VerifyCheckResult {
  const hits: string[] = [];
  for (const line of diffText.split("\n")) {
    if (!line.startsWith("+") || line.startsWith("+++")) continue;
    if (!DEP_ADD_RE.test(line)) continue;
    const lower = line.toLowerCase();
    for (const dep of forbidden) {
      if (lower.includes(dep.toLowerCase())) hits.push(`${dep} ← ${line.slice(1).trim().slice(0, 120)}`);
    }
  }
  const unique = [...new Set(hits)];
  return unique.length === 0
    ? {
        id: "forbidden-deps",
        label: "forbidden dependencies",
        command: null,
        status: "pass",
        detail: "No forbidden dependency introduced.",
        logRef: null,
        output: "",
      }
    : {
        id: "forbidden-deps",
        label: "forbidden dependencies",
        command: null,
        status: "fail",
        detail: `Forbidden dependency introduced: ${unique.join("; ")}.`,
        logRef: "verify-logs/forbidden-deps.log",
        output: unique.join("\n").slice(0, MAX_LOG_CHARS),
      };
}

function changedPathsOf(diffText: string): string[] {
  try {
    return parseUnifiedDiff(diffText).map((f) => f.path);
  } catch {
    return [];
  }
}

function toSkip(spec: VerifyCheckSpec, detail: string): VerifyCheckResult {
  return { ...spec, status: "skip", detail, logRef: null, output: "" };
}

/** I/O boundary: run shell specs. Missing toolchain → skip, never fail. */
export function runCommandChecks(specs: VerifyCheckSpec[], exec: ExecFn): VerifyCheckResult[] {
  return specs.map((spec) => {
    if (!spec.command) throw new Error(`runCommandChecks got static check ${spec.id}`);
    let raw: { exitCode: number; output: string };
    try {
      raw = exec(spec.command);
    } catch (err) {
      const msg = (err as Error).message ?? String(err);
      if (/ENOENT|not found|not recognized|exit code 127/i.test(msg))
        return toSkip(spec, `Toolchain missing for \`${spec.command}\` — skipped, not verified.`);
      return {
        ...spec,
        status: "fail",
        detail: `Runner error: ${msg.slice(0, 200)}`,
        logRef: `verify-logs/${spec.id}.log`,
        output: msg.slice(0, MAX_LOG_CHARS),
      };
    }
    if (raw.exitCode === 0)
      return { ...spec, status: "pass", detail: `\`${spec.command}\` green.`, logRef: null, output: "" };
    return {
      ...spec,
      status: "fail",
      detail: `\`${spec.command}\` exited ${raw.exitCode}.`,
      logRef: `verify-logs/${spec.id}.log`,
      output: raw.output.slice(0, MAX_LOG_CHARS),
    };
  });
}

/**
 * Shell-free runner for the fixed allowlisted check commands above.
 * No user input ever reaches these commands, and splitting on spaces
 * (they contain no quoting) keeps execution out of a shell entirely.
 */
export const defaultExec: ExecFn = (cmd: string) => {
  const [bin, ...args] = cmd.split(" ").filter(Boolean);
  try {
    const out = execFileSync(bin as string, args, {
      encoding: "utf8",
      timeout: CMD_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { exitCode: 0, output: (out as string).slice(-MAX_LOG_CHARS) };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string; message?: string };
    if (e.status === undefined && /ENOENT/.test(e.message ?? "")) throw err;
    const output = `${e.stdout ?? ""}\n${e.stderr ?? ""}`.trim() || (e.message ?? "unknown error");
    throw Object.assign(new Error(output.slice(0, 500)), {
      status: e.status,
      message: `exit code ${e.status ?? "?"}: ${output.slice(0, 500)}`,
    });
  }
};

export interface FullVerifyOptions {
  forbidden?: string[];
  exec?: ExecFn;
  /** False keeps shell specs as skip (fast/static-only, e.g. VS Code webview). */
  runCommands?: boolean;
}

/** Full verify: static checks always run; shell checks run or skip per opts. */
export function runFullVerify(
  diffText: string,
  opts: FullVerifyOptions = {},
  exec: ExecFn = defaultExec,
): VerifyReport {
  const paths = changedPathsOf(diffText);
  const staticChecks = [checkApiSchemaUnchanged(diffText), checkForbiddenDeps(diffText, opts.forbidden)];
  const specs = planChecks(paths);
  const runExec = opts.exec ?? exec;
  const commandChecks =
    opts.runCommands === false
      ? specs.map((s) => toSkip(s, "Deferred in this surface — run CLI `analyze --verify` for shell checks."))
      : runCommandChecks(specs, runExec);
  const checks = [...staticChecks, ...commandChecks];
  const passed = checks.filter((c) => c.status === "pass").length;
  const failed = checks.filter((c) => c.status === "fail").length;
  const skipped = checks.filter((c) => c.status === "skip").length;
  const allPass = failed === 0;
  const verifiedPaths =
    allPass && diffText.trim()
      ? [...new Set(paths.filter((p) => classifyRisk(p) === "Low"))].sort()
      : [];
  return { checks, passed, failed, skipped, allPass, verifiedPaths, generatedAt: new Date().toISOString() };
}

/** Pure: move verified paths into the Review Map Verified bucket. */
export function applyVerification(map: ReviewMap, verifiedPaths: string[]): ReviewMap {
  const verified = new Set(verifiedPaths);
  const files = map.files.map((f) => (verified.has(f.path) ? { ...f, risk: "Verified" as const } : f));
  const riskDistribution = {
    Critical: { files: 0, loc: 0 },
    High: { files: 0, loc: 0 },
    Medium: { files: 0, loc: 0 },
    Low: { files: 0, loc: 0 },
    Verified: { files: 0, loc: 0 },
  } satisfies ReviewMap["riskDistribution"];
  for (const f of files) {
    riskDistribution[f.risk].files += 1;
    riskDistribution[f.risk].loc += f.added + f.removed;
  }
  return { ...map, files, riskDistribution };
}

const ICON: Record<VerifyStatus, string> = { pass: "✓", fail: "✗", skip: "○" };

/** Markdown with ✓/✗ per check, log links on failure, expandable verified list. */
export function renderVerifyMarkdown(report: VerifyReport): string {
  const head = report.allPass
    ? `All ${report.checks.length} checks green — ${report.verifiedPaths.length} Low-risk file(s) auto-verified.`
    : `${report.failed} check(s) failing — affected code stays in human review.`;
  const rows = report.checks
    .map((c) => {
      const log = c.status === "fail" && c.logRef ? ` ([log](${c.logRef}))` : "";
      return `| ${c.label} | ${ICON[c.status]} ${c.status} | ${c.detail}${log} |`;
    })
    .join("\n");
  const logs = report.checks
    .filter((c) => c.status === "fail" && c.output)
    .map((c) => `<details><summary>log: ${c.label}</summary>\n\n\`\`\`\n${c.output}\n\`\`\`\n</details>`)
    .join("\n");
  const collapsed = report.verifiedPaths.length
    ? `<details><summary>Verified files (${report.verifiedPaths.length}) — expand</summary>\n\n${report.verifiedPaths.map((p) => `- \`${p}\``).join("\n")}\n</details>`
    : `No files auto-verified.`;
  return [
    `## Verification`,
    ``,
    head,
    ``,
    `| Check | Result | Detail |`,
    `| --- | --- | --- |`,
    rows || `| (no checks) | ○ skip | Empty diff — nothing to verify. |`,
    ``,
    logs,
    collapsed,
    ``,
  ].join("\n");
}
