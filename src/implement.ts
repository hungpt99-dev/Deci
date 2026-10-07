// US-007: AI implementation applies chosen patch and re-verifies.
// Pure core + injectable I/O. MVP ships the Local Agent Adapter only:
// any non-"local" adapter id throws. Flow: plan (US-006) → generatePatch
// preview → applyPatch via adapter → runFullVerify → requeueAffected.
// VS Code/CLI are thin adapters; CLI stays analyze-only (no implement).

import {
  planForAlternative,
  type AlternativeSet,
  type ImplementationPlan,
} from "./alternatives.js";
import { guessTestPath, type DecisionPoint } from "./decisions.js";
import { runFullVerify, type FullVerifyOptions, type VerifyReport } from "./verify.js";

export interface PatchFile {
  file: string;
  action: string;
  /** Deterministic placeholder body the local adapter would write. */
  content: string;
  /** Unified-diff-style preview for the plan preview panel. */
  diffPreview: string;
}

export interface AppliedPatch {
  decisionId: string;
  alternativeId: string;
  label: string;
  title: string;
  locAdded: number;
  locRemoved: number;
  files: PatchFile[];
  patchText: string;
  appliedAt: string;
}

/** Minimal file-system seam so tests use memory, VS Code/CLI inject real fs. */
export interface PatchFs {
  readFile: (path: string) => string | null;
  writeFile: (path: string, content: string) => void;
}

/** In-memory PatchFs for tests and dry runs. */
export function memFs(initial: Record<string, string> = {}): PatchFs & { store: Map<string, string> } {
  const store = new Map(Object.entries(initial));
  return {
    store,
    readFile: (p) => (store.has(p) ? (store.get(p) as string) : null),
    writeFile: (p, c) => {
      store.set(p, c);
    },
  };
}

/**
 * Agent adapter surface (inspect/plan/implement/test/explain). MVP ships
 * only `local`; requireLocalAdapter throws for anything else so a future
 * cloud agent cannot slip in silently.
 */
export interface AgentAdapter {
  id: string;
  inspect: (plan: ImplementationPlan) => string;
  implement: (plan: ImplementationPlan, fs: PatchFs) => AppliedPatch;
  test: (patch: AppliedPatch) => string;
  explain: (patch: AppliedPatch) => string;
}

function patchContentFor(plan: ImplementationPlan, file: string, action: string): string {
  const note = `// Deci(local): ${action} "${plan.title}" for ${plan.decisionId} [${plan.label}]`;
  if (action === "update-tests")
    return `${note}\n// covers new behavior + regression for the old path\n`;
  if (action === "verify") return "";
  return `${note}\n// TODO(local): human confirms semantics; adapter only scaffolds the step\n`;
}

function diffPreviewFor(file: string, content: string): string {
  if (!content) return `--- a/${file}\n+++ b/${file}\n@@ verify step, no file write @@`;
  const body = content
    .split("\n")
    .filter(Boolean)
    .map((l) => `+${l}`)
    .join("\n");
  return `--- a/${file}\n+++ b/${file}\n${body}`;
}

/** Pure: picked plan → per-file patch preview with +/-LOC from the plan. */
export function generatePatch(plan: ImplementationPlan): AppliedPatch {
  const files: PatchFile[] = plan.steps.map((s) => {
    const content = patchContentFor(plan, s.file, s.action);
    return { file: s.file, action: s.action, content, diffPreview: diffPreviewFor(s.file, content) };
  });
  return {
    decisionId: plan.decisionId,
    alternativeId: plan.alternativeId,
    label: plan.label,
    title: plan.title,
    locAdded: plan.locAdded,
    locRemoved: plan.locRemoved,
    files,
    patchText: files.map((f) => f.diffPreview).join("\n"),
    appliedAt: "",
  };
}

/**
 * I/O boundary: write patch bodies via injected fs (creates or appends with
 * a marker; never deletes). Verify steps write nothing. Immutable result.
 */
export function applyPatch(plan: ImplementationPlan, fs: PatchFs): AppliedPatch {
  const patch = generatePatch(plan);
  for (const f of patch.files) {
    if (!f.content) continue; // verify step: no file write
    const prev = safeRead(fs, f.file);
    fs.writeFile(f.file, prev === null ? f.content : `${prev.replace(/\s+$/, "")}\n${f.content}`);
  }
  return { ...patch, appliedAt: new Date().toISOString() };
}

function safeRead(fs: PatchFs, path: string): string | null {
  try {
    return fs.readFile(path);
  } catch {
    return null;
  }
}

export const localAgentAdapter: AgentAdapter = {
  id: "local",
  inspect: (plan) =>
    `Local inspect: ${plan.steps.length} step(s) for ${plan.decisionId} → ${plan.title} (+${plan.locAdded}/−${plan.locRemoved} LOC). No code leaves the machine.`,
  implement: (plan, fs) => applyPatch(plan, fs),
  test: (patch) => `Local test hook: re-run full verify for ${patch.decisionId}; adapter runs no remote tests.`,
  explain: (patch) =>
    `Local explain: applied Option ${patch.label} "${patch.title}" to ${patch.files.map((f) => `\`${f.file}\``).join(", ")}.`,
};

/** MVP gate: only the local adapter may implement. Throws otherwise. */
export function requireLocalAdapter(adapterId: string): void {
  if (adapterId !== "local") throw new Error(`MVP supports Local Agent Adapter only (got "${adapterId}")`);
}

/** Full re-verify after apply. Thin wrapper so US-007 callers share one seam. */
export function reverifyAfterApply(newDiffText: string, opts: FullVerifyOptions = {}): VerifyReport {
  return runFullVerify(newDiffText, opts);
}

/**
 * Pure: only decisions touching re-verified files go back to pending.
 * A decision is affected when its file (or its sibling test path) is in
 * `touchedFiles`. Unaffected decisions keep status verbatim; affected ones
 * reset to pending with decidedAt cleared (reason/constraint retained).
 */
export function requeueAffected(queue: DecisionPoint[], touchedFiles: string[]): DecisionPoint[] {
  const touched = new Set(touchedFiles);
  return queue.map((d) =>
    touched.has(d.file) || touched.has(guessTestPath(d.file))
      ? { ...d, status: "pending" as const, decidedAt: undefined }
      : d,
  );
}

export interface ImplementResult {
  patch: AppliedPatch;
  report: VerifyReport;
  requeued: DecisionPoint[];
  requeuedCount: number;
}

/**
 * One-shot US-007 loop: apply picked (or first) alternative via the local
 * adapter → full re-verify on the post-apply diff → re-queue affected only.
 * Throws for non-local adapters before touching fs.
 */
export function implementAndReverify(
  set: AlternativeSet,
  queue: DecisionPoint[],
  fs: PatchFs,
  postApplyDiff: string,
  opts: { adapterId?: string; alternativeId?: string; verify?: FullVerifyOptions } = {},
): ImplementResult {
  requireLocalAdapter(opts.adapterId ?? "local");
  const plan = planForAlternative(set, opts.alternativeId ?? set.pickedId ?? undefined);
  const patch = localAgentAdapter.implement(plan, fs);
  const report = reverifyAfterApply(postApplyDiff, opts.verify ?? { runCommands: false });
  const touched = [...new Set(patch.files.map((f) => f.file).filter((f) => f))];
  const requeued = requeueAffected(queue, touched);
  const requeuedCount = requeued.filter(
    (d, i) => d.status === "pending" && queue[i]?.status !== "pending",
  ).length;
  return { patch, report, requeued, requeuedCount };
}

/** Plan preview + patch diff + verify note + requeue note. Pure markdown. */
export function renderPatchMarkdown(patch: AppliedPatch): string {
  const rows = patch.files
    .map((f) => `| \`${f.file}\` | ${f.action} | ${f.content ? `${f.content.split("\n").filter(Boolean).length} line(s)` : "no write"} |`)
    .join("\n");
  return [
    `## Generate patch — Option ${patch.label}: ${patch.title}`,
    ``,
    `Decision: ${patch.decisionId} · Estimate: +${patch.locAdded}/−${patch.locRemoved} LOC · Adapter: local only`,
    ``,
    `| File | Action | Effect |`,
    `| --- | --- | --- |`,
    rows,
    ``,
    `<details><summary>Patch preview (unified diff)</summary>`,
    ``,
    "```diff",
    patch.patchText || "(no file writes — verify-only plan)",
    "```",
    `</details>`,
    ``,
  ].join("\n");
}

/** Result bundle markdown: patch + re-verify outcome + requeue scope. */
export function renderImplementResultMarkdown(result: ImplementResult): string {
  const r = result.report;
  const head = r.allPass
    ? `Re-verify green (${r.passed} pass, ${r.skipped} skip) — only affected decisions re-queued.`
    : `Re-verify: ${r.failed} failing — affected decisions stay in human review.`;
  return [
    renderPatchMarkdown(result.patch),
    `Re-verify: ${head}`,
    ``,
    `Re-queued: ${result.requeuedCount} decision(s) touching ${[...new Set(result.patch.files.map((f) => f.file))].map((f) => `\`${f}\``).join(", ") || "(none)"}. Unaffected decisions keep their status.`,
    ``,
  ].join("\n");
}
