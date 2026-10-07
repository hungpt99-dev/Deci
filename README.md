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

# Single file / folder fallback (works with no git repo)
node dist/cli.js analyze --file ./verify-e2e-004.diff

# With ticket / design context (local paths preferred)
node dist/cli.js analyze --ticket ./ticket.md --doc ./design.md

# JSON output
node dist/cli.js analyze --file ./verify-e2e-004.diff --json

# With static + command verification
node dist/cli.js analyze --file ./verify-e2e-004.diff --verify
node dist/cli.js analyze --file ./verify-e2e-004.diff --static-only
```

Exit codes: `0` clean/low, `2` decisions-required (Critical/High present), `1` error.

VS Code: this repo contains `src/vscode/extension.ts` and `changepilot.*` view/command contributions in `package.json`. Packaging (`.vsix`) and marketplace publishing are not configured in this snapshot — see Roadmap.

> Naming note: the public project brand is **Deci**. The npm package name, CLI binary (`changepilot`), VS Code view/command IDs (`changepilot.*`), and config keys (`changepilot.provider`, `CHANGEPILOT_*` env vars) currently use the earlier `ChangePilot` identifier. Source identifiers were intentionally left untouched for this release.

## Configuration

All fields optional unless noted. Precedence: explicit settings/flags → environment → defaults.

| Setting / Flag | Env | Default | Required? |
|---|---|---|---|
| `changepilot.provider` / `--provider` | `CHANGEPILOT_PROVIDER` | `ollama` | No |
| `changepilot.openai.baseURL` / `--openai-base-url` | `CHANGEPILOT_OPENAI_BASE_URL` | `https://api.openai.com/v1` | Yes for `openai-byok` |
| `changepilot.openai.apiKey` | `CHANGEPILOT_OPENAI_API_KEY` | `""` | Yes for `openai-byok` |
| `changepilot.openai.model` / `--openai-model` | `CHANGEPILOT_OPENAI_MODEL` | `gpt-4o-mini` | Yes for `openai-byok` |
| `changepilot.ollama.baseURL` | `CHANGEPILOT_OLLAMA_BASE_URL` | `http://localhost:11434` | Yes for `ollama` |
| `changepilot.ollama.model` / `--ollama-model` | `CHANGEPILOT_OLLAMA_MODEL` | `llama3.1` | Yes for `ollama` |
| `changepilot.vscodeLm.model` | `CHANGEPILOT_VSCODE_LM_MODEL` | editor default | No |

Examples:

```bash
# BYOK (OpenAI-compatible)
export CHANGEPILOT_PROVIDER=openai-byok
export CHANGEPILOT_OPENAI_BASE_URL=https://api.openai.com/v1
export CHANGEPILOT_OPENAI_API_KEY=YOUR_API_KEY
export CHANGEPILOT_OPENAI_MODEL=gpt-4o-mini

# Ollama local
export CHANGEPILOT_PROVIDER=ollama
export CHANGEPILOT_OLLAMA_BASE_URL=http://localhost:11434
export CHANGEPILOT_OLLAMA_MODEL=llama3.1
```

API keys live only in your environment / VS Code settings — never commit them. CLI JSON output redacts the key as `"***"`. See Privacy.

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
      ├── Implementation adapter, local only (implement.ts)
      ├── Panels / view models (panels.ts)
      └── LLM provider switch (llm.ts)
```

Key files: `src/cli.ts`, `src/vscode/extension.ts`, `src/index.ts` (barrel). Tests sit next to sources as `*.test.ts`; build with `tsc` to `dist/`.

## Privacy

Verified from implementation (`src/llm.ts`, `src/cli.ts`, `src/inputs.ts`):

* Diff/AST/review/verify/evidence processing runs locally. `analyze` never calls an LLM completion — provider resolution is config-only in the CLI path.
* Only the explicit `messages` passed to `complete()` leave the machine, and only to the configured provider endpoint: BYOK posts to `<baseURL>/chat/completions`, Ollama posts to `<baseURL>/api/chat` (local host by default), `vscode-lm` delegates to the editor with no HTTP.
* Log/panel rendering uses `describeConfig()`, which reports key as `set`/`missing`, never the value.
* Ticket/doc refs: local paths are read (capped excerpts); remote URLs are **not** fetched in MVP — marked missing with a stderr warning, analysis continues.
* `git log` excerpts are local-only; evidence reads are capped (e.g. 500 chars per file in CLI adapter).
* No telemetry, no backend, no cloud account in this snapshot. Maintainer should verify before claiming otherwise.

Do not paste secrets into tickets, diffs, or logs you share in issues.

## Limitations

* **Heuristic semantics:** classification is pattern-based, not a full AST parse. Expect false positives/negatives on unusual code shapes.
* **Languages:** TS/JS + Java paths hardened; other languages fall back to generic rules.
* **LLM accuracy:** summaries/alternatives depend on the configured provider and model; confidence scores are heuristics.
* **Large repos:** whole-repo scans are capped (e.g. 50 files in CLI folder fallback); very large diffs may be slow or truncated by the 64 MiB git buffer.
* **External context:** remote tickets/docs are not fetched; missing evidence is normal without local files.
* **Dependency understanding:** forbidden-dependency check is a substring deny-list (`event-stream`, `node-ipc`, `left-pad`, `faker`); not a full SCA/SBOM.
* **Verification commands** (`npx tsc --noEmit`, `npm test`, `./gradlew ...`, `npx eslint`, `prettier --check`) must exist in the target checkout or those checks fail/skip.

## Roadmap

* **Current:** local Review Map, semantic heuristics + TS/Java adapters, full verify per language, decision queue + evidence, Alternative Studio templates, local patch adapter + re-verify, text-only rollback, CLI `analyze`, provider switch.
* **Planned:** real parser-backed adapters, `.vsix` packaging + marketplace docs, richer contract/schema diffing, opt-in remote ticket/doc fetch.
* **Exploring:** team review workflows, decision-memory persistence, broader language coverage.

Not promises — directions only.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md).

## Security

See [SECURITY.md](./SECURITY.md). Do not report vulnerabilities in public issues.

## License

MIT — see [LICENSE](./LICENSE). `package.json` declares `MIT`; the license file in this repo is authoritative for the public release.
