## What this changes

<!-- One paragraph. What can a user do now that they could not before? -->

## Gate

- [ ] G1 — design reviewed before implementation
- [ ] G2 — implementation complete and green
- [ ] Trivial change (typo, comment, lock refresh with no version change)

## Verification

Paste **actual output**. A test that was not run is reported as not run.

```
npm run verify
```

<!-- output here -->

- [ ] Negative-access tests included for anything touching a protected resource
- [ ] Every user-facing state exercised: loading, empty, populated, partial, error, denied,
      quarantined, flag-disabled

## Data

- [ ] No real company, person, client, matter, path, credential or account identifier is in this
      diff — in source, fixtures, tests, docs, screenshots or commit messages.
- [ ] All fixtures are obviously synthetic.

## Dependencies

- [ ] No new dependency, **or** licence, provenance, exact pin and effective permissions are
      recorded below.

## Known limitations

<!-- What did you not do, and what could still go wrong? A candid list is expected. -->
