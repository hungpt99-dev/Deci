// Context assembly: gathers project-aware context for chat.
// Pure core with injected I/O; VS Code/CLI inject real fs/git.
import type { ApiContractSymbol, ChatContextBundle, ContextFlags, DocExcerpt } from "./chat.js";
import { parseUnifiedDiff } from "./reviewMap.js";
import { parseFileHunks } from "./semantic.js";
import { symbolsForHunks } from "./symbols.js";
import { buildImpactMap } from "./impact.js";
import { discoverTests } from "./discover.js";
import { selectTests } from "./select.js";

export interface ContextIo {
  workspaceRoot: string;
  activeFile?: string;
  selection?: { startLine: number; endLine: number };
  readFile(path: string): Promise<string | null>;
  exists(path: string): Promise<boolean>;
  listFiles(root: string): Promise<string[] | null>;
  git(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }>;
  exec(cmd: string, args: string[], opts?: { cwd?: string; timeoutMs?: number }): Promise<{ stdout: string; stderr: string; exitCode: number }>;
}

const MAX_ACTIVE_FILE_CHARS = 8000;
const MAX_DIFF_CHARS = 12000;
const MAX_DOC_CHARS = 4000;

/** Assemble context bundle based on flags. Never throws; reports missing sections. */
export async function assembleContext(
  flags: ContextFlags,
  io: ContextIo,
): Promise<{ bundle: ChatContextBundle; missing: string[] }> {
  const missing: string[] = [];
  const bundle: ChatContextBundle = { workspaceRoot: io.workspaceRoot };

  if (flags.activeFile && io.activeFile) {
    try {
      const content = await io.readFile(io.activeFile);
      if (content) {
        let excerpt = content;
        if (io.selection) {
          const lines = content.split("\n");
          const start = Math.max(0, io.selection.startLine - 1);
          const end = Math.min(lines.length, io.selection.endLine);
          excerpt = lines.slice(start, end).join("\n");
        }
        if (excerpt.length > MAX_ACTIVE_FILE_CHARS) excerpt = `${excerpt.slice(0, MAX_ACTIVE_FILE_CHARS)}\n…(truncated)`;
        bundle.activeFile = io.activeFile;
        bundle.selection = io.selection;
        bundle.activeFileExcerpt = excerpt;
      }
    } catch {
      missing.push("activeFile");
    }
  }

  if (flags.diff) {
    try {
      const wt = await io.git(["diff", "HEAD", "--"]);
      let diff = wt.exitCode === 0 ? wt.stdout : "";
      if (!diff.trim()) {
        const staged = await io.git(["diff", "--staged", "--"]);
        if (staged.exitCode === 0) diff = staged.stdout;
      }
      if (diff.trim()) {
        bundle.diff = diff.length > MAX_DIFF_CHARS ? `${diff.slice(0, MAX_DIFF_CHARS)}\n…(truncated)` : diff;
      }
    } catch {
      missing.push("diff");
    }
  }

  // Preload workspace files once for impact/tests/api (bounded).
  let files: string[] = [];
  let cache = new Map<string, string>();
  if (flags.impact || flags.tests || flags.apiContracts) {
    try {
      files = (await io.listFiles(io.workspaceRoot)) ?? [];
      for (const f of files.slice(0, 400)) {
        try {
          const c = await io.readFile(f);
          if (c != null) cache.set(f, c.slice(0, 100000));
        } catch { /* skip */ }
      }
    } catch {
      missing.push("workspace");
    }
  }
  const syncRead = (p: string): string => {
    const hit = cache.get(p);
    if (hit === undefined) throw new Error(`unread:${p}`);
    return hit;
  };
  const scanIo = {
    listFiles: (_root: string): string[] | null => files,
    read: syncRead,
  };

  if (flags.impact) {
    try {
      const diff = bundle.diff ?? "";
      if (diff.trim()) {
        const symbols = symbolsForHunks(parseFileHunks(diff));
        const changedPaths = parseUnifiedDiff(diff).map((f) => f.path);
        const impactMap = buildImpactMap(symbols, changedPaths, scanIo, io.workspaceRoot);
        bundle.impact = {
          directFiles: impactMap.directFiles,
          indirectFiles: impactMap.indirectFiles,
          testFiles: impactMap.testFiles,
          scannedFiles: impactMap.scannedFiles,
          unresolved: impactMap.unresolved,
        };
      }
    } catch {
      missing.push("impact");
    }
  }

  if (flags.tests) {
    try {
      const discovery = discoverTests(scanIo, io.workspaceRoot);
      const diff = bundle.diff ?? "";
      let selected: Array<{ path: string; status: string; detail: string }> = [];
      if (diff.trim()) {
        const changedPaths = parseUnifiedDiff(diff).map((f) => f.path);
        const symbols = symbolsForHunks(parseFileHunks(diff));
        const impactMap = buildImpactMap(symbols, changedPaths, scanIo, io.workspaceRoot);
        const selection = selectTests(changedPaths, impactMap, discovery.tests);
        // Context assembly reports selection only — execution is a chat tool
        // (run_tests) so assembly never runs processes implicitly.
        selected = selection.selected.slice(0, 10).map((t) => ({
          path: t.path,
          status: "selected",
          detail: t.reason,
        }));
      }
      bundle.tests = {
        discovered: discovery.tests.length,
        selected: selected.length,
        passed: 0,
        failed: 0,
        results: selected,
      };
    } catch {
      missing.push("tests");
    }
  }

  if (flags.apiContracts) {
    try {
      const diff = bundle.diff ?? "";
      if (diff.trim()) {
        const symbols = symbolsForHunks(parseFileHunks(diff));
        const endpoints = symbols.filter((s) => s.kind === "endpoint");
        bundle.apiContracts = endpoints.slice(0, 20).map((s) => ({
          name: s.name,
          kind: "endpoint" as const,
          file: s.file,
          line: s.line,
          signature: s.signature,
        }));
      }
    } catch {
      missing.push("apiContracts");
    }
  }

  if (flags.docs) {
    try {
      const docs: DocExcerpt[] = [];
      for (const p of ["README.md", "docs/README.md", "design.md", "DESIGN.md", "docs/architecture.md"]) {
        try {
          const content = await io.readFile(p);
          if (content) docs.push({ path: p, content: content.slice(0, MAX_DOC_CHARS) });
        } catch { /* skip */ }
      }
      if (docs.length > 0) bundle.docs = docs;
    } catch {
      missing.push("docs");
    }
  }

  return { bundle, missing };
}

/** Render context bundle as markdown for prompt injection. */
export function renderContextMarkdown(bundle: ChatContextBundle, flags: ContextFlags): string {
  const sections: string[] = [];
  if (flags.activeFile && bundle.activeFile) {
    sections.push(`## Active File: \`${bundle.activeFile}\`${bundle.selection ? ` (lines ${bundle.selection.startLine}-${bundle.selection.endLine})` : ""}\n\`\`\`\n${(bundle.activeFileExcerpt ?? "").slice(0, MAX_ACTIVE_FILE_CHARS)}\n\`\`\``);
  }
  if (bundle.diff) sections.push(`## Working Tree Diff\n\`\`\`diff\n${bundle.diff}\n\`\`\``);
  if (bundle.impact) {
    const i = bundle.impact;
    const lines = [
      `## Impact Analysis`,
      `Direct files: ${i.directFiles.length}`,
      `Indirect files: ${i.indirectFiles.length}`,
      `Test files: ${i.testFiles.length}`,
      `Scanned: ${i.scannedFiles} files`,
    ];
    if (i.directFiles.length > 0) lines.push(`Direct: ${i.directFiles.slice(0, 10).join(", ")}`);
    if (i.unresolved.length > 0) lines.push(`Unresolved: ${i.unresolved.slice(0, 3).join("; ")}`);
    sections.push(lines.join("\n"));
  }
  if (bundle.tests) {
    const t = bundle.tests;
    const lines = [`## Tests`, `Discovered: ${t.discovered} | Selected: ${t.selected} | Passed: ${t.passed} | Failed: ${t.failed}`];
    if (t.results.length > 0) {
      lines.push("Selected:");
      for (const r of t.results.slice(0, 10)) lines.push(`- \`${r.path}\`: ${r.status} — ${r.detail.slice(0, 200)}`);
    }
    sections.push(lines.join("\n"));
  }
  if (bundle.apiContracts && bundle.apiContracts.length > 0) {
    const lines = ["## API Contracts"];
    for (const c of bundle.apiContracts.slice(0, 10)) {
      lines.push(`- \`${c.name}\` (${c.kind}) — \`${c.file}${c.line ? `:${c.line}` : ""}\` — \`${c.signature.slice(0, 160)}\``);
    }
    sections.push(lines.join("\n"));
  }
  if (bundle.docs && bundle.docs.length > 0) {
    const lines = ["## Project Docs"];
    for (const d of bundle.docs) lines.push(`### \`${d.path}\`\n${d.content.slice(0, MAX_DOC_CHARS)}`);
    sections.push(lines.join("\n"));
  }
  return sections.join("\n\n");
}

/** Which context sections are active — shown in the UI so users can remove them. */
export function describeActiveContext(bundle: ChatContextBundle, flags: ContextFlags): Array<{ key: keyof ContextFlags; label: string; detail: string }> {
  const out: Array<{ key: keyof ContextFlags; label: string; detail: string }> = [];
  if (flags.activeFile && bundle.activeFile) out.push({ key: "activeFile", label: "File", detail: bundle.activeFile });
  if (flags.diff && bundle.diff) out.push({ key: "diff", label: "Diff", detail: `${bundle.diff.length} chars` });
  if (flags.impact && bundle.impact) out.push({ key: "impact", label: "Impact", detail: `${bundle.impact.directFiles.length} direct` });
  if (flags.tests && bundle.tests) out.push({ key: "tests", label: "Tests", detail: `${bundle.tests.discovered} found` });
  if (flags.apiContracts && bundle.apiContracts?.length) out.push({ key: "apiContracts", label: "API", detail: `${bundle.apiContracts.length} symbols` });
  if (flags.docs && bundle.docs?.length) out.push({ key: "docs", label: "Docs", detail: bundle.docs.map((d) => d.path).join(", ") });
  return out;
}

export type { ApiContractSymbol };
