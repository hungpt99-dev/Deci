// Change-aware test selection: changed files + impact edges + discovered
// tests → the minimal set worth running, each with a reason and an
// evidence basis. Pure, deterministic. Confirmed = observed relationship
// (sibling path, traced reference, contract touch). Inferred = heuristic
// (same module). Anything else is reported unexecuted, never implied.

import { guessTestPath } from "./decisions.js";
import type { DiscoveredTest } from "./discover.js";
import type { ImpactMap } from "./impact.js";
import { toModule } from "./reviewMap.js";

export type SelectionBasis = "confirmed" | "inferred";

export interface SelectedTest extends DiscoveredTest {
  reason: string;
  basis: SelectionBasis;
}

export interface TestSelection {
  selected: SelectedTest[];
  /** Discovered tests deliberately not run (with why). */
  unselected: Array<{ path: string; why: string }>;
  /** Selected entries that cannot run (toolchain unknown). */
  unrunnable: SelectedTest[];
}

const CONTRACT_RE = /\.proto$|openapi|swagger|schema\.(graphql|json)$|\.graphql$/i;

function sameModule(a: string, b: string): boolean {
  return toModule(a) === toModule(b);
}

/** Pure: rank discovered tests against a change. */
export function selectTests(
  changedFiles: string[],
  impact: ImpactMap,
  discovered: DiscoveredTest[],
): TestSelection {
  const changed = new Set(changedFiles);
  const byPath = new Map(discovered.map((t) => [t.path, t]));
  const picked = new Map<string, SelectedTest>();
  const take = (t: DiscoveredTest, reason: string, basis: SelectionBasis): void => {
    const prev = picked.get(t.path);
    // Confirmed evidence outranks inferred; first confirmed reason wins.
    if (!prev || (prev.basis === "inferred" && basis === "confirmed")) {
      picked.set(t.path, { ...t, reason, basis });
    }
  };

  // 1. Sibling tests of changed files (observed naming relationship).
  for (const f of changed) {
    const sib = guessTestPath(f);
    const hit = byPath.get(sib) ?? [...byPath.values()].find((t) => t.path.endsWith(`/${sib}`) || sib.endsWith(`/${t.path}`));
    if (hit) take(hit, `Sibling of changed file \`${f}\`.`, "confirmed");
  }

  // 2. Tests that reference the change (observed via impact tracing).
  for (const e of impact.edges) {
    const t = byPath.get(e.toFile) ?? [...byPath.values()].find((d) => e.toFile.endsWith(`/${d.path}`) || d.path.endsWith(`/${e.toFile}`));
    if (t && t.path !== e.fromFile) {
      take(t, `${e.depth === "direct" ? "Directly" : "Indirectly"} references changed \`${e.symbol}\` in \`${e.fromFile}\` (${e.evidence}, \`${e.toFile}:${e.toLine}\`).`, "confirmed");
    }
  }

  // 3. Contract/api tests when contract surface changed.
  if (changedFiles.some((f) => CONTRACT_RE.test(f))) {
    for (const t of discovered) {
      if ((t.category === "api" || t.category === "contract") && !picked.has(t.path)) {
        take(t, `Contract surface changed; \`${t.path}\` guards API behavior.`, "confirmed");
      }
    }
  }

  // 4. Same-module tests (heuristic — disclosed as inferred).
  for (const t of discovered) {
    if (picked.has(t.path)) continue;
    if (changedFiles.some((f) => sameModule(f, t.path))) {
      take(t, `Same module as a changed file (heuristic — no observed reference).`, "inferred");
    }
  }

  const selected = [...picked.values()].sort((a, b) => a.path.localeCompare(b.path));
  const unselected = discovered
    .filter((t) => !picked.has(t.path))
    .map((t) => ({ path: t.path, why: "No observed or module relationship to this change." }))
    .sort((a, b) => a.path.localeCompare(b.path));
  return { selected, unselected, unrunnable: selected.filter((t) => t.command.length === 0) };
}

/** CLI markdown: selected with reasons, plus what stays unexecuted. */
export function renderSelectionMarkdown(s: TestSelection): string {
  const rows = s.selected.map((t) => {
    const run = t.command.length ? `\`${t.command.join(" ")}\`` : `— ${t.unrunnable}`;
    return `| \`${t.path}\` | ${t.category} | ${t.basis} | ${run} | ${t.reason} |`;
  });
  return [
    `## Test selection (${s.selected.length} selected)`,
    ``,
    ...(s.selected.length
      ? [
        `| File | Category | Basis | Run | Reason |`,
        `| --- | --- | --- | --- | --- |`,
        ...rows,
        ``,
      ]
      : [`No tests selected for this change — nothing references it in scope.`, ``]),
    ...(s.unselected.length ? [`Unexecuted (${s.unselected.length}):`, ...s.unselected.slice(0, 10).map((u) => `- \`${u.path}\` — ${u.why}`), s.unselected.length > 10 ? `- …and ${s.unselected.length - 10} more.` : ``, ``] : []),
  ].join("\n");
}
