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

### Recording a Finding

While working on one thing you will notice another — a bug next door, a stale
comment, a check that cannot fail. **A finding that is not about the issue you
are working on gets its own issue.**

Not a comment on someone else's issue, not a PR body, not a handoff note —
those three are where findings go to become invisible. **But do note it in
passing where you found it: that part is good, and worth keeping.** Mention it
in the review, in the PR, in the issue thread. The distinction that matters:

> The note is a **pointer**. The issue is the **record**.
> What fails is the note *being* the record.

**Why a comment cannot carry a finding.** A comment is bound to *its issue's*
lifecycle. When that issue closes, a finding recorded in its thread closes with
it — not resolved, just no longer anywhere a reader will look. The corpus of
open issues, which is the thing people actually search, never contained it.

That is worse than not writing it down at all, and the reason is worth stating
plainly:

> A description in the wrong place and no description at all fail identically —
> and the second is at least **visible as a gap.**

A missing record looks missing. A misplaced one looks handled.

**Reference findings by number, not by description.** In a handoff, a review, or
a PR body, write `#390`. *"The compatibility-policy defect you are already
filing"* is not checkable — a reader cannot tell whether the filing exists. A
number either resolves or it does not.

This applies to asserting that something *is* filed, as much as to asking for
it. If you cannot cite a number, the honest sentence is "I have not filed this
yet," not a description that implies you have.

**But do not put a number in a branch name unless the branch does that issue's
work.** Reference-by-number is right in prose and wrong in a branch, because a
branch name is not only a label — **the merge gate resolves a linked issue out
of `<type>/issue-<N>-<slug>`**, and it does so even when the PR explicitly
declares that it closes nothing. The PR is then gated on `<N>`'s
`status:qa-approved`: a stamp belonging to work the PR did not do, which may
never be applied, or may be correctly removed the moment `<N>` ships.

Naming a branch after the issue you *happened to be working on* is the natural
mistake. The behaviour is established across five instances; **the mistake
accounts for three of them.** The other two are branches that kept the number
out and merged cleanly — they are the control arm, not noise around the
finding, and they are why this is established rather than anecdotal.

It bites hardest on PRs that legitimately close nothing — concealment captures
above all, so
[their README](.operum/audit/concealment-reminders/README.md#landing-a-capture--the-pr-workflow)
carries the full mechanism and the evidence. The short version: if the branch
does not do issue `<N>`'s work, keep `<N>` out of its name and put the reference
in the PR body, where it is a pointer rather than a binding.

**There is deliberately no automated check for this, and that is a decision
rather than an omission.** *"Is this comment a finding about something else?"* is
a semantic judgement with many shapes. A check that caught one syntactic form
would read as covering the class, and reviewers would trust it for the cases it
cannot see. If you find yourself wanting to add one here, that is this rule's
own argument telling you not to.

The argument is not new, and the precedent is worth citing exactly.
[docs/TESTING.md, *"Is this mechanisable?"*](docs/TESTING.md#is-this-mechanisable)
declines a guard for a different semantic property on the same grounds —
*"a guard covering one syntactic sub-shape would read as covering the class"* —
and is the better read if you are about to propose one, because it also shows
the arithmetic: a syntactic guard would have caught one of three real instances
and reported clean on the other two.

[#378](https://github.com/askturret/mcp/issues/378) is the issue that produced
that section. It **asks** whether the check is mechanisable; the answer was
given in the document. Origin of the question and record of the decision are
two different things, and an earlier draft of this very section cited the
former as if it were the latter — which a reader following the number would
have caught, since it leads to an issue inviting the guard it was quoted as
refusing.

<details>
<summary>Where this came from</summary>

[#392](https://github.com/askturret/mcp/issues/392). A defect in the
compatibility policy was recorded clearly and accurately — in a comment on
[#347](https://github.com/askturret/mcp/issues/347), an issue about
`deserializeSnapshot`. It surfaced only because someone referred to it by name
in a handoff, went looking for the filing that reference implied, and found
none. Two coincidences deep.

That issue noted its own limit honestly: the argument was structural, and it
could not cite anyone actually misled. Four findings raised in review in a
single day since then are the empirical half it was missing — each one raised
against a pull request it was not about, and each filed instead of left there:

| filed | raised during | would have closed with |
|---|---|---|
| [#454](https://github.com/askturret/mcp/issues/454) | QA of PR #453 | that PR, merged hours later |
| [#461](https://github.com/askturret/mcp/issues/461) | QA of PR #459 | that PR |
| [#462](https://github.com/askturret/mcp/issues/462) | QA of PR #460 | that PR |
| [#464](https://github.com/askturret/mcp/issues/464) | QA of PR #463 | that PR |

#464 is the sharpest, because it is the case where leaving it in place would
have looked most reasonable. It is **not a defect in the PR it was found
under** — the file it concerns is untouched by that PR and the bug predates it.
As a review note it would have read as an aside about unrelated code and closed
with the PR. Filed and read on its own, it is a `priority:high` compliance bug:
a non-starting `npm ls` collapses the dependency set to empty, so
`generate-notice` rewrites NOTICE to claim *"no third-party dependencies"* and
exits 0.

Three of the four cite #392 by number as their reason for existing — the
practice was being followed, and referenced, before it was written down here.

</details>

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

All pull requests are automatically checked for DCO sign-off via CI. The check is the **DCO sign-off** job in [`.github/workflows/dco.yml`](.github/workflows/dco.yml), which runs [`.github/scripts/dco-check.sh`](.github/scripts/dco-check.sh) against every commit the pull request adds. Pull requests with unsigned commits **will not be merged**. There is one pull request that fails this check permanently and by design — see [Dependabot pull requests](#dependabot-pull-requests-convert-and-close) at the end of this section.

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

#### Dependabot pull requests: convert and close

A bot commit carries no `Signed-off-by` trailer, so **a dependabot pull request fails the DCO check by construction** — there is no state in which it passes, and no rerun changes that. That red is not a fault to investigate and not a case to except. **It is the signal that the pull request needs converting**, and it is the expected outcome rather than a surprise.

**DCO is a provenance attestation, not a lint rule.** A `Signed-off-by` line is a person certifying, under the Developer Certificate of Origin, that they have the right to submit the code. A bot cannot make that certification. Exempting one would not be a configuration tweak — it would change what the attestation means for every other commit in the repository. There is deliberately **no bot allowlist in `dco-check.sh`**, and adding one is not the fix.

Instead:

1. **Open a dependency issue** capturing the bump — or **update the existing open issue** if that dependency is already tracked.
2. **Close the dependabot pull request.** It is never a merge candidate.
3. Let the change proceed through the normal pipeline as reviewed engineering, on a branch whose commits are signed off.

**One issue per dependency, updated on repeat bumps** — not a fresh issue each time the same package moves. A second bump of a dependency that is already tracked is retired by the same change as the first, so it belongs on the same issue rather than beside it.

**Read the bot's analysis before you close it.** Dependabot reports which packages it had to move together and what a lockfile will not resolve, and that reasoning is often the most useful part of the pull request. The licence, NOTICE and SBOM checks a dependency change needs are run on the branch that actually merges, so closing the bot's pull request discards no evidence.

##### Why CI does not run on these pull requests

**Most jobs are skipped on a dependabot pull request, deliberately (#635).** If you are looking at one and wondering where the checks went, this is the answer rather than a bug to file.

The pull request is never a merge candidate, so running the package suites, the licence/SBOM job and the integrity guards on it spends the **single serial runner** — the scarcest resource in this project — on a verdict nobody will act on. The compute is dropped and **the pull request is kept**: the pull request is the notification this whole conversion depends on, and nothing in the mechanism suppresses it.

**The DCO check is a deliberate exception, and it still runs.** Its red is precisely what the section above calls the signal that the pull request needs converting, which makes it the one result here that somebody acts on. The DCO *self-test* is skipped: it exercises `dco-check.sh` against its own fixtures and returns the same answer whatever pull request it is looking at.

The condition is on **authorship** — `github.event.pull_request.user.login`, the forge's own statement of who opened the pull request. Deliberately not the `dependabot/**` branch name, which is forgeable by anyone with push access and drifts with the bot's conventions; and deliberately not `github.actor`, which changes the moment a human pushes a fixup to a bot branch while the convert-and-close disposition does not.

**Nothing is lost, only deferred.** The dependency reaches `main` on the hand-carried branch, where every one of these jobs runs against the same dependency set — so a GPL transitive or a stale NOTICE surfaces there instead. #585, the express upgrade carried by hand after PR #584 was stood down, is the live example.

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

### If you added or removed a workspace member, run this before pushing

```bash
npm run check:workspace-artifacts
```

Adding a workspace member invalidates artifacts **no local build or test
command consults**: `npm ci` reads a lockfile that local installs ignore, and
`NOTICE` and the licence policy read the *installed dependency set*. So "I built
it and ran the tests" can be true, thorough, and still blind to all three.

They also fail in **sequence**, not together. `npm ci` runs first and takes
every job down with it, so the NOTICE failure is not even reachable until the
lockfile is fixed — which is how one change cost two red CI runs in #322 (#324).
This command evaluates all three and reports every finding at once.

**Be clear about what it does and does not do.** This repository has no git
hooks, no `.husky`, no `core.hooksPath` — and git hooks are not shared by clone
anyway — so nothing makes this run. The npm script and this section make it
**discoverable, not enforced**:

| | effect |
|---|---|
| you run it before pushing | the round-trip is eliminated |
| you don't | halved — two red pushes become one, because CI now reports both together |
| nobody ever runs it | advisory only |

It reports `COULD NOT CHECK` for the licence item when `node_modules` is absent,
and exits non-zero. That is deliberate: the item most likely to be skipped
locally must not be the one that silently reports clean.

### PR Checklist

Before submitting, ensure:
- [ ] All tests pass (`npm test`)
- [ ] Code follows the style guide (`npm run lint`)
- [ ] Documentation is updated (if applicable)
- [ ] All commits are signed off (DCO)
- [ ] PR is linked to an issue (if applicable)
- [ ] New features include tests
- [ ] If you changed workspace membership: `npm run check:workspace-artifacts`

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
