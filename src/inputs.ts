// US-011: Diff + ticket + doc inputs. Pure core, local-git only, no LLM.
// CLI and VS Code are thin adapters over DiffSpec + collectDiffText +
// resolveRefInput + buildManualDiff. Remote refs mark unreachable and never
// block analysis; manual file/folder pick covers the no-git-repo fallback.

import type { TicketInput } from "./evidence.js";

export type DiffSpec =
  | { kind: "working" }
  | { kind: "staged" }
  | { kind: "range"; range: string }
  | { kind: "file"; path: string };

export interface InputIo {
  /** Run a local shell command (adapter injects execSync; tests stub). Optional: only git specs need it. */
  exec?: (cmd: string) => string;
  exists: (path: string) => boolean;
  read: (path: string) => string;
  /** Null = not a directory (single-file fallback); [] = empty dir. */
  listFiles?: (path: string) => string[] | null;
  /** Warn hook for remote refs (CLI prints to stderr; tests capture). */
  onRemote?: (ref: string) => void;
}

export const MAX_REF_CHARS = 2000;

/** Parse CLI diff flags. Precedence: --file > --staged > --diff/--range/--base > working. */
export function parseDiffArgs(args: string[]): DiffSpec {
  const val = (flag: string): string | null => {
    const i = args.indexOf(flag);
    return i >= 0 && i + 1 < args.length ? (args[i + 1] as string) : null;
  };
  const file = val("--file");
  if (file) return { kind: "file", path: file };
  if (args.includes("--staged")) return { kind: "staged" };
  const range = val("--diff") ?? val("--range");
  if (range) return { kind: "range", range };
  const base = val("--base");
  if (base) return { kind: "range", range: `${base}...HEAD` };
  return { kind: "working" };
}

/** Local git command for a spec; null = manual file/folder read, never a remote fetch. */
export function diffCommandFor(spec: DiffSpec): string | null {
  switch (spec.kind) {
    case "staged":
      return "git diff --staged";
    case "range":
      return `git diff ${spec.range}`;
    case "working":
      return "git diff HEAD";
    case "file":
      return null;
  }
}

export function describeDiffSpec(spec: DiffSpec): string {
  switch (spec.kind) {
    case "staged":
      return "staged (git diff --staged)";
    case "range":
      return `branch-vs-base (${spec.range})`;
    case "file":
      return `manual pick (${spec.path})`;
    case "working":
      return "working tree (git diff HEAD)";
  }
}

/**
 * Shared ref resolver for --ticket/--doc: local file wins (excerpt),
 * http(s) marks unreachable (MVP does no cloud fetch), anything else is
 * inline text. Never throws — unreachable/missing never blocks analysis.
 */
export function resolveRefInput(raw: string | null, io: InputIo): TicketInput {
  if (!raw) return { text: null, unreachable: false, ref: null };
  try {
    if (io.exists(raw)) return { text: io.read(raw).slice(0, MAX_REF_CHARS), unreachable: false, ref: raw };
  } catch {
    return { text: null, unreachable: true, ref: raw };
  }
  if (/^https?:\/\//i.test(raw)) {
    try {
      io.onRemote?.(raw);
    } catch {
      // warn hook must never break analysis
    }
    return { text: null, unreachable: true, ref: raw };
  }
  return { text: raw.slice(0, MAX_REF_CHARS), unreachable: false, ref: raw.slice(0, 120) };
}

/** Synthesize a unified diff from picked files (no-git fallback). Parses back via parseUnifiedDiff. */
export function buildManualDiff(files: Array<{ path: string; content: string }>): string {
  if (files.length === 0) return "";
  return files
    .map(({ path, content }) => {
      const body = content
        .split("\n")
        .slice(0, 2000)
        .map((l) => `+${l}`)
        .join("\n");
      return `--- a/${path}\n+++ b/${path}\n${body}`;
    })
    .join("\n");
}

/**
 * Resolve a DiffSpec to diff text. File specs read one file or, when
 * listFiles returns entries, synthesize via buildManualDiff (folder
 * fallback). Git failures hint at --file instead of hiding the cause.
 */
export function collectDiffText(spec: DiffSpec, io: InputIo): string {
  if (spec.kind === "file") {
    const listed = (() => {
      try {
        return io.listFiles?.(spec.path) ?? null;
      } catch {
        return null;
      }
    })();
    if (listed) {
      const files = listed.slice(0, 50).map((p) => {
        try {
          return { path: p, content: io.read(p).slice(0, 20000) };
        } catch {
          return { path: p, content: "" };
        }
      });
      return buildManualDiff(files);
    }
    try {
      return io.read(spec.path);
    } catch (err) {
      throw new Error(`cannot read ${spec.path}: ${(err as Error).message} (tip: pick a file or folder path)`);
    }
  }
  const cmd = diffCommandFor(spec) as string;
  if (!io.exec) throw new Error(`no exec for git diff (${cmd}) (tip: no git repo? use --file <path>)`);
  try {
    return io.exec(cmd);
  } catch (err) {
    throw new Error(`git diff failed (${cmd}): ${(err as Error).message} (tip: no git repo? use --file <path>)`);
  }
}

/** One-line `## Inputs` summary for CLI output and VS Code panels. */
export function renderInputsMarkdown(spec: DiffSpec, ticket: TicketInput, doc: TicketInput): string {
  const mark = (t: TicketInput): string => (t.text ? `✓ ${t.ref}` : t.unreachable ? `✗ ${t.ref} (unreachable)` : "— not provided");
  return [`## Inputs`, ``, `- diff: ${describeDiffSpec(spec)}`, `- ticket: ${mark(ticket)}`, `- design doc: ${mark(doc)}`, ``].join("\n");
}
