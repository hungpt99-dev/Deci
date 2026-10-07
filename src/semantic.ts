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
}

/** Parse unified diff keeping added/removed line text. Unknown input → [], never throws. */
export function parseFileHunks(diffText: string): FileHunk[] {
  const files: FileHunk[] = [];
  if (!diffText.trim()) return files;
  let current: FileHunk | null = null;
  const flush = () => {
    if (current && current.path && current.path !== "/dev/null") files.push(current);
    current = null;
  };
  for (const line of diffText.split("\n")) {
    if (line.startsWith("+++ b/")) {
      flush();
      current = { path: line.slice(6).trim(), added: [], removed: [] };
    } else if (line.startsWith("+++ ") && !current) {
      continue;
    } else if (line.startsWith("--- a/") && current?.path === "/dev/null") {
      current.path = line.slice(6).trim();
    } else if (line.startsWith("+") && !line.startsWith("+++")) {
      current?.added.push(line.slice(1));
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      current?.removed.push(line.slice(1));
    }
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
  const changed = [...hunk.added.map((t) => ({ t, side: "+" as const })), ...hunk.removed.map((t) => ({ t, side: "-" as const }))];
  let n = 0;
  for (const { t } of changed) {
    for (const a of adapters) {
      for (const r of a.rules) {
        if (!r.match.test(t)) continue;
        if (n >= MAX_FINDINGS_PER_FILE) break;
        n += 1;
        findings.push({
          id: `${hunk.path}:${n}:${r.type}`,
          file: hunk.path,
          language,
          category: r.category,
          type: r.type,
          before: hunk.removed[0] ?? "",
          after: t.trim().slice(0, 300),
          impact: r.impact,
          confidence: r.confidence,
          uncertain: r.confidence < 0.6,
        });
      }
    }
  }
  if (findings.length === 0 && (hunk.added.length > 0 || hunk.removed.length > 0)) {
    // Uncertain fallback: never silently drop a changed file.
    findings.push({
      id: `${hunk.path}:1:BEHAVIOR_CHANGE`,
      file: hunk.path,
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
