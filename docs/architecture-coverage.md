# Architecture document coverage

Every module under `src/server` and `src/shared` is either mentioned in
[architecture.md](architecture.md) or listed here. `tests/docs/architecture-coverage.test.ts`
enforces it, so a module cannot arrive undocumented and unnoticed — which is
what happened twice, and is why this file exists.

Two kinds of entry:

- **`documented as "…"`** — the document covers this file under a different
  phrase. The phrase is **checked**: if the document stops using it, this entry
  fails. Most entries are these, and together they map the code's filenames onto
  the document's vocabulary.
- **`waived: …`** — the document does not cover this file, and here is why.
  Unverified by design, so keep it to implementation detail.

An entry must be a single line, and must name a file that exists. A line that
begins like an entry and matches neither form is reported rather than ignored.

**A mention is not an accuracy check.** This file keeps modules from going
unmentioned; it cannot tell whether what the document says about them is true.

## Documented under another phrase

- `src/server/gate-policy.ts` — documented as "gate ladder"
- `src/server/governance-policy.ts` — documented as "override register"
- `src/server/governance-repository.ts` — documented as "sealed until every required review is in"
- `src/server/governance-service.ts` — documented as "P0 escalation"
- `src/server/acp/connection.ts` — documented as "newline-delimited"
- `src/server/run-prompt.ts` — documented as "three tiers"
- `src/server/run-repository.ts` — documented as "every update in sequence"
- `src/server/room-repository.ts` — documented as "per-card conversation"
- `src/server/work-api.ts` — documented as "work board"
- `src/server/work-repository.ts` — documented as "gate columns"
- `src/server/identity-repository.ts` — documented as "the ventures each may reach"

## Waived

- `src/shared/domain.ts` — waived: shared type declarations; the document describes the objects, not where their types live.
- `src/shared/wire.ts` — waived: the realtime message union; the document describes the handshake it carries.
- `src/server/platform-schemas.ts` — waived: request validation shapes; the document covers what is validated, not where.
- `src/server/platform-repository.ts` — waived: persistence for the governed hierarchy the document already describes by table.
- `src/server/platform-service.ts` — waived: intake orchestration over the approval lifecycle described in the document.
- `src/server/platform-api.ts` — waived: HTTP surface for the platform tables; routes are named where they carry meaning.
- `src/server/org-repository.ts` — waived: persistence for the organizational model described in the document.
- `src/server/platform-default-portfolio.ts` — waived: first-run seed data, not architecture.
- `src/server/conversation-guard.ts` — waived: enforces the stopping limits on agent-to-agent conversation; the document states that a run is bounded, not where each bound is applied.
