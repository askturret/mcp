# Contributing to AskTurret MCP

Thank you for your interest in contributing to AskTurret MCP! We welcome contributions from the community and are pleased to have you join us.

## Table of Contents

- [Code of Conduct](#code-of-conduct)
- [Getting Started](#getting-started)
- [Development Environment](#development-environment)
- [Making Changes](#making-changes)
- [Coding Standards](#coding-standards)
- [Compatibility](#compatibility)
- [Commit Standards](#commit-standards)
- [Dependency Licences](#dependency-licences)
- [Submitting a Pull Request](#submitting-a-pull-request)
- [Contributing Adapters and Plugins](#contributing-adapters-and-plugins)
- [Contribution Statement](#contribution-statement)
- [Copyright and Licensing](#copyright-and-licensing)

## Code of Conduct

This project adheres to the Contributor Covenant [Code of Conduct](CODE_OF_CONDUCT.md). By participating, you are expected to uphold this code. Please report unacceptable behavior to the project maintainers.

## Getting Started

1. **Fork the repository** on GitHub
2. **Clone your fork** locally:
   ```bash
   git clone https://github.com/YOUR_USERNAME/mcp.git
   cd mcp
   ```
3. **Add the upstream repository**:
   ```bash
   git remote add upstream https://github.com/askturret/mcp.git
   ```
4. **Create a feature branch**:
   ```bash
   git checkout -b feature/your-feature-name
   ```

## Development Environment

### Prerequisites

- **Node.js** 18 or higher
- **npm** or **pnpm** (we use npm workspaces)
- **Git**

### Setup

1. Install dependencies:
   ```bash
   npm install
   ```

2. Build all packages:
   ```bash
   npm run build
   ```

3. Run tests:
   ```bash
   npm test
   ```

4. Run the linter:
   ```bash
   npm run lint
   ```

### On `typecheck` and `build` being the same command

Both run `tsc -b`, and that is deliberate rather than an oversight.

This is a **composite project**: the root `tsconfig.json` has `files: []` and a
list of `references`, and each package emits declarations the packages
downstream of it consume. Two consequences follow, and they are the reason the
scripts collapsed into one:

- **`tsc --noEmit` checks nothing here.** It does not traverse project
  references, and the root has no files of its own — so it exited 0 on a tree
  containing a real type error. It read as a check and could not fail (#134).
- **`tsc -b --noEmit` is rejected outright**, with `TS6310: Referenced project
  may not disable emit`. A project others reference *must* emit its `.d.ts`,
  because that is what they type-check against.

So in a repository shaped like this one, type checking **is** the build. Keeping
a separate `typecheck` script that did less than the build would be keeping the
thing #134 removed.

`tsc -b` is incremental: an unchanged, already-built tree exits 0 without
re-checking. That is standard build-mode behaviour and is what makes it quick
enough to run often. If you suspect a stale `.tsbuildinfo` — the symptom is a
package reported up to date while its `dist/` is missing or old — force a full
rebuild:

```bash
npx tsc -b --force
```

### Project Structure

- `packages/core/` - Core MCP server implementation
- `packages/express/` - Express.js integration
- `packages/cli/` - Command-line tools (doctor, inspect)
- `docs/` - Documentation
- `examples/` - Example implementations

## Making Changes

### Finding an Issue

- Check the [issue tracker](https://github.com/askturret/mcp/issues) for open issues
- Look for issues labeled `good first issue` or `help wanted`
- If you're planning significant changes, open an issue first to discuss

### Writing Code

1. Make your changes in your feature branch
2. Add tests for any new functionality
3. Ensure all tests pass: `npm test`
4. Update documentation as needed
5. Run the linter and fix any issues: `npm run lint`

### Testing

- Write unit tests for new functionality in `*.test.ts` files
- Ensure test coverage remains high
- Run `npm test` before committing
- For integration tests, see `packages/*/tests/`

**A test must go RED when the fix it guards is reverted.** If you are fixing a
bug, comment out the fix and watch the test fail before you open the PR; if you
cannot produce a deterministic RED-on-revert, say so in the PR rather than
leaving it unsaid. See [docs/TESTING.md](docs/TESTING.md) for that rule in full
and for five named ways a test passes without guarding anything — each drawn from
a defect that reached review in this repository.

#### Running a subset of the tests

Scoping a run needs **both** `-w <package>` and `--`:

```bash
npm test -w packages/core -- --testPathPattern="discovery-invocation-parity"
```

Each half is load-bearing, and dropping either fails in a different direction:

| Command | What actually happens |
|---|---|
| `npm test --testPathPattern=X` | **Runs the entire suite.** npm parses the flag as one of its own config options and never passes it to jest. |
| `npm test -- --testPathPattern=X` | **Breaks unrelated packages.** The flag now reaches jest, but in *every* workspace, and jest exits 1 in each one the pattern matches nothing in. |
| `npm test -w packages/core -- --testPathPattern=X` | ✅ Runs the matching tests in that one package. |

The first form is the one to watch for. It exits 0, so it looks like it worked —
npm 11 prints a single `npm warn Unknown cli config` line above the output of
every test it just ran anyway, and older npm printed nothing at all. Two CI
steps in this repo ran the full workspace suite that way for months while their
names claimed to verify one criterion each ([#207](https://github.com/askturret/mcp/issues/207)).

`.github/scripts/check-jest-flag-forwarding.mjs` now fails the build on either
broken form in a workflow or a `package.json` script. It deliberately does not
scan prose, which is why this section can show you the wrong commands.

Running `jest` directly is unaffected — there is no npm layer to eat the flag:

```bash
cd packages/core && npx jest --testPathPattern="parity"
```

## Coding Standards

### TypeScript

- Use TypeScript for all new code
- Enable strict mode
- Avoid `any` types - use proper typing
- Export types alongside functions where applicable

### Style Guide

- Use **2 spaces** for indentation
- Use **single quotes** for strings (except to avoid escaping)
- Use **trailing commas** in multiline arrays/objects
- Run `npm run lint` to check style compliance
- Run `npm run format` to auto-format code (if available)

### Naming Conventions

- **Files**: Use kebab-case (`my-file.ts`)
- **Classes**: Use PascalCase (`MyClass`)
- **Functions/Variables**: Use camelCase (`myFunction`, `myVariable`)
- **Constants**: Use UPPER_SNAKE_CASE (`MAX_RETRY_COUNT`)
- **Interfaces/Types**: Use PascalCase, avoid `I` prefix (`User`, not `IUser`)

### Comments and Documentation

- Use JSDoc comments for public APIs
- Document complex logic with inline comments
- Keep comments concise and meaningful
- Update documentation when changing behavior

## Compatibility

Before changing anything exported, printed as JSON, or accepted as a CLI flag or
config key, check the
[compatibility and deprecation policy](docs/compatibility-policy.md). It defines
which surfaces are under semver, and it answers the questions that are easy to
get wrong — notably that **widening a type is breaking when the value flows
outward** (an added union member breaks an adopter's exhaustive `switch`) and
that **CLI flags and config keys are covered**, because a renamed flag breaks
every deployment script that used it.

If your change touches a covered surface, say so in the PR and add a
[`CHANGELOG.md`](CHANGELOG.md) entry naming the surface. Removing anything needs
a deprecation first — at minimum one MINOR, with a `deprecation`-tagged log
record — never a removal in the same release as the notice.

Pre-1.0 none of this binds yet, and that is precisely when a shape is cheapest
to get right.

## Commit Standards

### Commit Message Format

We use the [Conventional Commits](https://www.conventionalcommits.org/) specification. Each commit message must follow this format:

```
<type>(<scope>): <subject>

<body>

<footer>
```

**Types:**
- `feat`: A new feature
- `fix`: A bug fix
- `docs`: Documentation changes
- `style`: Code style changes (formatting, etc.)
- `refactor`: Code refactoring
- `perf`: Performance improvements
- `test`: Adding or updating tests
- `chore`: Build process, tooling, dependencies

**Examples:**

```
feat(core): add support for streaming responses

Implement streaming support for large response bodies using
Node.js streams. This reduces memory usage for large payloads.

Closes #123
```

```
fix(express): handle null request bodies correctly

Previously, null request bodies would cause a TypeError.
Now they are handled gracefully as empty objects.
```

### Developer Certificate of Origin (DCO)

All commits **must be signed off** to indicate that you agree to the Developer Certificate of Origin (DCO). This is done by adding a `Signed-off-by` line to your commit message.

**How to sign off commits:**

```bash
git commit -s -m "feat(core): add new feature"
```

The `-s` flag adds the sign-off automatically. Your commit message will include:

```
Signed-off-by: Your Name <your.email@example.com>
```

**What the DCO means:**

By signing off, you certify that:
1. The contribution was created in whole or in part by you and you have the right to submit it under the Apache License 2.0
2. The contribution is based upon previous work that is covered under an appropriate open source license
3. You understand and agree that the contribution is public and that a record of it (including all personal information submitted with it) is maintained indefinitely

Read the full [DCO text](https://developercertificate.org/).

### DCO Enforcement

All pull requests are automatically checked for DCO sign-off via CI. The check is the **DCO sign-off** job in [`.github/workflows/dco.yml`](.github/workflows/dco.yml), which runs [`.github/scripts/dco-check.sh`](.github/scripts/dco-check.sh) against every commit the pull request adds. Pull requests with unsigned commits **will not be merged**.

The check requires each commit — merge commits excepted, since the forge generates those — to carry a `Signed-off-by` trailer matching that commit's author or committer. The match is case-insensitive.

To add a sign-off to a commit retroactively:

```bash
git commit --amend -s
```

For multiple commits:
```bash
git rebase HEAD~N --signoff  # where N is the number of commits
```

Either rewrites history, so you will need to force-push afterwards:

```bash
git push --force-with-lease
```

You can run the same check locally before pushing:

```bash
.github/scripts/dco-check.sh origin/main HEAD
```

## Dependency Licences

Every pull request runs a licence review
([`.github/scripts/check-licenses.mjs`](.github/scripts/check-licenses.mjs)). It
fails the build when a dependency is copyleft (GPL, AGPL, LGPL),
source-available (SSPL, BUSL), or declares no licence at all.

Prefer permissively licensed dependencies — MIT, BSD, ISC and Apache-2.0 are
auto-approved. If a dependency genuinely requires an exception, record it in
[`LICENSE_EXCEPTIONS.md`](LICENSE_EXCEPTIONS.md) with a reason and an approver;
the gate rejects an exception missing either.

Adding a runtime dependency also changes the attribution we ship, so regenerate
the NOTICE file and commit the result:

```bash
node .github/scripts/generate-notice.mjs
```

CI fails if `NOTICE` is out of date — attribution is a licence obligation, not
housekeeping.

## Submitting a Pull Request

1. **Push your changes** to your fork:
   ```bash
   git push origin feature/your-feature-name
   ```

2. **Open a pull request** on GitHub from your fork to the upstream repository

3. **Fill out the PR template** - describe your changes, link related issues, confirm the checklist

4. **Wait for review** - maintainers will review your PR and may request changes

5. **Make requested changes** and push additional commits if needed

6. **Once approved**, a maintainer will merge your PR

### PR Checklist

Before submitting, ensure:
- [ ] All tests pass (`npm test`)
- [ ] Code follows the style guide (`npm run lint`)
- [ ] Documentation is updated (if applicable)
- [ ] All commits are signed off (DCO)
- [ ] PR is linked to an issue (if applicable)
- [ ] New features include tests

## Contributing Adapters and Plugins

We welcome third-party adapters for additional frameworks (Fastify, Koa, Hapi, etc.) and plugins for extended functionality.

### Adapter Guidelines

1. Create a new package under `packages/<framework-name>/`
2. Follow the existing Express adapter structure
3. Implement the core adapter interface
4. Include comprehensive tests
5. Document integration steps

### Plugin Guidelines

1. Plugins should be self-contained and composable
2. Follow the policy/middleware pattern
3. Include type definitions
4. Provide usage examples

### Conformance Suite

We are developing a conformance test suite for adapters and plugins. Once available, all contributed integrations should pass the suite. Check the [roadmap](docs/roadmap.md) for status.

## Contribution Statement

By contributing to this project, you agree that:

1. Your contributions will be licensed under the [Apache License 2.0](LICENSE)
2. You have the right to submit the contribution
3. You understand the contribution is public and maintained indefinitely
4. You follow the [Code of Conduct](CODE_OF_CONDUCT.md)

## Copyright and Licensing

- All contributions are licensed under the **Apache License 2.0**
- You retain copyright to your contributions
- By submitting a contribution, you grant AskTurret a perpetual, worldwide, non-exclusive, royalty-free license to use, reproduce, modify, and distribute your contribution as part of this project
- See [LICENSE](LICENSE) for the full license text
- See [TRADEMARK.md](TRADEMARK.md) for trademark usage guidelines
- See [Generated-Output Licensing](docs/generated-output-license.md) for what licence applies to output produced by AskTurret — generated scaffolding belongs to the user, bundled runtime code stays Apache-2.0

---

## Questions?

- Open a [Discussion](https://github.com/askturret/mcp/discussions) for questions
- Check existing [Issues](https://github.com/askturret/mcp/issues) and [Pull Requests](https://github.com/askturret/mcp/pulls)
- Reach out on [Discord](https://discord.gg/askturret)

Thank you for contributing to AskTurret MCP! 🚀
