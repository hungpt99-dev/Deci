// US-001: Review Map core. Pure, local, no LLM. Deterministic heuristics;
// semantic risk (US-002) and auto-verified collapse (US-003) plug in later.

export type RiskLevel = "Critical" | "High" | "Medium" | "Low" | "Verified";

export interface FileChange {
  path: string;
  added: number;
  removed: number;
  module: string;
  service: string;
  risk: RiskLevel;
  /** Why this risk; cites the diff path that set it. */
  why?: string;
}

export interface RiskBucket {
  files: number;
  loc: number;
}

export interface ReviewMap {
  totalAdded: number;
  totalRemoved: number;
  totalLoc: number;
  fileCount: number;
  files: FileChange[];
  modules: string[];
  services: string[];
  riskDistribution: Record<RiskLevel, RiskBucket>;
  estimatedFullReviewMinutes: number;
  estimatedHumanReviewMinutes: number;
  compressionRatio: number;
  generatedAt: string;
}

// ponytail: regex heuristics, real AST/classification lands in US-002.
const CRITICAL_RE = /(migrat|schema\.sql|\.key$|\.pem$|secrets?|auth|login|session|password|crypto|payment|billing)/i;
const HIGH_RE = /(openapi|swagger|\.proto$|schema\.(graphql|json)$|contract|db\/|sql\/|prisma\/|drizzle\/|typeorm)/i;
const LOW_RE = /(__tests__|\.test\.|\.spec\.|test\/|tests\/|\.md$|docs\/|\.json$|\.ya?ml$|\.lock$|eslint|prettier|editorconfig|gitignore)/i;

// Full-diff pace calibrated to PRD §8: ~3842 LOC ≈ 45 min → ~85 LOC/min.
const LOC_PER_MINUTE = 85;

const CONTAINER_DIRS = new Set([
  "src", "lib", "app", "packages", "services", "apps", "backend",
  "frontend", "server", "client", "libs", "modules", "test", "tests",
]);

export function toModule(path: string): string {
  const parts = path.split("/").filter(Boolean);
  if (parts.length <= 2) return parts.slice(0, -1).join("/") || "(root)";
  return parts.slice(0, 2).join("/");
}

export function toService(path: string): string {
  const parts = path.split("/").filter(Boolean);
  if (parts.length === 0) return "(root)";
  if (parts.length === 1) return "(root)";
  return CONTAINER_DIRS.has(parts[0]) ? (parts[1] ?? parts[0]) : parts[0];
}

export function classifyRisk(path: string): RiskLevel {
  if (CRITICAL_RE.test(path)) return "Critical";
  if (HIGH_RE.test(path)) return "High";
  if (LOW_RE.test(path)) return "Low";
  return "Medium";
}

function stripGitPrefix(p: string): string {
  return p.startsWith("a/") || p.startsWith("b/") ? p.slice(2) : p;
}

/**
 * Parse a unified git diff into per-file line counts. Unknown input →
 * empty, never throws. Handles new files (--- /dev/null), deleted files
 * (+++ /dev/null), and renames (diff --git header) — deleted files are
 * review-relevant and must never be silently dropped.
 */
export function parseUnifiedDiff(diffText: string): Omit<FileChange, "module" | "service" | "risk">[] {
  const files: Omit<FileChange, "module" | "service" | "risk">[] = [];
  if (!diffText.trim()) return files;
  type Entry = { path: string; added: number; removed: number };
  let current: Entry | null = null;
  // `---`/`+++` pair seen for the file whose hunk lines follow.
  let oldPath: string | null = null;
  let gitPaths: [string, string] | null = null;
  const flush = (): void => {
    if (current && current.path && current.path !== "/dev/null") files.push({ ...current });
    current = null;
  };
  for (const line of diffText.split("\n")) {
    if (line.startsWith("diff --git ")) {
      const m = line.match(/^diff --git (\S+) (\S+)/);
      gitPaths = m ? [m[1] as string, m[2] as string] : null;
      continue;
    }
    if (line.startsWith("--- ")) {
      oldPath = line.slice(4).trim();
      continue;
    }
    if (line.startsWith("+++ ")) {
      flush();
      const raw = line.slice(4).trim();
      const fresh = raw === "/dev/null" ? (oldPath ?? gitPaths?.[0] ?? "/dev/null") : raw;
      oldPath = null;
      gitPaths = null;
      current = { path: stripGitPrefix(fresh.trim()), added: 0, removed: 0 };
    } else if (line.startsWith("+") && !line.startsWith("+++")) {
      if (current !== null) current.added += 1;
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      if (current !== null) current.removed += 1;
    }
  }
  flush();
  return files.filter((f) => f.path && f.path !== "/dev/null");
}

export function buildReviewMap(diffText: string): ReviewMap {
  const parsed = parseUnifiedDiff(diffText);
  const files: FileChange[] = parsed.map((f) => {
    const risk = classifyRisk(f.path);
    const lines = `+${f.added}/-${f.removed} (${f.added + f.removed} lines)`;
    const why =
      risk === "Critical"
        ? `Critical — \`${f.path}\` ${lines} matches critical pattern (auth/data/migration/secrets), confirmed by diff path.`
        : risk === "High"
          ? `High — \`${f.path}\` ${lines} matches contract/data-layer pattern, confirmed by diff path.`
          : risk === "Low"
            ? `Low — \`${f.path}\` ${lines} matches low-risk pattern (tests/docs/config), confirmed by diff path.`
            : `Medium — \`${f.path}\` ${lines} matched no critical/high/low pattern, confirmed by diff path.`;
    return {
      ...f,
      module: toModule(f.path),
      service: toService(f.path),
      risk,
      why,
    };
  });
  const totalAdded = files.reduce((n, f) => n + f.added, 0);
  const totalRemoved = files.reduce((n, f) => n + f.removed, 0);
  const totalLoc = totalAdded + totalRemoved;
  const modules = [...new Set(files.map((f) => f.module))].sort();
  const services = [...new Set(files.map((f) => f.service))].sort();
  const riskDistribution = {
    Critical: { files: 0, loc: 0 },
    High: { files: 0, loc: 0 },
    Medium: { files: 0, loc: 0 },
    Low: { files: 0, loc: 0 },
    Verified: { files: 0, loc: 0 },
  } satisfies Record<RiskLevel, RiskBucket>;
  for (const f of files) {
    riskDistribution[f.risk].files += 1;
    riskDistribution[f.risk].loc += f.added + f.removed;
  }
  const focusLoc =
    riskDistribution.Critical.loc + riskDistribution.High.loc + riskDistribution.Medium.loc;
  const estimatedFullReviewMinutes = Math.max(totalLoc === 0 ? 0 : 1, Math.ceil(totalLoc / LOC_PER_MINUTE));
  const estimatedHumanReviewMinutes =
    totalLoc === 0 ? 0 : Math.max(1, Math.ceil((focusLoc || totalLoc) / LOC_PER_MINUTE));
  const compressionRatio =
    estimatedHumanReviewMinutes === 0
      ? 1
      : Math.round((estimatedFullReviewMinutes / estimatedHumanReviewMinutes) * 10) / 10;
  return {
    totalAdded,
    totalRemoved,
    totalLoc,
    fileCount: files.length,
    files: files.sort((a, b) => b.added + b.removed - (a.added + a.removed)),
    modules,
    services,
    riskDistribution,
    estimatedFullReviewMinutes,
    estimatedHumanReviewMinutes,
    compressionRatio,
    generatedAt: new Date().toISOString(),
  };
}

export function renderMarkdown(map: ReviewMap): string {
  const r = map.riskDistribution;
  const row = (level: RiskLevel) => `| ${level} | ${r[level].files} | ${r[level].loc} |`;
  const top = map.files
    .slice(0, 10)
    .map((f) => `- \`${f.path}\` — +${f.added}/-${f.removed} · ${f.risk} · ${f.module}`)
    .join("\n");
  return [
    `# Review Map`,
    ``,
    `**${map.totalLoc} LOC** changed across **${map.fileCount} files** · **${map.modules.length} modules** · **${map.services.length} services**`,
    ``,
    `| Risk | Files | LOC |`,
    `| --- | --- | --- |`,
    row("Critical"),
    row("High"),
    row("Medium"),
    row("Low"),
    row("Verified"),
    ``,
    `Human review ~**${map.estimatedHumanReviewMinutes} min** vs full diff ~**${map.estimatedFullReviewMinutes} min** (×${map.compressionRatio} compression).`,
    ``,
    map.modules.length ? `Modules: ${map.modules.join(", ")}` : `Modules: —`,
    map.services.length ? `Services: ${map.services.join(", ")}` : `Services: —`,
    ``,
    top ? `## Largest files\n\n${top}` : `No changes.`,
    ``,
  ].join("\n");
}
