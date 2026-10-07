# Security Policy

## Scope

Deci analyzes local code changes (git diffs, tickets, design docs) and routes
explicit LLM prompts to a configured provider. In-scope: this repository's
source (`src/`), CLI, VS Code extension wiring, build/test tooling, and
packaged artifacts.

Out of scope: third-party models/providers, your API keys, and your private
codebases analyzed with Deci.

## Supported versions

No stable public release yet. Security fixes apply to the current `main`
branch until versioned releases begin. After the first tagged release, this
table will list supported versions.

| Version | Supported |
|---|---|
| main (pre-release) | Best effort |

## Responsible disclosure

Do not open a public issue for a suspected vulnerability.

Security contact needs to be configured by the repository maintainer before public release.

Until a contact is published, use a private channel you already share with the
maintainer (do not post exploit details publicly).

## How to report

Include:

* Affected commit SHA / version and environment (`node -v`, OS)
* Description and impact (what an attacker gains; what data is at risk)
* Reproduction steps or proof of concept (redact secrets)
* Whether the issue involves prompt content, API keys, local files, or the supply chain

## What not to disclose publicly

* API keys, tokens, credentials, customer code, or internal URLs
* Unfixed exploit details

## Handling

The maintainer will acknowledge receipt, assess severity, prepare a fix, and
coordinate disclosure. If no security contact exists yet, expect handling to
be best-effort until one is configured — see Remaining Manual Actions in the
release report.
