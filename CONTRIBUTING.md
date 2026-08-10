# Contributing to AI Labs

## The one rule that is never negotiable

**No real data enters this repository.** No real company, product, person, client, matter,
filesystem path, credential or account identifier — in source, seeds, fixtures, tests,
documentation, commit messages or screenshots.

Every fixture must be obviously synthetic on sight. `npm run guard` enforces this and runs as a
pre-commit hook. **Do not weaken the guard to make a commit pass.**

If you maintain a deployment with real names, keep a private denylist file outside the repository —
one lower-case term per line. The guard reads `../_private/.denylist`, a sibling of the checkout,
without being asked, so the strongest rule runs on every commit instead of only when someone
remembers to export a variable first.

To keep it elsewhere, name it:

```bash
export AI_LABS_DENYLIST=/path/outside/the/repo/.denylist
npm run guard
```

A denylist named by hand must exist. The guard fails rather than quietly falling back to the
generic rules, because a mistyped path that reports a clean repository is precisely the outcome
this check exists to prevent.

With no denylist at all — which is every clone outside your own deployment — the guard still
enforces its generic rules: personal home paths, arbitrary absolute paths, real email addresses.

## Getting set up

```bash
npm ci
git config core.hooksPath .githooks
npm run verify
```

`npm run verify` runs the data guard, type checking, the full test suite and a production build.
All four must pass before you open a pull request.

If the native SQLite module was built for a different Node ABI than the one you run, `npm rebuild
better-sqlite3` fixes it.

Operational data and your deployment profile live **outside** this repository, under
`%LOCALAPPDATA%\AI Labs\` (or `$XDG_DATA_HOME/AI Labs/`). Override with `AI_LABS_DATA_DIR` and
`AI_LABS_PROFILE_DIR`. A path inside the repository is refused at startup.

## Install gitleaks

The pre-commit hook scans staged changes for secrets and **blocks the commit if `gitleaks` cannot be
found**. It is not optional: a warning that scanning was skipped is a warning nobody reads, and this
is a public repository.

```bash
winget install Gitleaks.Gitleaks
```

The hook does not rely on PATH alone. `scripts/find-gitleaks.mjs` also checks the directories
winget, scoop, chocolatey and Homebrew install into, because a shell started **before** the install
still carries the old PATH — an editor terminal or a git GUI left open across an install will not
see a perfectly good gitleaks. That is not hypothetical: it is how this hook was found to have been
skipping scans. If your install lives somewhere else again, set `GITLEAKS_PATH` to the binary.

## How changes are reviewed

Pull requests are reviewed against a written gate. An external contribution enters at **G2**:

- Two reviewers file **independently** — neither reads the other's review before writing their own.
  Convergence is evidence; divergence is signal. Manufactured convergence is one opinion counted
  twice.
- Findings carry a priority:

  | Priority | Meaning |
  |---|---|
  | **P0** | Security or access-control defect, data loss, licence violation, secret exposure, irreversible architecture commitment. **Blocks the merge and cannot be overridden by a maintainer.** |
  | **P1** | A stated requirement unmet, contract mismatch, missing permission or audit coverage, missing negative test on a protected resource, migration without a rollback. |
  | **P2** | Correctness or robustness defect, unhandled failure mode, idempotency or concurrency gap, material test gap. |
  | **P3** | UX defect, missing state, accessibility failure, performance regression, misleading copy. |
  | **P4** | Style, naming, structure, documentation. |

- Every finding states the **concrete failure it predicts**, not a style preference dressed as a
  defect, and cites evidence as `file:line`.

## Tests

- **A test that was not run is reported as not run.** Never describe a test as passing without
  pasting its output.
- Anything touching a protected resource needs a **negative-access test** that asserts denial, not
  merely the absence of a crash.
- Any user-facing change must exercise every state: loading, empty, populated, partial, error,
  **denied**, **quarantined**, flag-disabled. A missing denied or quarantined state is a P1, because
  it misrepresents the security model.

## Commits

- Small and coherent — one logical change each.
- Sign off with the Developer Certificate of Origin: `git commit -s`.
- Never `--no-verify`. If a hook fails, fix the cause.

## Adding a dependency

Before building a capability by hand, search for one that already exists. "You built this and X
already does it" is a legitimate P2 finding.

Nothing is added until: the licence and provenance are identified and compatible; maintenance and
open CVEs are assessed; the version is pinned exactly; and, for any skill, plugin or MCP server, its
**effective permissions are recorded from an actual test** rather than from its documentation.

## Security

Never open a public issue for a vulnerability. See [SECURITY.md](SECURITY.md).
