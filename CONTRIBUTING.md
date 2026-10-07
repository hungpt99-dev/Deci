# Contributing to Deci

Thanks for considering a contribution. This guide keeps changes reviewable.

## Getting Started

```bash
git clone https://github.com/hungpt99-dev/Deci.git
cd Deci
npm install
npm run build
npm test
```

Prerequisites: Node.js `>=20`, Git. See `README.md` for LLM provider setup (optional for most contributions).

## Development

* Source lives in `src/`; tests sit next to sources as `*.test.ts`.
* Build: `npm run build` (emits `dist/`).
* Typecheck: `npm run typecheck`.
* Analyze a fixture: `node dist/cli.js analyze --file ./verify-e2e-004.diff`.
* Do not commit `dist/`, `node_modules/`, logs, or local model caches — they are gitignored.

## Testing

```bash
npm test
```

This runs `tsc` then Node's test runner over `dist/**/*.test.js`. Add or update a `*.test.ts` next to the source you change when behavior changes. Keep tests deterministic and offline (stub network/exec like existing tests do).

## Documentation

* Update `README.md` when behavior, flags, config, or exit codes change.
* Keep the Example and Limitations sections honest — mark illustrative vs. verified.
* Do not paste secrets, customer code, or internal URLs into docs or tests.

## Issues

* Bugs: use the bug report template — include repro steps, expected vs. actual, environment (`node -v`, OS, commit SHA), relevant logs (redact secrets), and privacy notes.
* Features: use the feature request template — state the problem, proposed solution, alternatives, intended user (developer / reviewer / architect), and expected value.

## Pull Requests

* Small, focused PRs. One concern per PR.
* Include: what changed, why, how tested, breaking changes, docs updates, security/privacy impact.
* Checklist: tests pass, docs updated where needed, no secrets committed, no private/internal info, no unrelated changes.
* CI must pass (`build`, `typecheck`, `test` on Node 20).

## Changes

Avoid unrelated refactoring. Do not rename packages, binaries (`deci`), VS Code IDs, or config keys for consistency alone — those are frozen for compatibility and renamed only via an explicit maintainer decision.

## Architecture

Thin adapters over a local core: `src/cli.ts` and `src/vscode/extension.ts` handle I/O; `reviewMap.ts`, `semantic.ts`, `decisions.ts`, `evidence.ts`, `alternatives.ts`, `verify.ts`, `bundle.ts`, `implement.ts`, `panels.ts`, `llm.ts` hold the logic. `inputs.ts` defines diff specs (`working` / `staged` / `range` / `file`) mapped to local `git diff` commands only. See `README.md` Architecture for the map.
