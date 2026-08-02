# Contributing

Thank you for contributing to Xcode MCP Broker. Focused issues and pull requests are welcome.

By participating, you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md). Do not report suspected vulnerabilities in a public issue; follow the private process in [SECURITY.md](SECURITY.md).

## Before Opening an Issue

- Search existing issues and releases for the same behavior.
- Use the structured bug or feature form.
- Remove tokens, credentials, private source code, usernames, and sensitive filesystem paths from logs.
- Use GitHub Private Vulnerability Reporting for security-sensitive findings.

## Development Setup

Development requires macOS, Node.js 20 or later, and an Xcode version that provides `xcrun mcpbridge`.

```sh
npm ci
npm test
npm audit --audit-level=moderate
```

Use `npm ci`, rather than `npm install`, when verifying the committed lockfile. If a change affects the live MCP transport, also run this with Xcode open:

```sh
npm run broker:smoke
```

## Pull Requests

1. Create a focused branch from the current `main` branch.
2. Keep unrelated refactoring out of behavior changes.
3. Add or update tests for protocol, lifecycle, installer, release, or concurrency behavior.
4. Run the verification commands from the pull request template.
5. Explain user-visible behavior, security impact, and verification performed.
6. Resolve all review conversations and keep the branch current with `main`.

All required GitHub checks must pass. Actions used by workflows must be pinned to full commit SHAs, and workflows should grant only the permissions they need.

## Commit Messages and Pull Request Titles

Use [Conventional Commits](https://www.conventionalcommits.org/) for every commit in a pull request.

Pull request titles use natural language instead. Keep them to 2-8 words, and describe one cohesive theme.

## Automated Review

`@coderabbitai` reviews each commit pushed to a pull request. It is a useful second set of eyes and often catches real bugs, but it can also misunderstand the code or invent a problem.

Treat its comments as leads, not facts. Check every claim against the code, documentation, and tests before making a change. Resolve valid findings and briefly explain when a suggestion does not apply. You own the final decision, not the review bot.

## Release Intent

Maintainers apply exactly one release label to every pull request:

| Label | Meaning |
|---|---|
| `release:patch` | Compatible fix or dependency update |
| `release:minor` | Backward-compatible feature |
| `release:major` | Breaking runtime, configuration, or behavior change |
| `release:none` | No change to the distributed project |

For a release, update the package and lockfile versions:

```sh
npm version <next-version> --no-git-tag-version
npm run copyright:update
```

The required `Release intent` check validates the label, version, existing tags, and copyright year. See [RELEASING.md](RELEASING.md) for the complete release process.

## Project Structure

| Path | Purpose |
|---|---|
| `src/` | Broker runtime and standalone executable entrypoint |
| `test/` | Node test suites |
| `scripts/` | Development, installation, and release commands |
| `scripts/lib/` | Shared release-policy helpers |
| `packaging/` | macOS signing and installer metadata |
| `.github/` | CI, release automation, and contribution templates |

## Concurrency and Recovery

Downstream calls are intentionally serialized. Changes to cancellation, timeout, retry, or connection behavior must account for Xcode operations whose outcome may be uncertain after a connection failure.

Once a call reaches the shared bridge, the broker lets it finish so one client cannot interrupt other clients or trigger another Xcode authorization request. Timed-out operations are not automatically retried. The bridge is replaced only after a definitive connection closure.
