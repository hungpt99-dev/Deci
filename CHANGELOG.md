# Changelog

All notable changes to this project will be documented in this file.

## Unreleased

Initial open-source release preparation.

* Public README, contribution, conduct, and security docs.
* GitHub issue/PR templates and CI scaffolding.
* BREAKING: rename all `changepilot` / `ChangePilot` / `CHANGEPILOT_*` identifiers to `deci` / `Deci` / `DECI_*` (npm package, CLI binary, VS Code IDs, settings, env vars, resources icon).
* VS Code extension installable: real host entry (`src/vscode/host.ts`), `vsce` packaging (`npm run package`), verified install from `.vsix`.
* No application behavior changes in this preparation pass.
