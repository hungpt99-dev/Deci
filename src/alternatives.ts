// US-006: Alternative Studio. Pure, local, no I/O, no LLM.
// Rejected decision in → 2-3 ranked alternatives out. Constraint from Reject
// flows into every option summary. Pick → implementation plan preview.
// VS Code/CLI are thin adapters over generate/pick/plan/render helpers.

import { guessTestPath, type DecisionPoint } from "./decisions.js";

export type Complexity = "Low" | "Medium" | "High";

export interface AlternativeOption {
  id: string;
  /** Compare-view label: A, B, C. */
  label: string;
  title: string;
  summary: string;
  complexity: Complexity;
  performance: string;
  consistency: string;
  changeSize: string;
  locAdded: number;
  locRemoved: number;
  pros: string[];
  cons: string[];
}

export interface AlternativeSet {
  decisionId: string;
  file: string;
  findingType: string;
  reason?: string;
  constraint: string;
  options: AlternativeOption[];
  pickedId?: string;
}

export interface PlanStep {
  file: string;
  action: string;
  detail: string;
}

export interface ImplementationPlan {
  decisionId: string;
  alternativeId: string;
  label: string;
  title: string;
  steps: PlanStep[];
  locAdded: number;
  locRemoved: number;
}

type Template = Omit<AlternativeOption, "id" | "label" | "summary"> & { title: string };

function withConstraint(base: string, constraint: string): string {
  return constraint ? `${base} Respects constraint: "${constraint}".` : base;
}

function genericTemplates(file: string): Template[] {
  return [
    {
      title: "Minimal targeted fix",
      complexity: "Low",
      performance: "No measurable change",
      consistency: "Unchanged",
      changeSize: "+30/−10 LOC",
      locAdded: 30,
      locRemoved: 10,
      pros: ["Smallest diff, fastest review", `Touches only \`${file}\``],
      cons: ["May not generalize to sibling cases", "Tech debt if pattern repeats"],
    },
    {
      title: "Extract behind a boundary",
      complexity: "Medium",
      performance: "No hot-path change expected",
      consistency: "Unchanged; single ownership",
      changeSize: "+120/−60 LOC",
      locAdded: 120,
      locRemoved: 60,
      pros: ["Isolates the decision for future changes", "Testable in one place"],
      cons: ["Larger diff than minimal fix", "New abstraction to maintain"],
    },
    {
      title: "Adopt proven pattern/library",
      complexity: "Medium",
      performance: "Depends on chosen library; verify with benchmark",
      consistency: "Follows community semantics",
      changeSize: "+80/−50 LOC",
      locAdded: 80,
      locRemoved: 50,
      pros: ["Battle-tested semantics", "Less custom code long-term"],
      cons: ["New dependency or convention", "Migration cost for existing callers"],
    },
  ];
}

function templatesFor(findingType: string, file: string): Template[] {
  switch (findingType) {
    case "CONSISTENCY_DECISION":
      return [
        {
          title: "Transactional Outbox",
          complexity: "Medium",
          performance: "Same throughput, +1 table write per tx",
          consistency: "Strong within service, eventual across services",
          changeSize: "+120/−30 LOC",
          locAdded: 120,
          locRemoved: 30,
          pros: ["No distributed transaction", "Replayable publish path"],
          cons: ["Needs outbox table + relay", "Consumers must be idempotent"],
        },
        {
          title: "Narrow the transaction scope",
          complexity: "Low",
          performance: "Shorter lock hold time",
          consistency: "Strong, smaller atomic unit",
          changeSize: "+40/−40 LOC",
          locAdded: 40,
          locRemoved: 40,
          pros: ["Smallest consistency risk", "Fastest to verify"],
          cons: ["May split work the caller assumed atomic", "Needs caller audit"],
        },
        {
          title: "Saga with compensations",
          complexity: "High",
          performance: "More round trips, async friendly",
          consistency: "Eventual; compensates on failure",
          changeSize: "+250/−80 LOC",
          locAdded: 250,
          locRemoved: 80,
          pros: ["Scales across services", "Explicit failure handling"],
          cons: ["Hardest to reason about", "Compensation logic must be complete"],
        },
      ];
    case "SECURITY_DECISION":
      return [
        {
          title: "Server-side allow-list check",
          complexity: "Low",
          performance: "One check per request, negligible",
          consistency: "Unchanged",
          changeSize: "+25/−10 LOC",
          locAdded: 25,
          locRemoved: 10,
          pros: ["Deny-by-default at the boundary", "Easy to audit"],
          cons: ["Allow-list needs maintenance", "Does not centralize policy"],
        },
        {
          title: "Central auth middleware/policy",
          complexity: "Medium",
          performance: "Shared check, cached policy lookup",
          consistency: "Uniform policy everywhere",
          changeSize: "+110/−60 LOC",
          locAdded: 110,
          locRemoved: 60,
          pros: ["One place to fix next time", "Covers all routes"],
          cons: ["Bigger diff", "Misconfig affects everything"],
        },
        {
          title: "Deny-by-default plus audit log",
          complexity: "Medium",
          performance: "Log write per denied attempt",
          consistency: "Unchanged; observability added",
          changeSize: "+70/−20 LOC",
          locAdded: 70,
          locRemoved: 20,
          pros: ["Detects probing fast", "Evidence for incident review"],
          cons: ["Log volume/noise", "Needs log retention story"],
        },
      ];
    case "DATA_MODEL_DECISION":
      return [
        {
          title: "Backward-compatible migration (add nullable, backfill, constrain)",
          complexity: "Medium",
          performance: "Backfill cost once; steady state unchanged",
          consistency: "Strong; zero-downtime rollout",
          changeSize: "+90/−20 LOC",
          locAdded: 90,
          locRemoved: 20,
          pros: ["Safe rollout + rollback", "No downtime"],
          cons: ["Multi-step migration", "Temporary nullable window"],
        },
        {
          title: "Separate table + join instead of column change",
          complexity: "Medium",
          performance: "Extra join on read path",
          consistency: "Strong via FK/transaction",
          changeSize: "+130/−30 LOC",
          locAdded: 130,
          locRemoved: 30,
          pros: ["Old schema untouched", "Easy revert (drop table)"],
          cons: ["Join cost forever", "ORM mapping churn"],
        },
        {
          title: "Single-shot migration with downtime window",
          complexity: "Low",
          performance: "Fast after cutover",
          consistency: "Strong after cutover",
          changeSize: "+40/−40 LOC",
          locAdded: 40,
          locRemoved: 40,
          pros: ["Smallest code change", "No transitional states"],
          cons: ["Requires downtime/coordination", "Risky rollback"],
        },
      ];
    case "PERFORMANCE_DECISION":
      return [
        {
          title: "Bounded cache with TTL + invalidation",
          complexity: "Medium",
          performance: "Hit path ~O(1); miss unchanged",
          consistency: "Eventual within TTL",
          changeSize: "+80/−20 LOC",
          locAdded: 80,
          locRemoved: 20,
          pros: ["Kills N+1 on hot path", "Bounded memory"],
          cons: ["Staleness window", "Invalidation bugs possible"],
        },
        {
          title: "Batch/paginate instead of cache",
          complexity: "Low",
          performance: "Fewer round trips, no staleness",
          consistency: "Strong (live reads)",
          changeSize: "+50/−30 LOC",
          locAdded: 50,
          locRemoved: 30,
          pros: ["No invalidation problem", "Predictable latency"],
          cons: ["Caller must paginate", "Less peak saving than cache"],
        },
        {
          title: "Async/parallelize independent work",
          complexity: "High",
          performance: "Latency approaches slowest branch",
          consistency: "Unchanged if branches independent",
          changeSize: "+150/−60 LOC",
          locAdded: 150,
          locRemoved: 60,
          pros: ["Best latency win when parallelizable", "No stale data"],
          cons: ["Concurrency bugs", "Harder to test"],
        },
      ];
    case "API_CONTRACT_DECISION":
    case "ARCHITECTURE_DECISION":
    case "DEPENDENCY_DECISION":
      return [
        {
          title: "Additive-only change (extend, never break)",
          complexity: "Low",
          performance: "Unchanged",
          consistency: "Backward compatible",
          changeSize: "+40/−5 LOC",
          locAdded: 40,
          locRemoved: 5,
          pros: ["Zero consumer breakage", "Easy rollback"],
          cons: ["Old surface lingers", "Deprecation needed later"],
        },
        {
          title: "Versioned boundary (v2 alongside v1)",
          complexity: "Medium",
          performance: "Routing overhead negligible",
          consistency: "Explicit per-version contract",
          changeSize: "+160/−40 LOC",
          locAdded: 160,
          locRemoved: 40,
          pros: ["Clean evolution path", "Consumers migrate at will"],
          cons: ["Two surfaces to maintain", "Sunset plan required"],
        },
        {
          title: "Breaking change with codemod + migration guide",
          complexity: "High",
          performance: "Unchanged after migration",
          consistency: "Single clean contract",
          changeSize: "+200/−150 LOC",
          locAdded: 200,
          locRemoved: 150,
          pros: ["No legacy drag", "One contract to own"],
          cons: ["All consumers must move", "Biggest review surface"],
        },
      ];
    case "RELIABILITY_DECISION":
      return [
        {
          title: "Retry with capped backoff + jitter",
          complexity: "Low",
          performance: "Extra attempts only on failure",
          consistency: "Needs idempotent handler",
          changeSize: "+35/−10 LOC",
          locAdded: 35,
          locRemoved: 10,
          pros: ["Absorbs transient faults", "Tiny diff"],
          cons: ["Amplifies load if unbounded", "Caller must tolerate duplicates"],
        },
        {
          title: "Circuit breaker + fallback",
          complexity: "Medium",
          performance: "Fails fast when downstream sick",
          consistency: "Degraded but responsive",
          changeSize: "+110/−30 LOC",
          locAdded: 110,
          locRemoved: 30,
          pros: ["Protects the whole service", "Explicit degraded mode"],
          cons: ["Fallback semantics to define", "Tuning thresholds"],
        },
        {
          title: "Idempotency keys end to end",
          complexity: "High",
          performance: "Key lookup per request",
          consistency: "Exactly-once effect",
          changeSize: "+180/−50 LOC",
          locAdded: 180,
          locRemoved: 50,
          pros: ["Safe retries anywhere", "Strongest correctness"],
          cons: ["Key storage + TTL", "Largest change"],
        },
      ];
    default:
      return genericTemplates(file);
  }
}

/**
 * Rejected (or any) decision → 2–3 alternatives. Pure and deterministic:
 * same decision + constraint always yields the same set. Never throws for
 * missing constraint — empty constraint just omits the Respects line.
 */
export function generateAlternatives(
  decision: DecisionPoint,
  overrideConstraint?: string,
): AlternativeSet {
  const constraint = (overrideConstraint ?? decision.constraint ?? "").trim();
  const labels = ["A", "B", "C"];
  const options = templatesFor(decision.findingType, decision.file)
    .slice(0, 3)
    .map((t, i) => ({
      ...t,
      id: `${decision.id}::${labels[i]}`,
      label: labels[i] as string,
      summary: withConstraint(`${t.title} for ${decision.findingType} in \`${decision.file}\`.`, constraint),
    }));
  return {
    decisionId: decision.id,
    file: decision.file,
    findingType: decision.findingType,
    reason: decision.rejectReason,
    constraint,
    options,
  };
}

/** Mark one alternative picked. Throws on unknown id. Immutable. */
export function pickAlternative(set: AlternativeSet, alternativeId: string): AlternativeSet {
  if (!set.options.some((o) => o.id === alternativeId)) throw new Error(`unknown alternative: ${alternativeId}`);
  return { ...set, pickedId: alternativeId };
}

function picked(set: AlternativeSet): AlternativeOption {
  const o = set.options.find((x) => x.id === set.pickedId) ?? set.options[0];
  if (!o) throw new Error(`alternative set empty for ${set.decisionId}`);
  return o;
}

/**
 * Picked (or first) alternative → implementation plan preview: file steps +
 * +/-LOC estimate. US-007 executes the patch; this only plans it.
 */
export function planForAlternative(set: AlternativeSet, alternativeId?: string): ImplementationPlan {
  const target = alternativeId
    ? set.options.find((o) => o.id === alternativeId)
    : set.options.find((o) => o.id === set.pickedId) ?? set.options[0];
  if (!target) throw new Error(`unknown alternative: ${alternativeId ?? set.pickedId ?? "?"}`);
  return {
    decisionId: set.decisionId,
    alternativeId: target.id,
    label: target.label,
    title: target.title,
    steps: [
      { file: set.file, action: "edit", detail: `Apply "${target.title}"${set.constraint ? ` respecting "${set.constraint}"` : ""}` },
      { file: guessTestPath(set.file), action: "update-tests", detail: "Cover new behavior + regression for the old path" },
      { file: set.file, action: "verify", detail: "Re-run build/tests/lint; re-queue affected decisions only" },
    ],
    locAdded: target.locAdded,
    locRemoved: target.locRemoved,
  };
}

/** A/B/C compare view + trade-off table. Pure markdown. */
export function renderAlternativesMarkdown(set: AlternativeSet): string {
  const head = [
    `## Alternative Studio — ${set.decisionId}`,
    ``,
    `Finding: ${set.findingType} in \`${set.file}\`${set.reason ? ` (rejected: ${set.reason})` : ""}`,
    set.constraint ? `Constraint: "${set.constraint}"` : `Constraint: (none given)`,
    ``,
  ];
  const cards = set.options.map((o) => {
    const pros = o.pros.map((p) => `  - + ${p}`).join("\n");
    const cons = o.cons.map((c) => `  - − ${c}`).join("\n");
    const mark = set.pickedId === o.id ? " ✅ picked" : "";
    return [
      `### Option ${o.label}: ${o.title}${mark}`,
      ``,
      `${o.summary}`,
      ``,
      `- Complexity: ${o.complexity} · Performance: ${o.performance} · Consistency: ${o.consistency} · Change: ${o.changeSize}`,
      `- Pros:`,
      pros,
      `- Cons:`,
      cons,
      ``,
    ].join("\n");
  });
  const table = [
    `| Alt | Title | Complexity | Performance | Consistency | Change |`,
    `| --- | --- | --- | --- | --- | --- |`,
    ...set.options.map(
      (o) =>
        `| ${o.label}${set.pickedId === o.id ? " ✅" : ""} | ${o.title} | ${o.complexity} | ${o.performance} | ${o.consistency} | ${o.changeSize} |`,
    ),
    ``,
    set.pickedId
      ? `Picked: ${picked(set).label} — proceed to implementation plan below.`
      : `Pick one to proceed to implementation plan.`,
    ``,
  ];
  return [...head, ...cards, `---`, ``, ...table].join("\n");
}

export function renderPlanMarkdown(plan: ImplementationPlan): string {
  const rows = plan.steps.map((s, i) => `| ${i + 1} | \`${s.file}\` | ${s.action} | ${s.detail} |`).join("\n");
  return [
    `## Implementation plan — Option ${plan.label}: ${plan.title}`,
    ``,
    `Decision: ${plan.decisionId} · Estimate: +${plan.locAdded}/−${plan.locRemoved} LOC`,
    ``,
    `| # | File | Action | Detail |`,
    `| --- | --- | --- | --- |`,
    rows,
    ``,
  ].join("\n");
}
