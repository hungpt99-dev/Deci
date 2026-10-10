# Deci

**Deci — AI-powered engineering decision support for software changes.**

> Deci helps developers, reviewers, and architects understand the impact of software changes, evaluate risks and alternatives, and make confident engineering decisions.

Deci focuses on:

* change understanding
* impact analysis
* risk analysis
* engineering alternatives
* test planning
* rollback planning
* verification
* engineering decision support

Deci is **not** just an AI code reviewer, an AI coding agent, a pre-commit script, a static analyzer, a generic RAG system, or an MCP wrapper.

## Why Deci?

AI can generate code faster, but faster changes raise the stakes for understanding consequences.

Not only:

> "Can AI generate this change?"

but:

> "Do we understand the impact, risks, alternatives, and verification strategy for this change?"

Deci exists to answer the second question. It compresses a large diff into a small set of engineering decisions a human actually needs to review.

## What Deci does

Given a code change plus available requirement/design context, Deci produces:

* **Review Map** — files, modules, services touched; risk distribution (Critical / High / Medium / Low / Verified); estimated human review time vs. full-diff time
* **Semantic findings** — behavior, architecture, data, security, reliability, performance changes with before/after, impact, and confidence
* **Ranked decision points** — Accept / Reject / Investigate queue with evidence links
* **Evidence** — local code, tests, git history, docs/ADRs, contracts, schema/config, plus ticket and design-doc excerpts when provided
* **Alternatives** — 2–3 options with trade-offs on Reject + constraint
* **Implementation plan + patch** — via local adapter only in MVP, followed by re-verification
* **Output bundle** — impact summary, risk classification, test plan (ran + to-add), rollback plan as **text only**

Conceptual workflow:

```text
Code Change
    ↓
Git Diff + Ticket + Design / ADR
    ↓
Change Intelligence
    ↓
Impact Analysis
    ↓
Risk Analysis
    ↓
Constraints / Existing Knowledge
    ↓
Alternative Approaches
    ↓
Test Plan
    ↓
Rollback Plan
    ↓
Verification
    ↓
Engineering Decision
```

### Implemented vs. in-progress

Honest status for this MVP snapshot:

* **Implemented:** Review Map heuristics, semantic rule engine with TS + Java adapters (pattern-based, see Limitations), local verification runners, decision queue with Accept/Reject/Investigate, local evidence collection, alternative templates, local patch adapter, text-only rollback, LLM provider switch (config + routing), CLI `analyze`, VS Code view models + extension host wiring.
* **Heuristic, not full AST:** `src/semantic.ts` and `src/reviewMap.ts` use deterministic regex / rule heuristics behind a pluggable adapter interface. Real parsers can plug in without a core rewrite, but are not bundled here.
* **No backend:** local-first core; VS Code extension + thin CLI are adapters over the same core.
* **No auto-revert, no autonomous deploy.**

## Who is Deci for?

Same Deci capability, three perspectives. Not three separate products.

### Developer

> How should I change this safely?

Understand codebase, discover hidden dependencies, identify risks, compare approaches, validate a decision.

### Reviewer

> What does this change affect, and what could go wrong?

See what changed, why, what is affected, what risks exist, whether implementation matches design, and what to focus on — instead of reconstructing the author's reasoning from a raw diff.

### Architect / Tech Lead

> Is this approach appropriate, and what are the trade-offs?

Architecture impact, dependency analysis, design consistency, ADR validation, cross-service impact, technical risk, alternative designs.

## Example

Illustrative synthetic example (not a real customer change):

```text
Change Analysis

Impact
- PaymentService
- PaymentController
- PaymentRepository
- API consumers

Risks
- Duplicate payment
- Transaction boundary
- API compatibility

Options

A. Redis Idempotency
   + Fast
   + Simple
   - Additional infrastructure

B. Database Constraint
   + Strong consistency
   + Simple
   - Possible DB contention

C. Idempotency Table
   + Durable
   + Auditable
   - More implementation complexity

Recommendation
B

Test Plan
- Concurrent requests
- Duplicate requests
- Retry scenarios

Rollback Plan
- Revert migration
- Disable feature flag
```

Actual CLI output shape (verified with `node dist/cli.js analyze --file <diff>`):

```text
# Review Map
**3 LOC** changed across **1 files** ...
## Decisions (2)
...
## LLM Provider
Provider: ollama (...) — local — ready.
```

## Key capabilities

* Local-first diff + ticket + design-doc inputs (remote refs marked missing, never block)
* Multi-language-oriented core; TypeScript and Java adapters ship by default
* Per-language verification: build, unit tests, lint, format, API-schema check, forbidden-dependency check
* Decisions never silently dropped: uncertain items surface as decisions
* Verified low-risk files collapse into an expandable Verified bucket
* Provider switch: OpenAI-compatible BYOK, Ollama local, VS Code LM API
* Impact tracing: changed symbols → referencing files with `import-resolved` / `textual` evidence (same-name alone never creates an edge)
* Risk findings carry location, failure scenario, mitigation, and a suggested test; standing is `confirmed` / `potential` / `hypothesis`
* Self-contained interactive HTML impact report (`--html`) — diff with line anchors, Explanation/Impact/Risks/Tests tabs, finding navigation

## Impact report

Generate a single-file interactive report (no server, no network, works from disk) and open it in a browser:

```bash
node dist/cli.js analyze --file ./verify-e2e-004.diff --html ./report.html
# Scope impact tracing to a subtree:
node dist/cli.js analyze --root ./fixtures/shop --file ./fixtures/shop/regression.diff --html ./report.html
```

The report shows the analyzed revision in a staleness banner (line numbers refer to the analyzed revision — re-run after new changes), highlights the exact lines behind each finding, and discloses coverage gaps and language capabilities at the bottom. The same HTML renders in VS Code via the `deci.showImpactReport` command.

Try the three fixture scenarios (verified end-to-end in `src/fixtures.test.ts`):

```bash
node dist/cli.js analyze --root ./fixtures/shop --file ./fixtures/shop/safe.diff        # exit 0, no Critical/High
node dist/cli.js analyze --root ./fixtures/shop --file ./fixtures/shop/regression.diff  # exit 2, cart.ts caller traced
node dist/cli.js analyze --root ./fixtures/shop --file ./fixtures/shop/uncertain.diff   # exit 0, hypothesis + unknowns
```

## Language capabilities

| Language | Symbols | Call refs | Types | Contracts | Tests | Traversal |
|---|---|---|---|---|---|---|
| TypeScript / JS | heuristic | heuristic | heuristic | heuristic | heuristic | heuristic |
| Java | heuristic | heuristic | heuristic | heuristic | heuristic | heuristic |
| Other | — | — | — | heuristic (paths) | heuristic (sibling names) | — |

"Heuristic" means pattern-based, not parsed: re-exports, dynamic calls, overloads, and hierarchies may be missed, and every gap of that kind is reported in the analysis rather than silently skipped.

## Quick Start

Prerequisites:

* Node.js `>=20` (see `engines` in `package.json`)
* Git (for diff inputs from a repo)
* Optional: Ollama daemon for local LLM, or an OpenAI-compatible endpoint

Clone and set up:

```bash
git clone https://github.com/hungpt99-dev/Deci.git
cd Deci
npm install
npm run build
npm test
```

Analyze a change (verified commands):

```bash
# From a git repo — working tree vs HEAD
node dist/cli.js analyze

# Staged changes
node dist/cli.js analyze --staged

# Branch range
node dist/cli.js analyze --diff main...HEAD

# Single file / folder fallback (works with no git repo; raw source files accepted, not just diffs)
node dist/cli.js analyze --file ./verify-e2e-004.diff

# With ticket / design context (local paths preferred)
node dist/cli.js analyze --ticket ./ticket.md --doc ./design.md

# JSON output
node dist/cli.js analyze --file ./verify-e2e-004.diff --json

# With static + command verification
node dist/cli.js analyze --file ./verify-e2e-004.diff --verify
node dist/cli.js analyze --file ./verify-e2e-004.diff --static-only
```

Exit codes: `0` clean/low, `2` decisions-required (Critical/High present, or any selected test failed), `1` error.

## Change-aware testing (verified commands)

Discover tests, select change-relevant ones, generate scaffolds, execute with real tools, diagnose failures:

```bash
# Discover tests under a root (categories, frameworks, run commands)
node dist/cli.js tests --root ./fixtures/calc

# Full workflow on a scratch copy (keeps the repo clean).
# fixtures/calc/change.diff removes the upper-bound guard — a real regression.
rm -rf /tmp/deci-demo && cp -r fixtures/calc /tmp/deci-demo
node dist/cli.js analyze --root /tmp/deci-demo --file fixtures/calc/change.diff \
  --generate-tests --write-tests --run-tests --diagnose --html /tmp/demo.html
# → prints scaffolds, writes calc.test.mjs (never overwrites), runs node --test
#   for real, diagnoses the guard regression, proposes (not applies) the patch

# Apply a proposed guard patch (explicit approval — otherwise refused)
node dist/cli.js analyze --root /tmp/deci-demo --file fixtures/calc/change.diff \
  --run-tests --diagnose --apply-fix

# Persist results and compare runs over time
node dist/cli.js analyze --root /tmp/deci-demo --file fixtures/calc/change.diff \
  --run-tests --save-results /tmp/run1.json
node dist/cli.js analyze --root /tmp/deci-demo --file fixtures/calc/change.diff \
  --run-tests --save-results /tmp/run2.json --compare /tmp/run1.json
```

Execution model: test commands run shell-free with the project's own tools, one per test file (directly-runnable frameworks) or via the project's script fallback, each time-boxed (`--timeout`), secrets redacted from logs, every result stamped with the analyzed revision. TypeScript tests run from verified compiled output (tsconfig `outDir`, existence-checked). Isolation is same-user process isolation (cwd confinement, timeouts, no shell) — not containers; review generated code before `--write-tests`, and never `--apply-fix` without reading the proposed diff.

VS Code: this repo contains `src/vscode/extension.ts` (editor-agnostic core) plus `src/vscode/host.ts` (real host entry, `package.json` main). Install the packaged extension:

```bash
npm run build
npm run package   # produces deci-<version>.vsix via vsce
code --install-extension deci-0.1.0.vsix
```

Or in VS Code: Extensions view → `...` → Install from VSIX. Marketplace publishing is not configured — see Roadmap.

## Configuration

All fields optional unless noted. Precedence: explicit settings/flags → environment → defaults.

| Setting / Flag | Env | Default | Required? |
|---|---|---|---|
| `deci.provider` / `--provider` | `DECI_PROVIDER` | `ollama` | No |
| `deci.openai.baseURL` / `--openai-base-url` | `DECI_OPENAI_BASE_URL` | `https://api.openai.com/v1` | Yes for `openai-byok` |
| `deci.openai.apiKey` | `DECI_OPENAI_API_KEY` | `""` | Yes for `openai-byok` |
| `deci.openai.model` / `--openai-model` | `DECI_OPENAI_MODEL` | `gpt-4o-mini` | Yes for `openai-byok` |
| `deci.ollama.baseURL` | `DECI_OLLAMA_BASE_URL` | `http://localhost:11434` | Yes for `ollama` |
| `deci.ollama.model` / `--ollama-model` | `DECI_OLLAMA_MODEL` | `llama3.1` | Yes for `ollama` |
| `deci.vscodeLm.model` | `DECI_VSCODE_LM_MODEL` | editor default | No |

Examples:

```bash
# BYOK (OpenAI-compatible)
export DECI_PROVIDER=openai-byok
export DECI_OPENAI_BASE_URL=https://api.openai.com/v1
export DECI_OPENAI_API_KEY=YOUR_API_KEY
export DECI_OPENAI_MODEL=gpt-4o-mini

# Ollama local
export DECI_PROVIDER=ollama
export DECI_OLLAMA_BASE_URL=http://localhost:11434
export DECI_OLLAMA_MODEL=llama3.1
```

API keys live only in your environment / VS Code settings — never commit them. CLI JSON output redacts the key as `"***"`. See Privacy.

## AI Providers

Deci's AI calls go through a provider-agnostic layer (`src/providers.ts`): one registry, four wire protocols, no vendor SDKs. Switching providers never requires code changes.

| Provider ID | Protocol | Key | Local | JSON mode | Notes |
|---|---|---|---|---|---|
| `openai` (alias `openai-byok`) | OpenAI chat | required | no | yes | Chat Completions API |
| `anthropic` | Anthropic messages | required | no | no | `x-api-key` auth; no native JSON mode |
| `gemini` | Gemini generate | required | no | yes | key as `?key=` query param |
| `openai-compatible` | OpenAI chat | required | no | yes | any custom base URL; verified per-endpoint |
| `openrouter` | OpenAI chat | required | no | yes | gateway; `vendor/model` ids |
| `litellm` | OpenAI chat | required | no | yes | self-hosted proxy (default `localhost:4000`) |
| `ollama` | Ollama chat | none | yes | no | local daemon (default `localhost:11434`) |
| `vllm` | OpenAI chat | optional | yes | no | self-hosted server (default `localhost:8000/v1`) |
| `vscode-lm` | editor | none | — | no | editor entitlement; never HTTP (VS Code only) |

Streaming and tool calling are unsupported on all providers — no Deci feature consumes them, and requesting either fails loudly instead of pretending.

Configuration (flags → `DECI_*` env → defaults; keys from env only):

```bash
deci providers                                  # registry + current resolution (redacted)
deci providers --check                          # validate config, no network
deci providers --check --live                   # probe the endpoint (Anthropic: one 1-token message)
export DECI_PROVIDER=anthropic
export DECI_ANTHROPIC_API_KEY=YOUR_KEY          # or DECI_API_KEY for any provider
export DECI_ROUTE_FIX=openai:gpt-4o            # per-operation override (explain|impact|test-plan|test-gen|diagnose|fix)
export DECI_FALLBACK=openai,ollama              # ordered fallback (capability + privacy gated)
```

AI features (`--ai-explain`, `--ai-diagnose`) record which provider/model answered (`handledBy`) and render AI text in a labeled section, separate from deterministic findings. Privacy policy, enforced: local providers run freely; cloud providers require `--allow-cloud-ai` / `DECI_ALLOW_CLOUD_AI=1`, otherwise the call is refused before any content leaves the machine. Local primaries never fall back to cloud unless `--allow-cloud-fallback` is explicit. Retries are bounded (retryable errors only: rate limits, network, timeouts, 5xx) with backoff.

Live verification: mocked contract tests run in `npm test`; real connectivity is opt-in (`DECI_LIVE_SMOKE=1`, free for local/list endpoints; Anthropic live check costs one 1-token message). Mocked ≠ connected — the docs never claim otherwise.

## Architecture

```text
VS Code / CLI
      ↓
Deci Core (local, pure where possible)
      ├── Git diff inputs (inputs.ts)
      ├── Review Map (reviewMap.ts)
      ├── Semantic rules + language adapters (semantic.ts)
       ├── Decisions queue (decisions.ts)
       ├── Evidence (evidence.ts)
       ├── Alternatives (alternatives.ts)
       ├── Verification (verify.ts)
       ├── Output bundle (bundle.ts)
       ├── Changed symbols (symbols.ts)
       ├── Impact tracing (impact.ts)
       ├── Risk findings (risks.ts)
       ├── Change overview (overview.ts)
       ├── Test discovery (discover.ts)
       ├── Test selection (select.ts)
       ├── Test execution (run.ts)
       ├── Test generation (generate.ts)
       ├── Failure diagnosis (diagnose.ts)
       ├── Interactive HTML report (report.ts)
       ├── Provider registry + adapters (providers.ts)
       ├── AI operations (operations.ts)
       ├── Implementation adapter, local only (implement.ts)
       ├── Panels / view models (panels.ts)
       └── LLM provider switch (llm.ts)
```

Key files: `src/cli.ts`, `src/vscode/extension.ts`, `src/index.ts` (barrel). Tests sit next to sources as `*.test.ts`; build with `tsc` to `dist/`.

## Privacy

Verified from implementation (`src/llm.ts`, `src/cli.ts`, `src/inputs.ts`):

* Diff/AST/review/verify/evidence/test processing runs locally. `analyze` calls an AI provider only with explicit flags (`--ai-explain`, `--ai-diagnose`) — and then only the shown prompt text, only to the configured endpoint, only within the privacy policy above (local freely, cloud only with opt-in).
* Only the explicit `messages` passed to a completion leave the machine, and only to the configured provider endpoint: OpenAI-family posts `<baseURL>/chat/completions`, Anthropic posts `<baseURL>/v1/messages`, Gemini posts `generateContent?key=`, Ollama posts `<baseURL>/api/chat` (local host by default), `vscode-lm` delegates to the editor with no HTTP.
* Log/panel rendering uses `describeConfig()`, which reports key as `set`/`missing`, never the value.
* Ticket/doc refs: local paths are read (capped excerpts); remote URLs are **not** fetched in MVP — marked missing with a stderr warning, analysis continues.
* `git log` excerpts are local-only; evidence reads are capped (e.g. 500 chars per file in CLI adapter).
* Git subprocesses run shell-free (argv + `--` pathspec separator); `--diff` ranges are allowlist-validated, so metacharacters fail with an error instead of executing.
* No telemetry, no backend, no cloud account in this snapshot. Maintainer should verify before claiming otherwise.

Do not paste secrets into tickets, diffs, or logs you share in issues.

## Limitations

* **Heuristic semantics:** classification is pattern-based, not a full AST parse. Expect false positives/negatives on unusual code shapes.
* **Line numbers** come from unified-diff `@@` headers (empty hunk lines count as context) — they locate the changed line, not a symbol definition. Pure removals carry `line: null`.
* **`before` context** is the nearest hunk-local removed line; pure additions report an empty `before` rather than an unrelated line.
* **Impact tracing** needs observed textual references; re-exports, dynamic calls, overloads, and files outside the scan cap (200 files, `--root` to scope) are reported as coverage gaps, not silently skipped.
* **Risk standing:** `confirmed` only when a failing check names the file; otherwise `potential` (rule match) or `hypothesis` (uncertain). Confidence is match strength, not failure probability.
* **Report staleness:** the HTML report is a snapshot — line numbers refer to the analyzed revision; re-run after new changes.
* **Test execution:** commands run shell-free with per-file argv (directly-runnable frameworks) or the project's own script fallback; each run is time-boxed and stamped with the revision. Isolation is same-user process isolation — not containers. `--write-tests` never overwrites; `--apply-fix` requires the explicit flag.
* **Test generation:** scaffolds assert structure, observed guards, and previous-behavior pins; expected values beyond those are marked `TODO-pin` for a human. JS targets get plain-JS output (no type syntax). Invalid-input probes cast to declared types (`as unknown as T`, `as never` fallback) so strict `tsc` builds keep passing — but run your type gate to confirm.
* **Diagnosis:** causes are `confirmed` only with stack/symbol evidence in changed code, else `hypothesis`. Mechanical patches are proposed only for recognized patterns (removed-guard restore); anything else must be human-authored.
* **Write scope:** `--write-tests` places siblings next to the resolved source and refuses paths escaping the analysis scope; `--apply-fix` is containment-checked the same way. `--html`/`--save-results` destinations are your explicit choice and are unrestricted.
* **Discovery scope:** build output, VCS metadata, and agent-harness worktrees (`.kilo`, `.opencode`, `.agents`, `.cursor`, `worktrees`) are never scanned.
* **Languages:** TS/JS + Java paths hardened; other languages fall back to generic rules.
* **LLM accuracy:** summaries/alternatives depend on the configured provider and model; confidence scores are heuristics.
* **Provider surface:** the VS Code settings UI exposes the original three providers (`openai-byok`, `ollama`, `vscode-lm`); all nine registry providers are available via CLI/env. The extension resolves through the same adapters, so behavior is identical where the surfaces overlap.
* **Large repos:** whole-repo scans are capped (e.g. 50 files in CLI folder fallback); very large diffs may be slow or truncated by the 64 MiB git buffer.
* **External context:** remote tickets/docs are not fetched; missing evidence is normal without local files.
* **Dependency understanding:** forbidden-dependency check is a substring deny-list (`event-stream`, `node-ipc`, `left-pad`, `faker`); not a full SCA/SBOM.
* **Verification commands** (`npx tsc --noEmit`, `npm test`, `./gradlew ...`, `npx eslint`, `prettier --check`) must exist in the target checkout or those checks fail/skip.

## Roadmap

* **Current:** local Review Map, semantic heuristics + TS/Java adapters, full verify per language, decision queue + evidence, Alternative Studio templates, local patch adapter + re-verify, text-only rollback, CLI `analyze`, provider switch, symbol extraction + impact tracing + risk findings + change overview + self-contained HTML impact report (`--html`), fixture scenarios (`fixtures/shop`), change-aware testing (`deci tests`, `--run-tests`, `--generate-tests`, `--diagnose`, `--apply-fix`, `--save-results`/`--compare`), runnable fixture (`fixtures/calc`).
* **Planned:** real parser-backed adapters, `.vsix` packaging + marketplace docs, richer contract/schema diffing, opt-in remote ticket/doc fetch.
* **Exploring:** team review workflows, decision-memory persistence, broader language coverage.

Not promises — directions only.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md).

## Security

See [SECURITY.md](./SECURITY.md). Do not report vulnerabilities in public issues.

## License

MIT — see [LICENSE](./LICENSE). `package.json` declares `MIT`; the license file in this repo is authoritative for the public release.
