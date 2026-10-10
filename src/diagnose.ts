// Failure diagnosis: a failed TestResult → parsed failure, source links,
// separated confirmed causes from hypotheses, and an optional proposed
// patch. Deterministic core; an LLM pass is available only when explicitly
// requested AND a provider is configured (see diagnoseWithAi). Patches
// apply to production code only with explicit approval — never silently.

import type { TestResult } from "./run.js";

export interface StackFrame {
  path: string;
  line: number | null;
  fn: string | null;
}

export interface FailureLink {
  path: string;
  line: number | null;
  why: string;
}

export interface RootCause {
  statement: string;
  standing: "confirmed" | "hypothesis";
}

export interface ProposedPatch {
  path: string;
  /** Unified-diff text for review. */
  diff: string;
  description: string;
}

export interface Diagnosis {
  testPath: string;
  command: string[];
  exitCode: number | null;
  summary: string;
  assertion: string | null;
  frames: StackFrame[];
  links: FailureLink[];
  causes: RootCause[];
  patch: ProposedPatch | null;
}

const FRAME_RE = /at\s+(?:(\S+)\s+\()?((?:[A-Za-z]:)?[^()\s:]+):(\d+)(?::\d+)?\)?/g;
const ASSERT_RE = /(AssertionError[^:\n]*:? *[^\n]*|Expected[^\n]*|Received[^\n]*|Error: [^\n]+)/;

/** Parse `at fn (path:line:col)` frames, innermost first. */
export function parseFrames(output: string): StackFrame[] {
  const frames: StackFrame[] = [];
  let m: RegExpExecArray | null;
  FRAME_RE.lastIndex = 0;
  while ((m = FRAME_RE.exec(output)) !== null) {
    const raw = m[2] ?? "";
    if (/^node:/.test(raw) || raw.includes("node:internal")) continue;
    frames.push({ path: raw, line: m[3] ? parseInt(m[3], 10) : null, fn: m[1] ?? null });
    if (frames.length >= 10) break;
  }
  return frames;
}

function firstAssertion(output: string): string | null {
  const m = ASSERT_RE.exec(output);
  return m ? m[1].trim().slice(0, 300) : null;
}

/** Symbol under test in a failing assertion: `() => totalFor(` → totalFor. */
function callTargetOf(output: string, testSource: string | null): string | null {
  // Prefer the actual test source (injected); fall back to output text.
  for (const src of [testSource ?? "", output]) {
    const m = /assert\.(?:throws|doesNotThrow|rejects|doesNotReject)\(\(\)\s*=>\s*([A-Za-z_$][\w$]*)\s*\(/.exec(src);
    if (m) return m[1] as string;
  }
  return null;
}

function sameFile(a: string, b: string): boolean {
  return a === b || a.endsWith(`/${b}`) || b.endsWith(`/${a}`);
}

/**
 * Diagnose one failed result against the change under review.
 * `readFile` resolves frame paths for excerpts (null-safe). When `symbols`
 * are supplied, a failing assertion that calls a changed symbol links the
 * symbol's declaration — an evidence-backed connection even when the
 * process stack never entered the source (e.g. expected-throw never
 * thrown).
 */
export function diagnoseFailure(
  result: TestResult,
  opts: { changedFiles?: string[]; symbols?: Array<{ name: string; file: string; line: number | null }>; readFile?: (path: string) => string | null; removedGuard?: { path: string; lines: string[] } | null } = {},
): Diagnosis {
  const changed = opts.changedFiles ?? [];
  const frames = result.status === "failed" ? parseFrames(result.output) : [];
  const assertion = result.status === "failed" ? firstAssertion(result.output) : null;
  const links: FailureLink[] = [];
  for (const f of frames.slice(0, 5)) {
    const hit = changed.find((c) => sameFile(c, f.path));
    links.push({
      path: f.path,
      line: f.line,
      why: hit
        ? `Stack frame inside changed file \`${hit}\` — the failure plausibly comes from this change (confirmed location, not confirmed cause).`
        : `Stack frame in \`${f.path}\` (unchanged in this diff).`,
    });
  }
  const causes: RootCause[] = [];
  const changedFrame = frames.find((f) => changed.some((c) => sameFile(c, f.path)));
  let testSource: string | null = null;
  if (opts.readFile) {
    try {
      testSource = opts.readFile(result.path);
    } catch {
      testSource = null;
    }
  }
  // Assertion calls a changed symbol: `assert.throws(() => totalFor(...))`
  // with totalFor changed → the failure involves the change (confirmed
  // location; the mechanism stays under investigation).
  const called = callTargetOf(result.output, testSource);
  const changedSymbol = called ? (opts.symbols ?? []).find((s) => s.name === called && changed.some((c) => sameFile(c, s.file))) : undefined;
  if (changedSymbol) {
    links.unshift({
      path: changedSymbol.file,
      line: changedSymbol.line,
      why: `Failing assertion calls changed symbol \`${called}\` — the test exercises this change directly.`,
    });
  }
  if (result.status !== "failed") {
    causes.push({ statement: `Test did not fail (${result.status}): ${result.detail}`, standing: "confirmed" });
  } else if (changedFrame || changedSymbol) {
    const where = changedFrame
      ? `\`${changedFrame.path}${changedFrame.line ? `:${changedFrame.line}` : ""}\``
      : `changed symbol \`${changedSymbol?.name}\` in \`${changedSymbol?.file}\``;
    causes.push({
      statement: `Failure involves the change (${where})${assertion ? ` with: ${assertion}` : ""}. Prime suspect — verify by reading the linked code.`,
      standing: "confirmed",
    });
  } else if (frames.length > 0) {
    causes.push({
      statement: `No stack frame lands in the changed files; the failure may be pre-existing, environmental, or indirect. Do not blame the change without more evidence.`,
      standing: "hypothesis",
    });
  } else {
    causes.push({
      statement: `No parseable stack frames in the output — cause unknown. Read the full log.`,
      standing: "hypothesis",
    });
  }

  // Recognized pattern with a safe mechanical fix: a guard clause the diff
  // removed while a test still expects the throw. Propose re-adding the
  // exact removed lines — nothing invented.
  let patch: ProposedPatch | null = null;
  const g = opts.removedGuard;
  if (g && result.status === "failed" && /throw|throws/i.test(result.output)) {
    const body = g.lines.map((l) => `+${l}`).join("\n");
    patch = {
      path: g.path,
      diff: `--- a/${g.path}\n+++ b/${g.path}\n${body}`,
      description: `Re-add the removed guard in \`${g.path}\` (exact lines from the analyzed diff). Review, then apply explicitly.`,
    };
  }
  return {
    testPath: result.path,
    command: result.command,
    exitCode: result.exitCode,
    summary: assertion ?? result.detail,
    assertion,
    frames,
    links,
    causes,
    patch,
  };
}

export interface PatchIo {
  read: (path: string) => string;
  write: (path: string, content: string) => void;
}

/**
 * Approval gate: refuses unless opts.approve === true. Applies the
 * proposed guard lines idempotently (skips lines already present) and
 * reports what changed. Production code is never touched implicitly.
 */
export function applyProposedPatch(
  patch: ProposedPatch,
  guardLines: string[],
  io: PatchIo,
  opts: { approve: boolean },
): { applied: boolean; path: string; detail: string } {
  if (!opts.approve) {
    return { applied: false, path: patch.path, detail: "Refused: approval required (pass approve:true explicitly). Production code untouched." };
  }
  let content: string;
  try {
    content = io.read(patch.path);
  } catch (err) {
    return { applied: false, path: patch.path, detail: `Refused: cannot read ${patch.path}: ${(err as Error).message}` };
  }
  const missing = guardLines.filter((l) => !content.includes(l.trim()) && l.trim());
  if (missing.length === 0) {
    return { applied: true, path: patch.path, detail: "No-op: guard lines already present — nothing changed." };
  }
  // Deterministic placement: re-insert before the first line that throws,
  // else prepend. Minimal, reviewable, no reformat.
  const lines = content.split("\n");
  const at = lines.findIndex((l) => /\bthrow\b/.test(l));
  const insert = at >= 0 ? at : 0;
  lines.splice(insert, 0, ...missing);
  try {
    io.write(patch.path, lines.join("\n"));
  } catch (err) {
    return { applied: false, path: patch.path, detail: `Write failed: ${(err as Error).message}` };
  }
  return { applied: true, path: patch.path, detail: `Inserted ${missing.length} guard line(s) at line ${insert + 1} of ${patch.path}. Re-run affected tests.` };
}

/** CLI markdown: failure, frames with links, causes, proposed patch. */
export function renderDiagnosisMarkdown(d: Diagnosis): string {
  const frames = d.frames.slice(0, 5).map((f) => `- \`${f.path}${f.line ? `:${f.line}` : ""}\`${f.fn ? ` — ${f.fn}` : ""}`).join("\n") || `- (no frames parsed)`;
  const causes = d.causes.map((c) => `- [${c.standing}] ${c.statement}`).join("\n");
  return [
    `### Diagnosis — \`${d.testPath}\` (exit ${d.exitCode ?? "—"})`,
    ``,
    `Failure: ${d.summary}`,
    ``,
    `Stack (innermost first):`,
    frames,
    ``,
    ...d.links.map((l) => `- \`${l.path}${l.line ? `:${l.line}` : ""}\` — ${l.why}`),
    ``,
    `Possible causes:`,
    causes,
    ``,
    d.patch ? `Proposed patch (NOT applied — requires approval):\n\n\`\`\`diff\n${d.patch.diff}\n\`\`\`\n\n${d.patch.description}\n` : `No mechanical patch recognized — fix must be human-authored.\n`,
  ].join("\n");
}
