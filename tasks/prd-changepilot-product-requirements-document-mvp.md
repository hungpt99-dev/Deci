# ChangePilot — Product Requirements Document (MVP)

## 1. Overview

**Product name:** ChangePilot
**One-liner:** Turn massive AI-generated code changes into a small set of engineering decisions humans actually need to review.
**Philosophy:** AI generates. AI verifies. Humans decide. AI executes.
**Core loop:** GENERATE → UNDERSTAND → COMPRESS → VERIFY → DECIDE → CHOOSE → IMPLEMENT → VERIFY → LEARN

ChangePilot is a local-first IDE extension (VS Code) + thin CLI wrapper that helps developers review AI-generated changes without reading every line. It treats review as an engineering-decision problem, not a line-inspection problem.

Source concept: `DOC.md` (DecisionFlow platform vision, 1841 lines). This PRD scopes MVP per locked decisions below.

### Locked decisions
1. Name: ChangePilot
2. Surface: VS Code + CLI (no IntelliJ, no GitHub App for MVP)
3. Architecture: Local-first, no backend, configurable LLM
4. Languages: Multi-language AST from start (deviation from DOC §28-29 which deferred this)
5. Input: Git diff + ticket link + design doc
6. Output: Full impact / risk / test plan / rollback
7. LLM: All three switchable — BYOK OpenAI-compatible + Ollama local + VS Code LM API
8. Verification: Full verify per language
9. Users: Solo dev + team PR reviewer + tech lead treated equally
10. Rollback: Plan text only (no auto-revert, no one-click script)
11. CLI: Thin wrapper over core (no full parity)
12. Success metric: Time-to-confidence (review time cut, target 50%+ with no escaped-defect increase)

## 2. Goals / Non-Goals

**Goals:**
- Prove: developer reviews 2000+ LOC AI change significantly faster with ChangePilot than plain git diff.
- Compress review surface: Review Map + auto-verified section + ranked decision points.
- Preserve human authority on consequential decisions; never auto-decide architecture/security/data-consistency.
- Run fully local-first; code never required to leave machine for MVP.

**Non-Goals (MVP):**
- No backend / DecisionFlow API / Risk / Evidence / Knowledge cloud engines.
- No IntelliJ, GitHub/GitLab App, team analytics, enterprise SSO.
- No auto-revert on verify fail; rollback is text plan only.
- No decision-memory persistence layer beyond local project knowledge file; no model training.
- No autonomous production deployment, no full coding-agent replacement.

## 3. Target Users

All three served equally in MVP (no persona-gated features):
- **Solo dev using AI coding agents** (Claude Code, Codex, Copilot, Cursor, Cline, OpenCode): wants to accept large generation fast without missing behavior breaks.
- **Team PR reviewer (senior eng):** owns correctness/reliability/security, wants 12-min focused review not 45-min diff walk.
- **Tech lead / architect:** cares about boundaries, consistency, contracts across services.

## 4. MVP Surfaces

### 4.1 VS Code extension (primary)
Activity Bar: ChangePilot → Review | Decisions | Alternatives | Evidence | History.
- Review Map panel (see §6).
- Inline decision decoration in editor (gutter icon + hover card with Accept / Reject / Investigate).
- Alternative Studio webview (compare A/B/C + trade-off table).
- Implementation plan preview + Generate patch + Verify output.

### 4.2 CLI (thin wrapper)
`changepilot analyze [--diff] [--ticket] [--doc]` → prints Review Map JSON + markdown + decision list to stdout; reuses same core engine as extension. No implement/verify-write in CLI for MVP; analyze only. Exit codes: 0 clean/low, 2 decisions-required, 1 error.

## 5. Inputs

- **Git diff (required):** working tree / staged / branch-vs-base range. Local git only.
- **Ticket link (optional but prompted):** Linear/Jira/GitHub issue URL or ID; fetched text used as requirement evidence. If unreachable, mark evidence missing, do not block.
- **Design doc (optional):** local markdown path or URL; ADR/README/contract excerpts used as constraints.
- **Manual file pick fallback:** if no git repo, allow folder/file selection (supports DOC fallback).

## 6. Functional Requirements

### F1 Review Map
Given diff, show: LOC changed, files, modules, services; risk distribution (Critical/High/Medium/Low/Verified); estimated human review time vs full-diff estimate. Must answer "where do I spend attention" in <5s after analysis.

### F2 Semantic change detection (multi-language AST)
Operate at semantic level, not line level. Categories: business behavior, architecture, data (schema/tx/consistency/migration), security (authN/authZ/secrets/input), reliability (retry/timeout/idempotency), performance (cache/N+1/concurrency).
MVP must ship generic AST + language adapters for at minimum TypeScript + Java (DOC baseline) with pluggable interface so additional languages work without core rewrite. Each finding emits: type (ARCHITECTURE_DECISION, BUSINESS_RULE_DECISION, SECURITY_DECISION, DATA_MODEL_DECISION, CONSISTENCY_DECISION, PERFORMANCE_DECISION, API_CONTRACT_DECISION, DEPENDENCY_DECISION, RELIABILITY_DECISION, BEHAVIOR_CHANGE), before/after, impact, confidence.

### F3 Auto-verification (full verify per language)
Mechanically verifiable items removed from human surface, expandable on demand: build, unit tests, static analysis/lint, formatting, API schema unchanged check, forbidden-dependency check. Per-language runner config (e.g. `npm test` / `./gradlew test`). Show ✓/✗ per check; failures link to logs.

### F4 Human decision points
Ranked queue with severity, evidence links, confidence. Actions: Accept / Reject / Investigate. Reject requires reason (wrong architecture / business / security / performance / too complex / requirement mismatch / other + free text constraint, e.g. "payment must remain strongly consistent").

### F5 Evidence gathering
Per decision, collect local sources: current/related code, tests, git history, docs/ADRs/README, API contracts, DB schema/config, plus ticket + design-doc excerpts. Show ✓ present / ✗ missing per item. No cloud fetch required.

### F6 Alternative Studio + AI implementation
On Reject + constraint, generate 2–3 alternatives with complexity/performance/consistency/change-size + pros/cons. User picks one → implementation plan (file steps, +/−LOC estimate) → Generate patch applies via local agent adapter (inspect/plan/implement/test/explain interface; MVP ships Local Agent Adapter only). Re-verify after apply; only affected decisions re-queued.

### F7 Full output bundle
Every analysis produces: impact summary, risk classification, test plan (what ran + what to add), rollback plan **text only** (e.g. "revert commits X, re-run migration down Y, republish contract Z"). No execute-revert button in MVP.

### F8 LLM provider switch
Settings: `changepilot.provider: openai-byok | ollama | vscode-lm`. BYOK accepts OpenAI-compatible baseURL + key (OpenAI/Anthropic/Google/OpenRouter/Azure/Bedrock). Ollama default local model configurable. VS Code LM API uses editor's entitlement. No code exfiltration beyond chosen provider; local AST/diff processing always local.

## 7. Non-Functional Requirements

- Local-first: works offline except chosen LLM call; no mandatory backend.
- Latency: Review Map for 2000 LOC in <60s on typical laptop (excluding LLM wait); incremental re-analysis <15s.
- Privacy: never send code to ChangePilot servers (none exist); ticket/doc fetch only on user action.
- Reliability: false-negative avoidance prioritized over compression; uncertain → surface as decision, never silently verify.

## 8. UX Flow (happy path)

1. Dev generates 4000 LOC via agent → opens ChangePilot → picks diff range + pastes ticket + doc.
2. Sees Review Map (e.g. 3842 LOC, 74 files, 2 Critical/5 High … human ~12 min vs 45).
3. Auto-verified 1900 LOC collapsed; reviews 8 decisions inline.
4. Rejects tx-boundary change with constraint → picks Transactional Outbox → approves plan → patch applied → full verify green → Review Complete (decisions: 3, auto-verified %, final risk LOW).

## 9. Success Metrics (MVP)

- Primary: **Time-to-confidence** — median human review time vs plain diff, target 50%+ reduction with no increase in escaped defects.
- Secondary: Review Compression Ratio (original surface / human surface); Decision Accuracy (precision/recall vs human consequential label); False-Negative Rate (must be ~0 on Critical/Security); Verify pass rate; CLI analyze adoption.
- Validation question: "Can dev review 2000+ LOC AI change significantly faster and prefer it over git diff?"

## 10. Milestones / Acceptance

- M1: VS Code Review Map + diff + risk from local AST + LLM summaries.
- M2: Decisions + evidence (diff+ticket+doc) + Accept/Reject.
- M3: Alternatives + plan + patch via local adapter + full verify per language + text rollback.
- M4: CLI thin `analyze` parity + provider switch (3 modes) + time-to-confidence instrumentation.
- Ship gate: 5+ real 2000+ LOC reviews showing time cut without missed Critical.

## 11. User Stories

### US-001: Review Map shows where to spend attention
As a reviewer, I want a Review Map so I skip line-walk.
- [ ] Shows LOC changed, files, modules, services
- [ ] Shows risk distribution Critical/High/Medium/Low/Verified
- [ ] Shows estimated human review time vs full-diff estimate
- [ ] Renders in <5s after analysis completes

### US-002: Semantic change detection for TypeScript and Java
As a reviewer, I want semantic findings not line diffs.
- [ ] Detects business, architecture, data, security, reliability, performance categories
- [ ] Ships generic AST plus TS and Java adapters via pluggable interface
- [ ] Each finding emits type, before/after, impact, confidence
- [ ] Uncertain items surface as decisions, never silently dropped

### US-003: Auto-verification removes mechanical checks
As a reviewer, I want builds/tests/lint auto-verified.
- [ ] Runs build, unit tests, lint/static analysis, formatting per language
- [ ] Runs API schema unchanged check and forbidden-dependency check
- [ ] Shows pass/fail per check with log links on failure
- [ ] Verified code collapses but remains expandable on demand

### US-004: Ranked human decision queue
As a reviewer, I want ranked Accept/Reject/Investigate queue.
- [ ] Queue ranks by severity with evidence links and confidence
- [ ] Actions Accept / Reject / Investigate available inline and in panel
- [ ] Reject requires reason plus free-text constraint
- [ ] Gutter icon plus hover card works in editor

### US-005: Evidence gathering per decision
As a reviewer, I want evidence for each decision.
- [ ] Collects current/related code, tests, git history, docs/ADRs, contracts, schema/config
- [ ] Includes ticket and design-doc excerpts when provided
- [ ] Shows present/missing per evidence item
- [ ] Unreachable ticket/doc marks missing, does not block analysis

### US-006: Alternative Studio generates options on Reject
As a developer, I want 2-3 alternatives when I reject.
- [ ] Generates 2-3 alternatives with complexity/performance/consistency/change-size
- [ ] Shows pros/cons and trade-off table in A/B/C compare view
- [ ] Constraint from Reject flows into generation
- [ ] User can pick one to proceed to implementation plan

### US-007: AI implementation applies chosen patch and re-verifies
As a developer, I want picked alternative applied as patch.
- [ ] Shows implementation plan with file steps and +/-LOC estimate
- [ ] Generate patch applies via Local Agent Adapter only for MVP
- [ ] Full re-verify runs after apply
- [ ] Only affected decisions re-queued after re-verify

### US-008: Full output bundle with rollback text
As a tech lead, I want impact/risk/test/rollback bundle.
- [ ] Every analysis produces impact summary and risk classification
- [ ] Produces test plan of what ran plus what to add
- [ ] Produces rollback plan as text only
- [ ] No execute-revert or auto-revert button present in MVP

### US-009: LLM provider switch BYOK Ollama VSCode-LM
As a developer, I want configurable LLM provider.
- [ ] Setting `changepilot.provider: openai-byok | ollama | vscode-lm` works
- [ ] BYOK accepts OpenAI-compatible baseURL plus key
- [ ] Ollama local model configurable, works offline except LLM call
- [ ] No code sent beyond chosen provider, AST/diff stays local

### US-010: CLI thin analyze wrapper
As a developer, I want CLI analyze for Review Map plus decisions.
- [ ] `changepilot analyze [--diff] [--ticket] [--doc]` prints Review Map JSON plus markdown plus decision list
- [ ] Reuses same core engine as extension
- [ ] Exit codes 0 clean/low, 2 decisions-required, 1 error
- [ ] No implement/verify-write in CLI for MVP

### US-011: Git diff plus ticket plus doc inputs
As a developer, I want diff range plus ticket plus doc inputs.
- [ ] Supports working tree / staged / branch-vs-base ranges via local git only
- [ ] Ticket URL/ID prompt optional, fetched text used as evidence
- [ ] Design doc path/URL optional, excerpts used as constraints
- [ ] Manual file/folder pick fallback when no git repo

### US-012: VS Code panels Review Decisions Alternatives Evidence History
As a developer, I want ChangePilot Activity Bar views.
- [ ] Activity Bar ChangePilot with Review, Decisions, Alternatives, Evidence, History
- [ ] Alternative Studio webview compares A/B/C
- [ ] Implementation plan preview plus Generate patch plus Verify output visible
- [ ] Works local-first with no backend required

## 12. Risks / Open Questions

- Multi-language AST from day one increases scope vs DOC recommendation (TS+Java start); mitigate with adapter interface + only two languages hardened.
- LLM quality variance across BYOK/Ollama/VSCode-LM; mitigate with confidence scores + conservative verify.
- Ticket/doc parsing brittle; degrade to missing-evidence state, never block.