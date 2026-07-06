# Security Policy

## Reporting a Vulnerability

**Do not open a public GitHub issue for security reports.**

If you discover a security vulnerability in `symphony-ts`, please report it privately:

- **Preferred:** open a [GitHub Security Advisory](https://github.com/hermegeddon/symphony/security/advisories/new) (Privately share a security vulnerability with maintainers).
- **Alternative:** email `janusz@forserial.org` with `[symphony-ts security]` in the subject line.

Please include:

1. A description of the issue and its potential impact.
2. The version or commit you tested against.
3. Steps to reproduce or a minimal proof of concept.
4. Any suggested fix or mitigation.

## Response Expectations

This is a local-first, experimental project maintained best-effort. There is no SLA for security responses. The maintainer will acknowledge reports as time permits and coordinate disclosure timing with the reporter.

## Supported Versions

Only the latest released version receives security consideration. Pre-1.0 releases may have breaking changes; upgrade notes appear in `CHANGELOG.md`.

## Scope

Security issues include credential leakage, path traversal in workspace handling, unsafe deserialization, command injection in the Codex/CLI surfaces, and similar concerns. General bugs, feature requests, and configuration questions belong in regular issues, not security reports.