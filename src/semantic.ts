// US-002: Semantic change detection. Pure, local, no LLM, no I/O.
// Generic rule engine + pluggable language adapters (TS + Java ship by default).
// Line-pattern heuristics stand in for full AST; adapter interface lets real
// parsers plug in without core rewrite. Uncertain/unmatched never dropped.

export type SemanticCategory =
  | "business"
  | "architecture"
  | "data"
  | "security"
  | "reliability"
  | "performance";

export type FindingType =
  | "ARCHITECTURE_DECISION"
  | "BUSINESS_RULE_DECISION"
  | "SECURITY_DECISION"
  | "DATA_MODEL_DECISION"
  | "CONSISTENCY_DECISION"
  | "PERFORMANCE_DECISION"
  | "API_CONTRACT_DECISION"
  | "DEPENDENCY_DECISION"
  | "RELIABILITY_DECISION"
  | "BEHAVIOR_CHANGE";

export interface SemanticFinding {
  id: string;
  file: string;
  /** 1-based new-file line of the matched added line; null when not established. */
  line: number | null;
  language: string;
  category: SemanticCategory;
  type: FindingType;
  before: string;
  after: string;
  impact: string;
  /** 0–1. <0.6 marks uncertain but still emitted, never dropped. */
  confidence: number;
  uncertain: boolean;
}

export interface SemanticRule {
  match: RegExp;
  category: SemanticCategory;
  type: FindingType;
  confidence: number;
  impact: string;
}

export interface LanguageAdapter {
  id: string;
  matches(path: string): boolean;
  rules: SemanticRule[];
}

export interface FileHunk {
  path: string;
  added: string[];
  removed: string[];
  /**
   * 1-based new-file line for each entry of `added` (from `@@` headers;
   * sequential from 1 when the diff carries no headers, e.g. synthesized
   * manual diffs).
   */
  addedLines?: number[];
  /** Hunk-local removed lines backing each entry of `added` (the `before` context). */
  addedBefore?: string[][];
  /** Unchanged ` ` context lines (enclosing code, e.g. the function header). */
  context?: string[];
}

function stripGitPrefix(p: string): string {
  return p.startsWith("a/") || p.startsWith("b/") ? p.slice(2) : p;
}

function parseHunkHeader(line: string): number | null {
  const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
  return m ? parseInt(m[1] as string, 10) : null;
}

/** Parse unified diff keeping added/removed line text. Unknown input → [], never throws. */
export function parseFileHunks(diffText: string): FileHunk[] {
  const files: FileHunk[] = [];
  if (!diffText.trim()) return files;
  type Hunk = FileHunk & { addedLines: number[]; addedBefore: string[][]; context: string[] };
  let current: Hunk | null = null;
  let oldPath: string | null = null;
  let hunkRemoved: string[] = [];
  let nextNewLine = -1;
  let fallbackLine = 1;
  const flush = (): void => {
    if (current !== null && current.path && current.path !== "/dev/null") files.push(current);
    current = null;
  };
  for (const line of diffText.split("\n")) {
    if (line.startsWith("diff --git ")) continue;
    if (line.startsWith("--- ")) {
      oldPath = line.slice(4).trim();
      continue;
    }
    if (line.startsWith("+++ ")) {
      flush();
      const raw = line.slice(4).trim();
      const fresh = raw === "/dev/null" ? (oldPath ?? "/dev/null") : raw;
      oldPath = null;
      hunkRemoved = [];
      nextNewLine = -1;
      fallbackLine = 1;
      current = { path: stripGitPrefix(fresh.trim()), added: [], removed: [], addedLines: [], addedBefore: [], context: [] };
      continue;
    }
    if (line.startsWith("@@")) {
      hunkRemoved = [];
      nextNewLine = parseHunkHeader(line) ?? -1;
      continue;
    }
    if (line.startsWith("+") && !line.startsWith("+++")) {
      if (current === null) continue;
      current.added.push(line.slice(1));
      // Header-backed line when available, else sequential from 1
      // (synthesized diffs carry no `@@` headers).
      current.addedLines.push(nextNewLine > 0 ? nextNewLine : fallbackLine);
      current.addedBefore.push([...hunkRemoved]);
      if (nextNewLine > 0) nextNewLine += 1;
      else fallbackLine += 1;
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      if (current === null) continue;
      current.removed.push(line.slice(1));
      hunkRemoved.push(line.slice(1));
      // Context/removed lines do not advance the new-file counter.
    } else if (line.startsWith(" ") || line === "") {
      // A truly-empty line inside a hunk is an empty context line (an added
      // empty line would be "+"). It advances the new-file counter.
      if (nextNewLine > 0) nextNewLine += 1;
    }
    // Unchanged context lines are kept for enclosing-symbol attribution
    // (symbols.ts); they never create findings (analyzeFile ignores them).
    if ((line.startsWith(" ") || line === "") && current !== null)
      current.context.push(line.startsWith(" ") ? line.slice(1) : "");
  }
  flush();
  return files;
}

// Cross-cutting rules: run for every file regardless of language.
const genericAdapter: LanguageAdapter = {
  id: "generic",
  matches: () => true,
  rules: [
    { match: /password|secret|api[_-]?key|private[_-]?key|aws_secret|BEGIN.*PRIVATE KEY/i, category: "security", type: "SECURITY_DECISION", confidence: 0.9, impact: "Secret/credential material touched; leak or auth-bypass risk." },
    { match: /authorize|authentication|verifyToken|jwt\.verify|requireAuth|checkPermission|@PreAuthorize|@Secured/i, category: "security", type: "SECURITY_DECISION", confidence: 0.85, impact: "AuthN/authZ boundary changed; verify access control." },
    { match: /sanitiz|validat|escapeHtml|PreparedStatement|encodeForHTML/i, category: "security", type: "SECURITY_DECISION", confidence: 0.7, impact: "Input validation changed; injection/XSS risk." },
    { match: /CREATE TABLE|ALTER TABLE|DROP TABLE|ADD COLUMN|migration|@Entity|@Table|@Column/i, category: "data", type: "DATA_MODEL_DECISION", confidence: 0.85, impact: "Schema/migration changed; needs migration + rollback review." },
    { match: /transaction|@Transactional|BEGIN;?|COMMIT|ROLLBACK|outbox|saga/i, category: "data", type: "CONSISTENCY_DECISION", confidence: 0.8, impact: "Transaction/consistency boundary changed; check atomicity." },
    { match: /RequestMapping|@GetMapping|@PostMapping|@PutMapping|@DeleteMapping|@PatchMapping|Router\.|app\.(get|post|put|delete)|openapi|swagger|\.proto\b/i, category: "architecture", type: "API_CONTRACT_DECISION", confidence: 0.8, impact: "API contract surface changed; check consumers." },
    { match: /router\.(get|post|put|delete|patch)\s*\(|method:\s*["'](?:GET|POST|PUT|DELETE|PATCH)["']/i, category: "architecture", type: "API_CONTRACT_DECISION", confidence: 0.8, impact: "Route registration changed; check consumers and contract tests." },
    { match: /^import .* from ['"]|require\(|import java\.|implementation\(|<dependency>|"dependencies"/i, category: "architecture", type: "DEPENDENCY_DECISION", confidence: 0.7, impact: "Dependency set changed; check supply-chain + version drift." },
    { match: /retry|backoff|circuit.?breaker|timeout|deadline|idempoten|@Retryable|AbortController|resilien/i, category: "reliability", type: "RELIABILITY_DECISION", confidence: 0.8, impact: "Retry/timeout/idempotency changed; check failure modes." },
    { match: /cache|memoiz|Redis|useMemo|Promise\.all|parallelStream|CompletableFuture|Executor|synchronized|@Cacheable/i, category: "performance", type: "PERFORMANCE_DECISION", confidence: 0.75, impact: "Caching/concurrency changed; check contention + N+1." },
    { match: /discount|pricing|price|tax|invoice|payment|billing|checkout|refund|eligib/i, category: "business", type: "BUSINESS_RULE_DECISION", confidence: 0.7, impact: "Business rule changed; verify against ticket requirements." },
    { match: /^export (class|interface|function|const)|^public class |^interface |microservice|kafka|rabbitmq|grpc|publish\(/i, category: "architecture", type: "ARCHITECTURE_DECISION", confidence: 0.65, impact: "Module/service boundary changed; check coupling." },
  ],
};

const typescriptAdapter: LanguageAdapter = {
  id: "typescript",
  matches: (p) => /\.(ts|tsx|mts|cts|js|jsx)$/i.test(p),
  rules: [
    { match: /export (interface|type) \w+|function \w+\(.*:.*\):|:\s*Promise<|z\.object\(/, category: "architecture", type: "API_CONTRACT_DECISION", confidence: 0.8, impact: "TS public type/signature changed; check callers." },
    { match: /bcrypt|argon2|jwt\.sign|zod|yup|class-validator|DOMPurify/i, category: "security", type: "SECURITY_DECISION", confidence: 0.8, impact: "TS auth/crypto/validation changed; verify threat model." },
    { match: /if\s*\(.*(status|role|plan|tier|feature|permission)/i, category: "business", type: "BEHAVIOR_CHANGE", confidence: 0.55, impact: "Conditional business logic changed; uncertain — needs human look." },
  ],
};

const javaAdapter: LanguageAdapter = {
  id: "java",
  matches: (p) => /\.java$/i.test(p),
  rules: [
    { match: /@Entity|@Table|@Column|@JoinColumn|Flyway|Liquibase|V\d+__.*\.sql/i, category: "data", type: "DATA_MODEL_DECISION", confidence: 0.85, impact: "JPA/migration artifact changed; check schema rollout." },
    { match: /@RestController|@RequestMapping|@GetMapping|@PostMapping|ResponseEntity<|public .*DTO/i, category: "architecture", type: "API_CONTRACT_DECISION", confidence: 0.8, impact: "Spring API surface changed; check consumers." },
    { match: /@Async|@Scheduled|synchronized|volatile|Atomic\w+|ConcurrentHashMap|parallelStream/i, category: "performance", type: "PERFORMANCE_DECISION", confidence: 0.75, impact: "Java concurrency changed; check thread-safety." },
    { match: /if\s*\(.*(status|role|plan|tier|getStatus|isEligible)/i, category: "business", type: "BEHAVIOR_CHANGE", confidence: 0.55, impact: "Conditional business logic changed; uncertain — needs human look." },
  ],
};

const registry: LanguageAdapter[] = [typescriptAdapter, javaAdapter];

/** Register extra language without touching core. Generic always runs underneath. */
export function registerAdapter(adapter: LanguageAdapter): void {
  if (!registry.some((a) => a.id === adapter.id)) registry.push(adapter);
}

export function languageFor(path: string): string {
  return registry.find((a) => a.matches(path))?.id ?? "generic";
}

const MAX_FINDINGS_PER_FILE = 50;

export function analyzeFile(hunk: FileHunk): SemanticFinding[] {
  const adapters = [genericAdapter, ...registry.filter((a) => a.matches(hunk.path))];
  const language = languageFor(hunk.path);
  const findings: SemanticFinding[] = [];
  const lines = hunk.addedLines && hunk.addedLines.length === hunk.added.length
    ? hunk.addedLines
    : hunk.added.map((_, i) => i + 1);
  const befores = hunk.addedBefore && hunk.addedBefore.length === hunk.added.length
    ? hunk.addedBefore
    : hunk.added.map(() => hunk.removed);
  const changed = hunk.added.map((t, i) => ({ t, line: lines[i] as number, before: befores[i] as string[] }));
  let n = 0;
  const pushFinding = (t: string, line: number | null, before: string, r: SemanticRule): void => {
    if (n >= MAX_FINDINGS_PER_FILE) return;
    n += 1;
    findings.push({
      id: `${hunk.path}:${line ?? `del${n}`}:${r.type}`,
      file: hunk.path,
      line,
      language,
      category: r.category,
      type: r.type,
      before: before.trim().slice(0, 300),
      after: t.trim().slice(0, 300),
      impact: r.impact,
      confidence: r.confidence,
      uncertain: r.confidence < 0.6,
    });
  };
  for (const { t, line, before } of changed) {
    for (const a of adapters) {
      for (const r of a.rules) {
        if (!r.match.test(t)) continue;
        // Hunk-local `before`: the most recent removed line(s) this hunk
        // replaced (index-paired when the hunk aligns, nearest otherwise).
        // Pure additions have no `before` — "" says so instead of
        // borrowing an unrelated removed line from elsewhere.
        pushFinding(t, line, before[before.length - 1] ?? "", r);
      }
    }
  }
  // Removed lines carry signal too (e.g. a deleted auth check). They have
  // no new-file line, so `line` is null and the removed text is the `before`.
  for (const t of hunk.removed) {
    for (const a of adapters) {
      for (const r of a.rules) {
        if (!r.match.test(t)) continue;
        pushFinding("(removed)", null, t, r);
      }
    }
  }
  if (findings.length === 0 && (hunk.added.length > 0 || hunk.removed.length > 0)) {
    // Uncertain fallback: never silently drop a changed file.
    findings.push({
      id: `${hunk.path}:1:BEHAVIOR_CHANGE`,
      file: hunk.path,
      line: lines[0] ?? 1,
      language,
      category: "business",
      type: "BEHAVIOR_CHANGE",
      before: (hunk.removed[0] ?? "").trim().slice(0, 300),
      after: (hunk.added[0] ?? "").trim().slice(0, 300),
      impact: "Unclassified change; needs human look.",
      confidence: 0.4,
      uncertain: true,
    });
  }
  return findings;
}

/** Diff text → ranked semantic findings. Pure; heaviest-first (security/data first). */
export function analyzeSemantics(diffText: string): SemanticFinding[] {
  const rank: Record<SemanticCategory, number> = {
    security: 0, data: 1, reliability: 2, architecture: 3, business: 4, performance: 5,
  };
  return parseFileHunks(diffText)
    .flatMap(analyzeFile)
    .sort((a, b) => rank[a.category] - rank[b.category] || b.confidence - a.confidence);
}
