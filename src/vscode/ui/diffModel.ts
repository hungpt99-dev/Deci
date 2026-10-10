// Pure unified-diff hunk model for the Diff Review panel. Line numbers are
// 1-based new-file lines; `oldLine` null on added lines, `newLine` null on
// removed lines. Never throws on malformed input.
export interface DiffLine {
  kind: "context" | "add" | "del";
  oldLine: number | null;
  newLine: number | null;
  text: string;
}

export interface DiffHunk {
  oldStart: number;
  newStart: number;
  lines: DiffLine[];
}

export interface FileDiff {
  path: string;
  oldPath: string | null;
  isNew: boolean;
  isDeleted: boolean;
  hunks: DiffHunk[];
  added: number;
  removed: number;
}

function stripPrefix(p: string): string {
  const t = p.trim();
  return t.startsWith("a/") || t.startsWith("b/") ? t.slice(2) : t;
}

const HUNK_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

export function parseDiffHunks(diffText: string): FileDiff[] {
  const files: FileDiff[] = [];
  if (!diffText.trim()) return files;
  let cur: FileDiff | null = null;
  let hunk: DiffHunk | null = null;
  let oldLine = 0;
  let newLine = 0;
  let oldPath: string | null = null;
  let gitOld: string | null = null;
  const flush = (): void => {
    if (cur && cur.path && cur.path !== "/dev/null") files.push(cur);
    cur = null;
    hunk = null;
  };
  for (const raw of diffText.split("\n")) {
    if (raw.startsWith("diff --git ")) {
      const m = raw.match(/^diff --git (\S+) (\S+)/);
      gitOld = m ? stripPrefix(m[1]) : null;
      continue;
    }
    if (raw.startsWith("--- ")) {
      oldPath = stripPrefix(raw.slice(4));
      continue;
    }
    if (raw.startsWith("+++ ")) {
      flush();
      const r = stripPrefix(raw.slice(4));
      const isNew = oldPath === "/dev/null";
      const isDeleted = r === "/dev/null";
      const path = isDeleted ? (oldPath ?? gitOld ?? "unknown") : r;
      oldPath = null;
      cur = { path, oldPath: gitOld, isNew, isDeleted, hunks: [], added: 0, removed: 0 };
      gitOld = null;
      continue;
    }
    const hm = HUNK_RE.exec(raw);
    if (hm) {
      oldLine = Number(hm[1]);
      newLine = Number(hm[2]);
      hunk = { oldStart: oldLine, newStart: newLine, lines: [] };
      cur?.hunks.push(hunk);
      continue;
    }
    if (!cur || !hunk) continue;
    if (raw.startsWith("+") && !raw.startsWith("+++")) {
      hunk.lines.push({ kind: "add", oldLine: null, newLine: newLine++, text: raw.slice(1) });
      cur.added++;
    } else if (raw.startsWith("-") && !raw.startsWith("---")) {
      hunk.lines.push({ kind: "del", oldLine: oldLine++, newLine: null, text: raw.slice(1) });
      cur.removed++;
    } else if (raw.startsWith(" ") || raw === "") {
      const text = raw.startsWith(" ") ? raw.slice(1) : "";
      hunk.lines.push({ kind: "context", oldLine: oldLine++, newLine: newLine++, text });
    } else if (raw.startsWith("\\")) {
      continue; // "\ No newline at end of file"
    }
  }
  flush();
  return files;
}

/** Anchor line for a finding: new-file line when known, else null. */
export function anchorLine(line: number | null): number | null {
  return typeof line === "number" && Number.isFinite(line) && line > 0 ? line : null;
}
