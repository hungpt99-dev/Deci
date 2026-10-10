#!/usr/bin/env node
// Thin CLI over core (US-010 subset for US-001): analyze only, no implement/verify-write.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync, lstatSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { buildReviewMap, parseUnifiedDiff, renderMarkdown } from "./reviewMap.js";
import { analyzeSemantics, parseFileHunks } from "./semantic.js";
import {
  collectDiffText,
  describeDiffSpec,
  parseDiffArgs,
  renderInputsMarkdown,
  resolveRefInput,
} from "./inputs.js";
import {
  collectQueueEvidence,
  renderQueueEvidenceMarkdown,
  type EvidenceContext,
  type TicketInput,
} from "./evidence.js";
import {
  generateAlternatives,
  renderAlternativesMarkdown,
} from "./alternatives.js";
import {
  buildDecisions,
  decisionSummary,
  guessTestPath,
  renderDecisionsMarkdown,
} from "./decisions.js";
import { applyVerification, renderVerifyMarkdown, runFullVerify } from "./verify.js";
import { buildOutputBundle, renderBundleMarkdown } from "./bundle.js";
import { symbolsForHunks } from "./symbols.js";
import { buildImpactMap, renderImpactMarkdown } from "./impact.js";
import { buildRiskFindings, renderRisksMarkdown } from "./risks.js";
import { buildOverview, renderOverviewMarkdown } from "./overview.js";
import { buildReportHtml, type RevisionInfo } from "./report.js";
import { discoverTests, renderDiscoveryMarkdown } from "./discover.js";
import { renderSelectionMarkdown, selectTests } from "./select.js";
import { renderResultsMarkdown, runTests, summarizeResults, type TestResult } from "./run.js";
import { generateTests, renderGeneratedMarkdown, siblingTestPath, writeGeneratedTests } from "./generate.js";
import { applyProposedPatch, diagnoseFailure, renderDiagnosisMarkdown, type Diagnosis } from "./diagnose.js";
import {
  checkProvider,
  describeProvider,
  PROVIDER_SPECS,
  resolveProvider,
  validateProvider,
  type Policy,
  type ProviderInput,
} from "./providers.js";
import { assistDiagnosis, explainChange, renderAiMarkdown, type AiContext, type AiResult } from "./operations.js";
import {
  renderProviderMarkdown,
  resolveProviderConfig,
} from "./llm.js";

function usage(): string {
  return [
    `Usage:`,
    `  deci analyze [diff flags] [--ticket T] [--doc D] [--json] [--html <path>] [--root <dir>] [--verify] [--static-only]`,
    `                 [--generate-tests] [--write-tests] [--run-tests [--timeout MS]] [--diagnose [--apply-fix]]`,
    `                 [--save-results <path>] [--compare <path>] [--ai-explain] [--ai-diagnose] [provider flags]`,
    `  deci tests [--root <dir>] [diff flags]`,
    `  deci providers [--check [--live]] [--provider ID] [--model M] [--base-url U] [--json]`,
    `  deci chat new [--title T] [--store DIR] [--root DIR]`,
    `  deci chat list [--store DIR]`,
    `  deci chat send --id ID --message TEXT [--store DIR] [--root DIR] [provider flags]`,
    `  deci chat rename --id ID --title T [--store DIR]`,
    `  deci chat rm --id ID [--store DIR]`,
    ``,
    `Provider flags: --provider ID --model M --base-url U, --route op=ID[:model], --fallback a,b,`,
    `  --allow-cloud-fallback, --allow-cloud-ai. Keys come from the environment only.`,
    `AI flags (--ai-explain/--ai-diagnose) call the routed provider; local providers run freely,`,
    `  cloud providers need --allow-cloud-ai / DECI_ALLOW_CLOUD_AI=1 or the call is refused.`,
    ``,
    `Diff flags: working tree (default, git diff HEAD), --staged, --diff/--range/--base <range>, --file <path>.`,
    `--html writes a self-contained interactive report. --root scopes discovery/tracing (default: cwd).`,
    `--generate-tests prints reviewable scaffolds; --write-tests writes them (never overwrites).`,
    `--run-tests executes the selected tests with real tools; --diagnose explains failures;`,
    `  --apply-fix applies a proposed guard patch (explicit approval, otherwise refused).`,
    `Exit codes: 0 clean/low, 2 decisions-required (Critical/High present, or any test failed), 1 error.`,
  ].join("\n");
}

function argValue(args: string[], flag: string): string | null {
  const i = args.indexOf(flag);
  return i >= 0 && i + 1 < args.length ? (args[i + 1] as string) : null;
}

function listFilesRecursive(root: string): string[] | null {
  return walkFiles(root, 50);
}

/** Bounded repo walk for test discovery (widest cap; discovery reports its own truncation). */
function listDiscoverFiles(root: string): string[] | null {
  return walkFiles(root, 400);
}

/** Bounded repo walk for impact tracing (wider cap than the --file fallback). */
function listImpactFiles(root: string): string[] | null {
  return walkFiles(root, 200);
}

/** Fs-backed IO for discovery/impact/generation, rooted at `root`. */
function repoIo(root: string): {
  listFiles: (r: string) => string[] | null;
  read: (p: string) => string;
} {
  const absRoot = resolve(process.cwd(), root);
  const toRootRel = (p: string): string => {
    const rel = relative(absRoot, resolve(p));
    return rel.startsWith("..") || rel === "" ? p : rel;
  };
  return {
    listFiles: (r) => (r === root ? listDiscoverFiles(r)?.map(toRootRel) : listDiscoverFiles(r)) ?? null,
    read: (p) => readFileSync(resolveImpactPath(root, p), "utf8"),
  };
}

/** Guard lines a diff removed from a file (for guard-restore patch proposals). */
function removedGuardsFor(queue: Array<{ file: string; before: string }>, file: string): { path: string; lines: string[] } | null {
  const lines = [...new Set(
    queue
      .filter((d) => d.file === file || file.endsWith(`/${d.file}`) || d.file.endsWith(`/${file}`))
      .map((d) => d.before)
      .filter((b) => b && /\bthrow\b/.test(b)),
  )];
  return lines.length > 0 ? { path: file, lines } : null;
}

function hasDiffFlags(args: string[]): boolean {
  return ["--file", "--staged", "--diff", "--range", "--base"].some((f) => args.includes(f));
}

/** `deci tests`: discovery always; selection when a change is specified. */
async function runTestsCommand(rest: string[]): Promise<number> {
  const root = argValue(rest, "--root") ?? process.cwd();
  const io = repoIo(root);
  const discovery = discoverTests(io, root);
  console.log(renderDiscoveryMarkdown(discovery));
  if (!hasDiffFlags(rest)) {
    console.log(`Tip: add a diff source (--file/--staged/--diff) to select change-relevant tests.`);
    return 0;
  }
  let diff: string;
  try {
    ({ text: diff } = collectDiff(rest));
  } catch (err) {
    console.error(`Error: ${(err as Error).message}`);
    return 1;
  }
  const changedPaths = parseUnifiedDiff(diff).map((f) => f.path);
  const symbols = symbolsForHunks(parseFileHunks(diff));
  const impact = buildImpactMap(symbols, changedPaths, io, root);
  const selection = selectTests(changedPaths, impact, discovery.tests);
  console.log(renderSelectionMarkdown(selection));
  return 0;
}

function walkFiles(root: string, cap: number): string[] | null {
  let st: ReturnType<typeof statSync>;
  try {
    st = statSync(root);
  } catch {
    return null;
  }
  if (!st.isDirectory()) return null;
  const out: string[] = [];
  const seen = new Set<string>();
  const walk = (dir: string, depth: number): void => {
    if (depth > 8 || out.length >= cap) return;
    let real: string;
    try {
      // Identity by device+inode so symlink loops cannot cycle forever.
      const s = statSync(dir);
      real = `${s.dev}:${s.ino}`;
    } catch {
      return;
    }
    if (seen.has(real)) return;
    seen.add(real);
    for (const e of readdirSync(dir)) {
      const p = join(dir, e);
      try {
        // Never follow symlinks: they can point outside the picked folder.
        if (lstatSync(p).isSymbolicLink()) continue;
        if (statSync(p).isDirectory()) {
          // Build output, VCS metadata, and agent-harness worktrees (repo
          // copies) never contain first-party scope.
          if (e === "node_modules" || e === ".git" || e === "dist" || e === ".kilo" || e === ".opencode" || e === ".agents" || e === ".cursor" || e === "worktrees") continue;
          walk(p, depth + 1);
        } else out.push(p);
      } catch {
        continue;
      }
      if (out.length >= cap) return;
    }
  };
  try {
    walk(root, 0);
  } catch {
    return null;
  }
  return out.slice(0, cap);
}

function collectDiff(args: string[]): { text: string; spec: ReturnType<typeof parseDiffArgs> } {
  const spec = parseDiffArgs(args);
  const text = collectDiffText(spec, {
    execArgv: (gitArgs) =>
      execFileSync("git", gitArgs, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }) as string,
    exists: (p) => {
      try {
        return existsSync(p);
      } catch {
        return false;
      }
    },
    read: (p) => readFileSync(p, "utf8"),
    listFiles: listFilesRecursive,
  });
  return { text, spec };
}

async function main(): Promise<number> {
  const [, , command, ...rest] = process.argv;
  if (command === "tests") return runTestsCommand(rest);
  if (command === "providers") return runProvidersCommand(rest);
  if (command === "chat") return runChatCommand(rest);
  if (command !== "analyze") {
    console.error(usage());
    return 1;
  }
  let diff: string;
  let spec: ReturnType<typeof parseDiffArgs>;
  try {
    ({ text: diff, spec } = collectDiff(rest));
  } catch (err) {
    console.error(`Error: ${(err as Error).message}`);
    return 1;
  }
  const t0 = performance.now();
  let map = buildReviewMap(diff);
  const elapsed = performance.now() - t0;
  const queue = buildDecisions(analyzeSemantics(diff));
  const summary = decisionSummary(queue);
  const ticket = resolveRefInput(argValue(rest, "--ticket"), refIo());
  const designDoc = resolveRefInput(argValue(rest, "--doc"), refIo());
  const evidence = collectQueueEvidence(queue, buildEvidenceContext(diff, rest, ticket, designDoc));
  const wantVerify = rest.includes("--verify") || rest.includes("--static-only");
  const report = wantVerify
    ? runFullVerify(diff, { runCommands: !rest.includes("--static-only") })
    : null;
  if (report) map = applyVerification(map, report.verifiedPaths);
  const rejected = queue.filter((d) => d.status === "rejected");
  const alternatives = rejected.map((d) => generateAlternatives(d));
  const changedPaths = parseUnifiedDiff(diff).map((f) => f.path);
  const bundle = buildOutputBundle(map, queue, report, {
    evidence,
    changedFiles: changedPaths,
  });
  const symbols = symbolsForHunks(parseFileHunks(diff));
  const impactRoot = argValue(rest, "--root") ?? process.cwd();
  const testIo = repoIo(impactRoot);
  const impact = buildImpactMap(symbols, changedPaths, testIo, impactRoot);
  const risks = buildRiskFindings(queue, { evidence, impact, report });
  const overview = buildOverview(queue, map, symbols, impact, ticket, designDoc, evidence, report);
  const revision = revisionFor(spec);
  const revisionLabel = revision.sha ?? revision.ref;

  // Change-aware testing: discover → select → (generate) → (run) → (diagnose).
  const discovery = discoverTests(testIo, impactRoot);
  let selection = selectTests(changedPaths, impact, discovery.tests);
  const genFramework = (discovery.frameworks.find((f) => f === "node:test" || f === "jest" || f === "vitest") ?? "node:test") as "node:test" | "jest" | "vitest";
  const previousLines = [...new Set(queue.map((d) => d.before).filter((b) => b && /\bthrow\b/.test(b)))];
  const generated = rest.includes("--generate-tests") || rest.includes("--write-tests")
    ? generateTests(symbols, { readFile: (p) => { try { return testIo.read(p); } catch { return null; } } }, genFramework, { previousLines })
    : [];
  if (rest.includes("--write-tests")) {
    // Explicit flag = approval to create files. Each test is placed as a
    // sibling of its RESOLVED source file (root-then-cwd, the same basis
    // generation read from), with parent dirs created; display paths stay
    // repo-relative. Existing files are never overwritten (pass
    // --force-write to override — still explicit).
    const placed = generated.map((g) => {
      const srcFile = g.target.split("#")[0] as string;
      const resolvedSrc = resolveImpactPath(impactRoot, srcFile);
      if (!existsSync(resolvedSrc)) return { test: g, placed: null as string | null, why: `source \`${srcFile}\` not found under --root or cwd — nowhere to place the sibling` };
      const sib = siblingTestPath(resolvedSrc, g.framework);
      return { test: g, placed: sib, why: null as string | null };
    });
    for (const p of placed.filter((p) => !p.placed)) console.error(`Skipped ${p.test.path}: ${p.why}`);
    const writable = placed.filter((p) => p.placed).map((p) => ({ ...p.test, path: p.placed as string }));
    const written = writeGeneratedTests(writable, {
      exists: (p) => existsSync(p),
      write: (p, c) => {
        const safe = containedWritePath(impactRoot, p);
        if (!safe) throw new Error(`refused: \`${p}\` escapes the analysis scope (untrusted diff path)`);
        mkdirSync(dirname(safe), { recursive: true });
        writeFileSync(safe, c, "utf8");
      },
    }, { force: rest.includes("--force-write") });
    for (const w of written.written) console.error(`Wrote generated test ${toDisplayPath(w)} — review TODO-pins before keeping.`);
    for (const s of written.skipped) console.error(`Skipped ${s.path}: ${s.why}`);
    if (written.written.length > 0) {
      // New files exist now — re-select so --run-tests executes them too.
      const fresh = discoverTests(testIo, impactRoot);
      const reselect = selectTests(changedPaths, impact, fresh.tests);
      const known = new Set(selection.selected.map((t) => t.path));
      for (const t of reselect.selected) {
        if (!known.has(t.path)) {
          selection.selected.push(t);
          known.add(t.path);
        }
      }
      selection.selected.sort((a, b) => a.path.localeCompare(b.path));
    }
  }
  let testResults: TestResult[] = [];
  if (rest.includes("--run-tests")) {
    const timeout = parseInt(argValue(rest, "--timeout") ?? "", 10);
    testResults = await runTests(selection.selected, {
      cwd: impactRoot,
      timeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : undefined,
      revision: revisionLabel,
    });
  }
  let diagnoses: Diagnosis[] = [];
  if (rest.includes("--diagnose")) {
    const approveFix = rest.includes("--apply-fix");
    diagnoses = testResults.filter((r) => r.status === "failed").map((r) =>
      diagnoseFailure(r, {
        changedFiles: changedPaths,
        symbols,
        readFile: (p) => { try { return testIo.read(p); } catch { return null; } },
        removedGuard: removedGuardsFor(queue, guardFileFor(queue, r.path)),
      }),
    );
    for (const d of diagnoses) {
      if (d.patch) {
        const guard = removedGuardsFor(queue, d.patch.path);
        const safe = containedWritePath(impactRoot, d.patch.path);
        if (!safe) {
          console.error(`No fix applied: refused — \`${d.patch.path}\` escapes the analysis scope (untrusted diff path).`);
          continue;
        }
        const applied = applyProposedPatch({ ...d.patch, path: safe }, guard?.lines ?? [], {
          read: (p) => readFileSync(p, "utf8"),
          write: (p, c) => writeFileSync(p, c, "utf8"),
        }, { approve: approveFix });
        console.error(applied.applied ? `Fix applied to ${applied.path}: ${applied.detail}` : `No fix applied: ${applied.detail}`);
      }
    }
  }
  const savePath = argValue(rest, "--save-results");
  if (savePath) {
    try {
      writeFileSync(savePath, JSON.stringify({ version: 1, generatedAt: new Date().toISOString(), revision, results: testResults }, null, 2), "utf8");
      console.error(`Saved ${testResults.length} test result(s) to ${savePath}`);
    } catch (err) {
      console.error(`Error: cannot write ${savePath}: ${(err as Error).message}`);
      return 1;
    }
  }
  const comparePath = argValue(rest, "--compare");
  let comparison: string | null = null;
  if (comparePath) comparison = renderComparison(comparePath, testResults);
  // AI operations (explicit flags only). Privacy gate: local providers run
  // freely; cloud providers require --allow-cloud-ai / DECI_ALLOW_CLOUD_AI.
  const aiSections: AiResult[] = [];
  const aiErrors: string[] = [];
  if (rest.includes("--ai-explain") || rest.includes("--ai-diagnose")) {
    const defaultProvider = resolveProvider(providerInputFromFlags(rest), process.env);
    if (!aiAllowed(defaultProvider, rest, process.env)) {
      aiErrors.push(`Refused: cloud provider \`${defaultProvider.spec.id}\` needs explicit opt-in — pass --allow-cloud-ai or set DECI_ALLOW_CLOUD_AI=1. Repository content stays local until then.`);
    } else {
      const ctx = {
        defaultProvider,
        routes: routesFromFlags(rest) as AiContext["routes"],
        policy: policyFromFlags(rest, process.env),
        env: process.env as Record<string, string | undefined>,
      };
      if (rest.includes("--ai-explain")) {
        try {
          aiSections.push(await explainChange(ctx, {
            summary: `${overview.risk} — ${overview.riskReason}`,
            files: changedPaths,
            diffExcerpt: diff,
          }));
        } catch (err) {
          aiErrors.push(`AI explanation unavailable: ${(err as Error).message}`);
        }
      }
      if (rest.includes("--ai-diagnose")) {
        if (diagnoses.length === 0) {
          aiErrors.push(`AI diagnosis needs deterministic failures first — run with --run-tests --diagnose.`);
        }
        for (const d of diagnoses) {
          try {
            aiSections.push(await assistDiagnosis(ctx, {
              testPath: d.testPath,
              summary: d.summary,
              causes: d.causes.map((c) => `[${c.standing}] ${c.statement}`),
              logExcerpt: testResults.find((r) => r.path === d.testPath)?.output ?? "",
            }));
          } catch (err) {
            aiErrors.push(`AI diagnosis for \`${d.testPath}\` unavailable: ${(err as Error).message}`);
          }
        }
      }
    }
  }
  // US-009: provider switch is config-only; analyze never calls complete(),
  // so diff/AST stay local and only an explicit prompt would leave the machine.
  const llm = resolveProviderConfig(
    {
      provider: argValue(rest, "--provider") ?? undefined,
      openaiBaseURL: argValue(rest, "--openai-base-url") ?? undefined,
      openaiModel: argValue(rest, "--openai-model") ?? undefined,
      ollamaModel: argValue(rest, "--ollama-model") ?? undefined,
    },
    process.env,
  );
  if (rest.includes("--json")) {
    const llmJson = { ...llm, openai: { ...llm.openai, apiKey: llm.openai.apiKey ? "***" : "" } };
    console.log(JSON.stringify({ schemaVersion: 4, ...map, analysisMs: Math.round(elapsed), provider: llm.provider, llm: llmJson, inputs: { diff: spec, ticket, designDoc }, revision, verify: report, decisions: queue, decisionSummary: summary, evidence, alternatives, bundle, overview, symbols, impact, risks, discovery, selection, generated, testResults, diagnoses, ai: aiSections, aiErrors }, null, 2));
  } else {
    console.log(renderMarkdown(map));
    console.log(renderInputsMarkdown(spec, ticket, designDoc));
    console.log(renderProviderMarkdown(llm));
    console.log(renderOverviewMarkdown(overview));
    console.log(renderDecisionsMarkdown(queue));
    console.log(renderImpactMarkdown(impact));
    console.log(renderRisksMarkdown(risks));
    console.log(renderDiscoveryMarkdown(discovery));
    console.log(renderSelectionMarkdown(selection));
    if (generated.length > 0) console.log(renderGeneratedMarkdown(generated));
    if (testResults.length > 0) console.log(renderResultsMarkdown(testResults));
    for (const d of diagnoses) console.log(renderDiagnosisMarkdown(d));
    for (const a of aiSections) console.log(renderAiMarkdown(a, `AI ${a.operation}`));
    for (const e of aiErrors) console.log(`## AI unavailable\n\n${e}\n`);
    if (comparison) console.log(comparison);
    console.log(renderQueueEvidenceMarkdown(evidence));
    for (const set of alternatives) console.log(renderAlternativesMarkdown(set));
    if (report) console.log(renderVerifyMarkdown(report));
    console.log(renderBundleMarkdown(bundle));
  }
  const htmlPath = argValue(rest, "--html");
  if (htmlPath) {
    try {
      writeFileSync(htmlPath, buildReportHtml({ revision, diffText: diff, map, queue, symbols, impact, risks, overview, evidence, testPlan: bundle.testPlan, discovery, selection, testResults, generated, diagnoses, ai: aiSections.map((a) => ({ title: `AI ${a.operation}`, text: a.text, handledBy: a.handledBy, operation: a.operation })) }), "utf8");
      console.error(`Wrote interactive impact report to ${htmlPath}`);
    } catch (err) {
      console.error(`Error: cannot write ${htmlPath}: ${(err as Error).message}`);
      return 1;
    }
  }
  const failedTests = testResults.some((r) => r.status === "failed");
  const needsDecision =
    map.riskDistribution.Critical.files > 0 ||
    map.riskDistribution.High.files > 0 ||
    summary.pendingCriticalHigh > 0 ||
    failedTests;
  return needsDecision ? 2 : 0;
}

/** `deci chat`: conversation management + message sending over the real engine. */
async function runChatCommand(rest: string[]): Promise<number> {
  const { FileConversationStore } = await import("./chatStore.js");
  const { createConversation, renameConversation, validateTitle } = await import("./chat.js");
  const { ChatEngine } = await import("./chatEngine.js");
  const sub = rest[0] ?? "list";
  const storeDir = argValue(rest, "--store") ?? join(process.cwd(), ".deci", "chat");
  const root = argValue(rest, "--root") ?? process.cwd();
  const io = {
    async readFile(p: string): Promise<string | null> {
      try {
        return readFileSync(p, "utf8");
      } catch {
        return null;
      }
    },
    async writeFile(p: string, c: string): Promise<void> {
      writeFileSync(p, c, "utf8");
    },
    async deleteFile(p: string): Promise<void> {
      try {
        const { unlinkSync } = await import("node:fs");
        unlinkSync(p);
      } catch {
        /* gone */
      }
    },
    async listFiles(d: string): Promise<string[]> {
      try {
        return readdirSync(d);
      } catch {
        return [];
      }
    },
    async mkdir(d: string): Promise<void> {
      mkdirSync(d, { recursive: true });
    },
  };
  const store = new FileConversationStore(io, storeDir);
  if (sub === "new") {
    const title = argValue(rest, "--title") ?? "New conversation";
    const err = validateTitle(title);
    if (err) {
      console.error(`Error: ${err}`);
      return 1;
    }
    const conv = createConversation(title);
    await store.create(conv);
    console.log(JSON.stringify({ id: conv.id, title: conv.title }));
    return 0;
  }
  if (sub === "list") {
    const all = await store.list();
    for (const c of all) console.log(`${c.id}  ${c.title}  (${c.messageCount} msgs, updated ${c.updatedAt})`);
    return 0;
  }
  if (sub === "rename") {
    const id = argValue(rest, "--id");
    const title = argValue(rest, "--title");
    if (!id || !title) {
      console.error("Usage: deci chat rename --id ID --title TITLE");
      return 1;
    }
    const conv = await store.get(id);
    if (!conv) {
      console.error(`Conversation not found: ${id}`);
      return 1;
    }
    await store.update(renameConversation(conv, title));
    console.log(`Renamed ${id} to ${title}`);
    return 0;
  }
  if (sub === "rm") {
    const id = argValue(rest, "--id");
    if (!id) {
      console.error("Usage: deci chat rm --id ID");
      return 1;
    }
    await store.delete(id);
    console.log(`Deleted ${id}`);
    return 0;
  }
  if (sub === "send") {
    const id = argValue(rest, "--id");
    const message = argValue(rest, "--message");
    if (!id || !message) {
      console.error("Usage: deci chat send --id ID --message TEXT [--root DIR] [--store DIR] [provider flags]");
      return 1;
    }
    const engine = new ChatEngine({
      store,
      contextIo: {
        workspaceRoot: root,
        readFile: async (p: string) => {
          try {
            return readFileSync(p.startsWith("/") ? p : join(root, p), "utf8");
          } catch {
            return null;
          }
        },
        exists: async (p: string) => existsSync(p.startsWith("/") ? p : join(root, p)),
        listFiles: async (r: string) => listDiscoverFiles(r),
        git: async (args: string[]) => {
          try {
            const out = execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 10 * 1024 * 1024 }) as string;
            return { stdout: out, stderr: "", exitCode: 0 };
          } catch (e: unknown) {
            const err = e as { stdout?: string; stderr?: string; status?: number };
            return { stdout: err.stdout ?? "", stderr: err.stderr ?? "", exitCode: err.status ?? 1 };
          }
        },
        exec: async (cmd: string, args: string[], o: { cwd?: string; timeoutMs?: number } = {}) => {
          try {
            const out = execFileSync(cmd, args, { cwd: o.cwd ?? root, encoding: "utf8", timeout: o.timeoutMs ?? 60000, maxBuffer: 10 * 1024 * 1024 }) as string;
            return { stdout: out, stderr: "", exitCode: 0 };
          } catch (e: unknown) {
            const err = e as { stdout?: string; stderr?: string; status?: number };
            return { stdout: err.stdout ?? "", stderr: err.stderr ?? "", exitCode: err.status ?? 1 };
          }
        },
      },
      providerInput: providerInputFromFlags(rest),
      env: process.env as Record<string, string | undefined>,
      policy: policyFromFlags(rest, process.env as Record<string, string | undefined>),
      toolContext: {
        workspaceRoot: root,
        readFile: async (p: string) => {
          try {
            return readFileSync(p.startsWith("/") ? p : join(root, p), "utf8");
          } catch {
            return null;
          }
        },
        writeFile: async (p: string, c: string) => {
          writeFileSync(p.startsWith("/") ? p : join(root, p), c, "utf8");
        },
        exists: async (p: string) => existsSync(p.startsWith("/") ? p : join(root, p)),
        listFiles: async (r: string) => listDiscoverFiles(r),
        git: async (args: string[]) => {
          try {
            const out = execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 10 * 1024 * 1024 }) as string;
            return { stdout: out, stderr: "", exitCode: 0 };
          } catch (e: unknown) {
            const err = e as { stdout?: string; stderr?: string; status?: number };
            return { stdout: err.stdout ?? "", stderr: err.stderr ?? "", exitCode: err.status ?? 1 };
          }
        },
        exec: async (cmd: string, args: string[], o: { cwd?: string; timeoutMs?: number } = {}) => {
          try {
            const out = execFileSync(cmd, args, { cwd: o.cwd ?? root, encoding: "utf8", timeout: o.timeoutMs ?? 60000, maxBuffer: 10 * 1024 * 1024 }) as string;
            return { stdout: out, stderr: "", exitCode: 0 };
          } catch (e: unknown) {
            const err = e as { stdout?: string; stderr?: string; status?: number };
            return { stdout: err.stdout ?? "", stderr: err.stderr ?? "", exitCode: err.status ?? 1 };
          }
        },
      },
      onApprovalNeeded: async () => false,
    });
    try {
      const res = await engine.sendMessage(id, message);
      const conv = await store.get(id);
      const last = conv?.messages[conv.messages.length - 1];
      if (rest.includes("--json")) {
        console.log(JSON.stringify({ content: last?.content ?? res.message.content, blocks: res.message.blocks ?? [], warnings: res.message.blockWarnings ?? [] }, null, 2));
      } else if (res.message.blocks?.length) {
        const { renderBlocksText } = await import("./blocks.js");
        console.log(renderBlocksText(res.message.blocks));
        if (res.message.blockWarnings?.length) {
          for (const w of res.message.blockWarnings) console.error(`Block warning: ${w}`);
        }
      } else {
        console.log(last?.content ?? res.message.content);
      }
      if (res.error) {
        console.error(`chat error: ${res.error}`);
        return 1;
      }
      return 0;
    } catch (e) {
      console.error(`Error: ${(e as Error).message}`);
      return 1;
    }
  }
  console.error("Usage: deci chat {new|list|send|rename|rm} ...");
  return 1;
}

/** Provider + connection input from flags (generic) with legacy per-provider flags. Keys come from env only. */
function providerInputFromFlags(rest: string[]): ProviderInput {  return {
    provider: argValue(rest, "--provider") ?? undefined,
    baseURL: argValue(rest, "--base-url") ?? argValue(rest, "--openai-base-url") ?? undefined,
    model: argValue(rest, "--model") ?? argValue(rest, "--openai-model") ?? argValue(rest, "--ollama-model") ?? undefined,
  };
}

/** Retry/fallback policy from flags + env. */
function policyFromFlags(rest: string[], env: Record<string, string | undefined>): Policy {
  const fallback = (argValue(rest, "--fallback") ?? "")
    .split(",").map((s) => s.trim()).filter(Boolean);
  return {
    fallback,
    allowCloudFallback: rest.includes("--allow-cloud-fallback") || cleanEnv(env.DECI_ALLOW_CLOUD_FALLBACK),
  };
}

function cleanEnv(v: string | undefined): boolean {
  return v === "1" || (v ?? "").toLowerCase() === "true";
}

/** Per-operation route overrides from repeated `--route op=provider[:model]`. */
function routesFromFlags(rest: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--route" && i + 1 < rest.length) {
      const m = /^([a-z-]+)=(.+)$/.exec(rest[i + 1] as string);
      if (m) out[m[1] as string] = m[2] as string;
    }
  }
  return out;
}

/**
 * Privacy gate for AI operations: local providers always allowed;
 * cloud providers need explicit opt-in (flag or env). Repository content
 * never leaves the machine without it.
 */
function aiAllowed(resolved: { dataClass: string }, rest: string[], env: Record<string, string | undefined>): boolean {
  return resolved.dataClass === "local" || rest.includes("--allow-cloud-ai") || cleanEnv(env.DECI_ALLOW_CLOUD_AI);
}

/** `deci providers`: registry, current resolution (redacted), validation, live probe. */
async function runProvidersCommand(rest: string[]): Promise<number> {
  if (rest.includes("--json")) {
    console.log(JSON.stringify({ providers: PROVIDER_SPECS }, null, 2));
    return 0;
  }
  const lines = [
    `## Providers`,
    ``,
    `| ID | Protocol | Key | Local | JSON | Notes |`,
    `| --- | --- | --- | --- | --- | --- |`,
    ...PROVIDER_SPECS.map((s) => `| \`${s.id}\`${(s.aliases ?? []).map((a) => ` (alias: \`${a}\`)`).join("")} | ${s.protocol} | ${s.needsKey ? "required" : "none"} | ${s.local ? "yes" : "no"} | ${s.capabilities.jsonMode ? "yes" : "no"} | ${s.notes} |`),
    ``,
    `Streaming/tool calling: unsupported on all providers (no Deci feature consumes them).`,
    ``,
  ];
  console.log(lines.join("\n"));
  const resolved = resolveProvider(providerInputFromFlags(rest), process.env);
  const v = validateProvider(resolved);
  console.log(`Current: ${describeProvider(resolved)} — ${v.ok ? "config valid" : `missing: ${v.missing.join(", ")}`}.`);
  console.log(`Keys come from the environment (DECI_<PROVIDER>_API_KEY or DECI_API_KEY) — never from flags or files.`);
  console.log(``);
  if (rest.includes("--check") || rest.includes("--live")) {
    const live = rest.includes("--live");
    if (live && resolved.dataClass === "cloud") {
      console.log(`Live check probes the endpoint${resolved.spec.protocol === "anthropic-messages" ? " (Anthropic: one 1-token message — the only read probe it offers)" : ""}.`);
    }
    const h = await checkProvider(resolved, { live });
    console.log(`Check (${h.kind}): ${h.ok ? "OK" : "FAIL"} — ${h.detail}`);
    return h.ok ? 0 : 1;
  }
  console.log(`Run \`deci providers --check [--live]\` to validate connectivity.`);
  return v.ok ? 0 : 1;
}

/** Source file a test most likely guards: sibling match wins, else itself. */
function guardFileFor(queue: Array<{ file: string }>, testPath: string): string {
  const hit = queue.find((d) => {
    const sib = guessTestPath(d.file);
    return sib === testPath || testPath.endsWith(`/${sib}`) || sib.endsWith(`/${testPath}`);
  });
  return hit?.file ?? testPath;
}

/** Historical comparison: previous run record vs current results. */
function renderComparison(prevPath: string, current: TestResult[]): string {
  let prev: { results?: TestResult[] };
  try {
    prev = JSON.parse(readFileSync(prevPath, "utf8")) as { results?: TestResult[] };
  } catch (err) {
    return `## Run comparison\n\nCannot read ${prevPath}: ${(err as Error).message}\n`;
  }
  const before = new Map((prev.results ?? []).map((r) => [r.path, r]));
  const lines: string[] = [];
  for (const r of current) {
    const p = before.get(r.path);
    if (!p) {
      lines.push(`- \`${r.path}\`: new in this run — ${r.status}.`);
    } else if (p.status !== r.status) {
      lines.push(`- \`${r.path}\`: ${p.status} → **${r.status}** (exit ${p.exitCode ?? "—"} → ${r.exitCode ?? "—"}).`);
    } else {
      lines.push(`- \`${r.path}\`: still ${r.status} (${p.durationMs}ms → ${r.durationMs}ms).`);
    }
  }
  for (const p of before.keys()) {
    if (!current.some((r) => r.path === p)) lines.push(`- \`${p}\`: not run this time.`);
  }
  return [`## Run comparison (vs ${prevPath})`, ``, ...lines, ``].join("\n");
}

/** Fs-backed ref io shared by --ticket/--doc. Remote warns, never blocks. */
function refIo(): { exists: (p: string) => boolean; read: (p: string) => string; onRemote: (r: string) => void } {
  return {
    exists: (p) => {
      try {
        return existsSync(p);
      } catch {
        return false;
      }
    },
    read: (p) => readFileSync(p, "utf8"),
    onRemote: (r) => console.error(`Warning: cannot fetch remote ref ${r} in MVP — marked missing, analysis continues.`),
  };
}

/** Thin I/O adapter over the pure evidence core: fs + git log, all failure-safe. */
function buildEvidenceContext(diffText: string, args: string[], ticket: TicketInput, designDoc: TicketInput): EvidenceContext {
  let changedFiles: string[] = [];
  try {
    changedFiles = parseUnifiedDiff(diffText).map((f) => f.path);
  } catch {
    changedFiles = [];
  }
  const candidates = ["README.md", "docs", "ADR.md", "ADRs", "design", "DESIGN.md"];
  const docPaths = [
    ...changedFiles.filter((p) => /^(docs?|adr|adrs|design)(\/|$)|^README|\.md$/i.test(p)),
    ...candidates.filter((p) => existsSync(p)),
  ].slice(0, 10);
  return {
    changedFiles,
    fileExists: (p) => {
      try {
        return existsSync(p);
      } catch {
        return false;
      }
    },
    readExcerpt: (p) => {
      try {
        return readFileSync(p, "utf8").slice(0, 500);
      } catch {
        return null;
      }
    },
    gitLogFor: (p) => {
      try {
        // argv, no shell: the `--` keeps an adversarial path from becoming an option.
        const out = execFileSync("git", ["log", "--oneline", "-5", "--", p], { encoding: "utf8", timeout: 15000, stdio: ["ignore", "pipe", "pipe"] }) as string;
        return out.split("\n").map((l) => l.trim()).filter(Boolean);
      } catch {
        return [];
      }
    },
    docPaths,
    ticket,
    designDoc,
  };
}

/** Display an absolute path relative to cwd when inside it. */
function toDisplayPath(p: string): string {
  const rel = relative(process.cwd(), p);
  return rel.startsWith("..") || rel === "" ? p : rel;
}

/** Resolve a display path back for reading (handles --root outside cwd). */
function resolveImpactPath(root: string, p: string): string {
  if (p.startsWith("/") || /^[A-Za-z]:\\/.test(p)) return p;
  const underRoot = resolve(root, p);
  if (existsSync(underRoot)) return underRoot;
  return resolve(process.cwd(), p);
}

/**
 * Write containment: diff paths are untrusted input (a malicious diff can
 * name `../../outside`). Refuse any write that escapes BOTH the analysis
 * root and the invocation directory. Reads are unaffected (analysis must
 * read whatever the diff names; exfiltration is gated separately by the
 * AI privacy policy).
 */
export function containedWritePath(root: string, p: string): string | null {
  const target = p.startsWith("/") || /^[A-Za-z]:\\/.test(p) ? p : resolve(root, p);
  const norm = resolve(target);
  for (const base of [resolve(root), process.cwd()]) {
    if (norm === base || norm.startsWith(base.endsWith("/") ? base : `${base}/`)) return norm;
  }
  return null;
}

/** Analyzed-revision metadata for staleness banners. Never throws; unknown rev is disclosed, not faked. */
function revisionFor(spec: ReturnType<typeof parseDiffArgs>): RevisionInfo {
  const ref = describeDiffSpec(spec);
  const analyzedAt = new Date().toISOString();
  try {
    const sha = (execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", timeout: 10000 }) as string).trim();
    let dirty = false;
    try {
      dirty = ((execFileSync("git", ["status", "--porcelain"], { encoding: "utf8", timeout: 10000 }) as string).trim().length > 0);
    } catch {
      dirty = false;
    }
    return { ref, sha: sha || null, dirty, analyzedAt };
  } catch {
    return { ref, sha: null, dirty: false, analyzedAt };
  }
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(`Error: ${(err as Error).message}`);
    process.exit(1);
  },
);
