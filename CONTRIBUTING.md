# Contributing to symphony-ts

Thank you for your interest in contributing. This is a local-first, experimental project maintained best-effort by a single maintainer. Small, well-scoped contributions are welcome.

## Prerequisites

- Node.js `>=24.0.0`
- npm `11.11.0` (enforced via `packageManager`)

Install dependencies:

```bash
npm install
```

## Development workflow

All changes must pass the full local check before being proposed:

```bash
npm run check     # typecheck + lint + tests
npm run build     # emit dist/
git diff --check  # no whitespace errors
```

Fake/demo smoke commands (no credentials required):

```bash
npm run smoke:local
npm run demo:fake
npx symphony-fake-check
```

## Scope and boundaries

### In scope

- Bug fixes and test improvements.
- Documentation corrections.
- New fake-only test fixtures or examples.
- Small, backward-compatible enhancements that fit the existing architecture.

### Out of scope without maintainer discussion

- Live Linear, Hermes Kanban, Codex, or external API behavior changes.
- New CLI entry points or public API surface changes.
- Changes to gate, policy, or authorization boundaries.
- Anything that would require live credentials, real board mutation, worker dispatch, service restart, or external network calls to test.
- Anything that would broaden the public package surface, add dependencies, or change the license.

If your change touches any of these, open an issue first to discuss it.

## Commit and PR conventions

- One logical change per PR.
- Commit messages follow `type(scope): subject` (for example `fix(graph-sync): handle empty snapshot gracefully`).
- Include tests for any new behavior.
- Update `CHANGELOG.md` under `[Unreleased]` for user-facing changes.
- Do not include private operational artifacts, local absolute paths, live identifiers, or credentials in your PR.

## Pull request checklist

Before requesting review:

- [ ] `npm run check` passes.
- [ ] `npm run build` passes.
- [ ] `git diff --check` is clean.
- [ ] Tests cover new behavior.
- [ ] `CHANGELOG.md` updated if user-facing.
- [ ] No private paths, live identifiers, or credentials introduced.
- [ ] Scope is within the boundaries above (or maintainer discussion is linked).

## License

By contributing, you agree your contributions are licensed under the project's [Apache-2.0 license](LICENSE).