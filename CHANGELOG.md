# Changelog

All notable changes to this project will be documented in this file.

## Unreleased

Reliability audit and feature completion (160 pass, 2 opt-in live skips, 0 fail):

* **Fixed: discovery/impact scanned agent worktrees.** `.kilo/worktrees`, `.opencode`, `.agents`, `.cursor`, and `worktrees` dirs (repo copies) duplicated every test and fabricated duplicate impact edges. All three scanners skip them; packaging (`.vsix` 11.95 MB → 137 KB) excludes them too.
* **Fixed: `--write-tests` failed when diff paths weren't root-relative** (ENOENT, no parent dirs). Tests are now placed as siblings of the resolved source with directories created; unresolvable sources are skipped with a reason.
* **Fixed: generated tests broke strict `tsc` builds.** Invalid-input probes now cast to declared param types (`as unknown as T`, with `type T` imports for exported types, `as never` otherwise); JS targets get plain JS.
* **New: route-table and `router.*` endpoint detection** — `{ method, path }` registrations and Express router calls now yield endpoint symbols, `API_CONTRACT_DECISION` findings, contract scaffolds, and API Studio entries.
* **New: write containment.** Diff paths are untrusted: writes escaping both `--root` and cwd are refused with a clear message (verified against a hostile diff end-to-end, plus an automated black-box test).
* **New: VS Code adapter tests** (`src/vscode/extension.test.ts`) — every panel, decoration, command, prompt, and activation path exercised with a stub host. `host.ts` remains BLOCKED on the real VS Code runtime.
* **New: security regression tests** (`src/security.test.ts`) — containment, range-injection, redaction via the real CLI binary.
* **Verified live:** `--ai-explain` and `--ai-diagnose` against a real local model (Ollama `qwen3:0.6b`); provider outage (bad key → classified 401), missing model (404), and privacy refusal all report honestly with deterministic analysis intact.

Provider-agnostic AI architecture (all covered by tests, `npm test` 144/144 green, plus opt-in live smoke):

* **New:** provider registry (`src/providers.ts`) — 9 specs (openai, anthropic, gemini, openai-compatible, openrouter, litellm, ollama, vllm, vscode-lm) over 4 wire protocols, no vendor SDKs. Legacy `openai-byok` id kept as an alias; all existing `llm.ts` behavior and tests pass unchanged (`complete()` now delegates to the adapters).
* **New:** capability model with honest gating — unsupported `jsonMode`/`stream`/`tools` fail loudly naming compatible providers, never pretend. Streaming/tools are declared unsupported everywhere (no Deci consumer).
* **New:** classified errors (auth, rate-limit, network, timeout, context-length, bad-request, bad-response, unavailable, cancelled) with per-protocol parsing; bounded retries on retryable kinds only, exponential backoff.
* **New:** capability- and privacy-gated fallback — local primaries never cross to cloud without explicit opt-in; incompatible fallbacks are skipped, never attempted.
* **New:** deterministic per-operation routing (`explain|impact|test-plan|test-gen|diagnose|fix`) via `--route` / `DECI_ROUTE_*`; same-provider routes keep endpoint/key, cross-provider routes never inherit credentials.
* **New:** real AI operations (`src/operations.ts`) — `--ai-explain` and `--ai-diagnose` with `handledBy` provenance, rendered apart from deterministic findings. Privacy gate enforced: cloud needs `--allow-cloud-ai` / `DECI_ALLOW_CLOUD_AI=1`.
* **New:** `deci providers [--check [--live]]` — registry, redacted resolution, config validation, cheapest-endpoint live probes. Keys from env only.
* **New:** adapter contract suite (`src/providers.test.ts`, `src/operations.test.ts`) on mocked HTTP — normalization, auth/timeout/rate-limit/malformed, capability refusal, fallback policy, secret redaction, switching, credential isolation. Opt-in live smoke (`src/live-smoke.test.ts`, `DECI_LIVE_SMOKE=1`), verified against a real HTTP endpoint.
* **Fixed (found by verification):** live health check sent a body with GET (Undici rejects) — body now omitted for bodiless methods.
* JSON is `schemaVersion: 4` (adds `ai`, `aiErrors`).

Full-stack change-aware testing platform (all covered by tests, `npm test` 126/126 green):

* **New:** test discovery (`src/discover.ts`) — unit/component/integration/api/contract/e2e/regression categorization by path+content, framework detection (node:test, jest, vitest, pytest, junit, go-test), per-file shell-free run commands, disclosed gaps. `deci tests [--root] [diff flags]`.
* **New:** change-aware selection (`src/select.ts`) — sibling (confirmed), impact-traced (confirmed), contract-guard (confirmed), same-module (inferred); everything else listed unexecuted, never implied.
* **New:** real execution (`src/run.ts`) — shell-free spawn with per-test timeouts, secret redaction, revision stamping, passed/failed/skipped/blocked/unexecuted from actual exit codes. **Fixed:** child `node --test` runs inherit `NODE_TEST_CONTEXT` and silently run zero tests with exit 0 — the spawner now scrubs it (this would have reported false passes).
* **New:** deterministic generation (`src/generate.ts`) — structural, guard-derived, previous-behavior regression pins, and contract scaffolds from real symbols/imports; expected values beyond evidence are `TODO-pin`s; JS targets get plain JS; `--write-tests` never overwrites (explicit `--force-write` to override).
* **New:** failure diagnosis (`src/diagnose.ts`) — frame parsing, changed-file/symbol linking, confirmed-vs-hypothesis causes, removed-guard patch proposals; `--apply-fix` is the only path that touches production code (refused otherwise, idempotent when approved).
* **New:** `--run-tests [--timeout]`, `--generate-tests`, `--write-tests`, `--diagnose`, `--apply-fix`, `--save-results`, `--compare` on `analyze`; run history comparison; exit 2 when any selected test fails. JSON is `schemaVersion: 3`.
* **New:** Test Explorer, Execution Center, Generate, Diagnose, and API Studio panes in the HTML report, all cross-linked with zero dangling anchors (script-verified).
* **New:** runnable fixture (`fixtures/calc` + `change.diff`) — the full slice (discover → select → generate → run → fail → diagnose → approve → green) executes real `node --test` runs in tmp (`src/pipeline.test.ts`).
* **Fixed:** writes under `--root` never fall back to cwd (a generated test briefly landed in the repo root during development — root-confined writes now); per-file run commands for directly-runnable frameworks instead of suite scripts.

Visual code-change impact & risk analysis (all covered by tests, `npm test` 104/104 green):

* **New:** `deci analyze --html report.html` writes a self-contained interactive impact report (no server, no network): highlighted diff with per-line anchors, finding markers, Explanation/Impact/Risks/Tests tabs, expandable impact tree, prev/next finding navigation, evidence + limitations footer, and a staleness banner recording the analyzed revision.
* **New:** changed-symbol extraction (`src/symbols.ts`) — functions, methods, classes, interfaces, endpoints (added/removed/modified with lines); body-only hunks attribute to enclosing declarations from context; constructor calls no longer misread as declarations. Per-language capability table documents heuristic limits honestly.
* **New:** bounded impact tracing (`src/impact.ts`) — changed symbols → referencing files with `import-resolved` / `textual` evidence, direct vs indirect (one hop), test-file flagging, 200-file cap, `--root` scope flag. Filename similarity alone never creates an edge; gaps are disclosed.
* **New:** 10-field risk findings (`src/risks.ts`) — title, severity, location, current behavior, consequence, concrete failure scenario, evidence, confidence + meaning, mitigation, suggested test; standing `confirmed` (failing check names the file) / `potential` / `hypothesis`.
* **New:** change overview (`src/overview.ts`) — documented (ticket/doc excerpt) vs inferred purpose, behavioral deltas, affected symbols/components, deduplicated unknowns.
* **New:** fixture shop (`fixtures/shop`) with safe / regression / uncertain scenarios, verified end-to-end (`src/fixtures.test.ts`) through the real engine.
* **Changed:** CLI `--json` is now `schemaVersion: 2` (adds `overview`, `symbols`, `impact`, `risks`, `revision`); text output gains Change overview / Impact / Risks sections.
* **Fixed:** hunk-`before` pairing (nearest removed line, not first-of-hunk); blank hunk lines counted as context so line anchors stay revision-accurate; changed files can no longer appear as their own impact under different rootings.
* **VS Code:** `deci.showImpactReport` command + `showImpactReport` renderer display the same HTML in a webview.

Correctness and safety hardening of the analysis core (all covered by regression tests, `npm test` 78/78 green):

* **Fixed: deleted files were invisible.** Unified-diff parsing dropped `+++ /dev/null` (deleted) files, so deleting e.g. an auth module reported "No changes". Both parsers (`reviewMap`, `semantic`) now resolve `---`/`+++` pairs, `diff --git` headers, and renames; deletions surface as Critical where their path warrants it.
* **Fixed: shell injection via `--diff` range and file paths.** Git commands (`git diff <range>`, `git log -- <path>`) were built as shell strings from CLI input. Git now runs shell-free (`execFileSync` argv + trailing `--`), ranges are allowlist-validated, and verification commands run without a shell. A hostile range now fails with an actionable error instead of executing.
* **Fixed: `--file <source>` reported "No changes".** A raw source file (not diff-shaped) is now wrapped as an all-added diff, so single-file analysis works as users expect.
* **Findings carry diff-backed line numbers.** `@@` hunk headers are tracked; decisions render `file:line`, and gutter marks use the real line (caller hook remains the fallback for pure removals).
* **Truthful before/after.** `before` is now the removed line(s) from the same hunk; pure additions report `""` instead of borrowing an unrelated line. Removed capability lines (e.g. a deleted auth check) are flagged with `line: null` and `after: "(removed)"`.
* **Machine-readable contract:** CLI `--json` output now carries `schemaVersion: 1`.
* Folder scans skip symlinks, cap depth (8) and file count (50), and detect device+inode loops.

* Public README, contribution, conduct, and security docs.
* GitHub issue/PR templates and CI scaffolding.
* BREAKING: rename all `changepilot` / `ChangePilot` / `CHANGEPILOT_*` identifiers to `deci` / `Deci` / `DECI_*` (npm package, CLI binary, VS Code IDs, settings, env vars, resources icon).
* VS Code extension installable: real host entry (`src/vscode/host.ts`), `vsce` packaging (`npm run package`), verified install from `.vsix`.
* No application behavior changes in this preparation pass.
