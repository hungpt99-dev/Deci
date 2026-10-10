// Real test execution. Thin I/O boundary over the project's own tools:
// argv are spawned shell-free, each run is time-boxed, secrets are
// redacted from captured output, and every result is stamped with the
// source revision it ran against. Success is never reported without an
// exit code from an actual process.
//
// Isolation model (disclosed, not oversold): same-user process isolation
// with cwd confinement, per-run timeouts, sequential-by-default runs, and
// no shell. This is NOT container sandboxing — generated code runs with
// your user privileges; review it first (see generate.ts approval gate).

import { spawnSync } from "node:child_process";
import { redactSecrets } from "./providers.js";
import type { SelectedTest } from "./select.js";

export { redactSecrets };

export type TestStatus = "passed" | "failed" | "skipped" | "blocked" | "unexecuted";

export interface TestResult {
  path: string;
  command: string[];
  status: TestStatus;
  /** Process exit code; null when no process ran. */
  exitCode: number | null;
  /** Capped, secret-redacted combined output. Empty unless failed/blocked. */
  output: string;
  durationMs: number;
  /** Source revision the test ran against (sha, label, or unknown). */
  revision: string;
  detail: string;
}

export interface RunOptions {
  /** Directory commands run in (confined; defaults to process.cwd()). */
  cwd?: string;
  /** Per-test wall-clock budget. Default 120s. */
  timeoutMs?: number;
  /** Abort between tests (in-test abort relies on the timeout). */
  signal?: AbortSignal;
  /** Revision label stamped on every result. */
  revision?: string;
  /** Extra env merged over process.env (never logged). */
  env?: Record<string, string>;
}

const MAX_OUTPUT_CHARS = 6000;
const DEFAULT_TIMEOUT_MS = 120_000;

export interface SpawnFn {
  (command: string[], opts: { cwd: string; timeoutMs: number; env: Record<string, string> }): {
    exitCode: number | null;
    output: string;
    timedOut: boolean;
  };
}

/** Default spawner: shell-free spawnSync with timeout. No shell, no chaining. */
export const defaultSpawn: SpawnFn = (command, opts) => {
  const [bin, ...args] = command;
  // A child `node --test` run inherits this process's runner context
  // (NODE_TEST_CONTEXT) and then REFUSES to run any files — exiting 0 with
  // no tests executed. That would report false passes whenever Deci itself
  // runs under a test runner, so the marker is always scrubbed.
  const { NODE_TEST_CONTEXT: _drop, ...env } = opts.env;
  void _drop;
  try {
    const r = spawnSync(bin as string, args, {
      cwd: opts.cwd,
      env,
      timeout: opts.timeoutMs,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    });
    const output = `${r.stdout ?? ""}\n${r.stderr ?? ""}`.trim();
    return { exitCode: r.status, output, timedOut: false };
  } catch (err) {
    const msg = (err as Error).message ?? String(err);
    if (/ETIMEDOUT|timed out/i.test(msg)) return { exitCode: null, output: `Timed out after ${opts.timeoutMs}ms.`, timedOut: true };
    throw err;
  }
};

/** Execute selected tests sequentially. Never throws for test outcomes. */
export async function runTests(
  tests: SelectedTest[],
  opts: RunOptions & { spawn?: SpawnFn } = {},
): Promise<TestResult[]> {
  const cwd = opts.cwd ?? process.cwd();
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const revision = opts.revision ?? "unknown";
  const env = { ...process.env, ...(opts.env ?? {}) } as Record<string, string>;
  const results: TestResult[] = [];
  for (const t of tests) {
    if (opts.signal?.aborted) {
      results.push({
        path: t.path, command: t.command, status: "unexecuted", exitCode: null,
        output: "", durationMs: 0, revision, detail: "Cancelled before start.",
      });
      continue;
    }
    if (t.command.length === 0) {
      results.push({
        path: t.path, command: t.command, status: "blocked", exitCode: null,
        output: "", durationMs: 0, revision, detail: t.unrunnable ?? "No runnable command.",
      });
      continue;
    }
    const t0 = Date.now();
    let raw: { exitCode: number | null; output: string; timedOut: boolean };
    try {
      raw = (opts.spawn ?? defaultSpawn)(t.command, { cwd, timeoutMs, env });
    } catch (err) {
      const msg = (err as Error).message ?? String(err);
      const missing = /ENOENT|not found|exit code 127/i.test(msg);
      results.push({
        path: t.path, command: t.command, status: missing ? "skipped" : "blocked", exitCode: null,
        output: redactSecrets(msg).slice(0, MAX_OUTPUT_CHARS), durationMs: Date.now() - t0,
        revision, detail: missing ? `Toolchain missing — skipped, not verified.` : `Runner error: ${msg.slice(0, 200)}`,
      });
      continue;
    }
    const durationMs = Date.now() - t0;
    if (raw.timedOut) {
      results.push({
        path: t.path, command: t.command, status: "failed", exitCode: null,
        output: raw.output, durationMs, revision, detail: `Timed out after ${timeoutMs}ms — treated as failure, not success.`,
      });
    } else if (raw.exitCode === 0) {
      results.push({
        path: t.path, command: t.command, status: "passed", exitCode: 0,
        output: "", durationMs, revision, detail: `\`${t.command.join(" ")}\` exited 0 in ${durationMs}ms.`,
      });
    } else {
      results.push({
        path: t.path, command: t.command, status: "failed", exitCode: raw.exitCode,
        output: redactSecrets(raw.output).slice(-MAX_OUTPUT_CHARS), durationMs, revision,
        detail: `\`${t.command.join(" ")}\` exited ${raw.exitCode} in ${durationMs}ms.`,
      });
    }
  }
  return results;
}

/** Passed/failed/skipped/blocked/unexecuted counts — only from executed evidence. */
export function summarizeResults(results: TestResult[]): { passed: number; failed: number; skipped: number; blocked: number; unexecuted: number } {
  const s = { passed: 0, failed: 0, skipped: 0, blocked: 0, unexecuted: 0 };
  for (const r of results) s[r.status] += 1;
  return s;
}

/** CLI markdown: one row per result, full logs only for failures. */
export function renderResultsMarkdown(results: TestResult[]): string {
  if (results.length === 0) return `## Test results\n\nNo tests ran.\n`;
  const icon = { passed: "✓", failed: "✗", skipped: "○", blocked: "!", unexecuted: "–" } as const;
  const rows = results.map((r) => `| \`${r.path}\` | ${icon[r.status]} ${r.status} | ${r.exitCode ?? "—"} | ${r.durationMs}ms | ${r.detail} |`).join("\n");
  const logs = results
    .filter((r) => r.status === "failed" && r.output)
    .map((r) => `<details><summary>log: \`${r.path}\` (exit ${r.exitCode})</summary>\n\n\`\`\`\n${r.output}\n\`\`\`\n</details>`)
    .join("\n");
  const s = summarizeResults(results);
  return [
    `## Test results (${results.length}: ${s.passed} passed, ${s.failed} failed, ${s.skipped} skipped, ${s.blocked} blocked, ${s.unexecuted} unexecuted)`,
    ``,
    `| Test | Result | Exit | Duration | Detail |`,
    `| --- | --- | --- | --- | --- |`,
    rows,
    ``,
    logs,
    ``,
  ].join("\n");
}
