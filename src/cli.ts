#!/usr/bin/env node
// Thin CLI over core (US-010 subset for US-001): analyze only, no implement/verify-write.
import { execSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { buildReviewMap, parseUnifiedDiff, renderMarkdown } from "./reviewMap.js";
import { analyzeSemantics } from "./semantic.js";
import {
  collectDiffText,
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
  renderDecisionsMarkdown,
} from "./decisions.js";
import { applyVerification, renderVerifyMarkdown, runFullVerify } from "./verify.js";
import { buildOutputBundle, renderBundleMarkdown } from "./bundle.js";
import {
  renderProviderMarkdown,
  resolveProviderConfig,
} from "./llm.js";

function usage(): string {
  return `Usage: changepilot analyze [--diff <range>] [--range <range>] [--base <branch>] [--staged] [--file <path>] [--ticket <url|id|path|text>] [--doc <url|path|text>] [--json] [--verify] [--static-only] [--provider <openai-byok|ollama|vscode-lm>] [--openai-model <m>] [--ollama-model <m>] [--openai-base-url <url>]\n\nDiff: working tree (default, git diff HEAD), --staged, or branch-vs-base (--diff/--range/--base, local git only). No git repo? use --file <diff|source-file|folder>.\nExit codes: 0 clean/low, 2 decisions-required (Critical/High present), 1 error.`;
}

function argValue(args: string[], flag: string): string | null {
  const i = args.indexOf(flag);
  return i >= 0 && i + 1 < args.length ? (args[i + 1] as string) : null;
}

function listFilesRecursive(root: string): string[] | null {
  let st: ReturnType<typeof statSync>;
  try {
    st = statSync(root);
  } catch {
    return null;
  }
  if (!st.isDirectory()) return null;
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir)) {
      const p = join(dir, e);
      try {
        if (statSync(p).isDirectory()) {
          if (e === "node_modules" || e === ".git" || e === "dist") continue;
          walk(p);
        } else out.push(p);
      } catch {
        continue;
      }
    }
  };
  try {
    walk(root);
  } catch {
    return null;
  }
  return out.slice(0, 50);
}

function collectDiff(args: string[]): { text: string; spec: ReturnType<typeof parseDiffArgs> } {
  const spec = parseDiffArgs(args);
  const text = collectDiffText(spec, {
    exec: (cmd) => execSync(cmd, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }),
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

function main(): number {
  const [, , command, ...rest] = process.argv;
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
  const bundle = buildOutputBundle(map, queue, report, {
    evidence,
    changedFiles: parseUnifiedDiff(diff).map((f) => f.path),
  });
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
    console.log(JSON.stringify({ ...map, analysisMs: Math.round(elapsed), provider: llm.provider, llm: llmJson, inputs: { diff: spec, ticket, designDoc }, verify: report, decisions: queue, decisionSummary: summary, evidence, alternatives, bundle }, null, 2));
  } else {
    console.log(renderMarkdown(map));
    console.log(renderInputsMarkdown(spec, ticket, designDoc));
    console.log(renderProviderMarkdown(llm));
    console.log(renderDecisionsMarkdown(queue));
    console.log(renderQueueEvidenceMarkdown(evidence));
    for (const set of alternatives) console.log(renderAlternativesMarkdown(set));
    if (report) console.log(renderVerifyMarkdown(report));
    console.log(renderBundleMarkdown(bundle));
  }
  const needsDecision =
    map.riskDistribution.Critical.files > 0 ||
    map.riskDistribution.High.files > 0 ||
    summary.pendingCriticalHigh > 0;
  return needsDecision ? 2 : 0;
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
        const out = execSync(`git log --oneline -5 -- ${JSON.stringify(p)}`, { encoding: "utf8", timeout: 15000 });
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

process.exit(main());
