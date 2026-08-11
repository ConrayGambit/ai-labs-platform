# AI Labs — Core Architecture

## Purpose

AI Labs is a local-first application for running work across ventures and their projects: a governed board of cards, an organization of durable agent identities, and the runs those identities execute. Kimi Code, Claude Code, Codex, Hermes and any other runtime that speaks the **Agent Client Protocol** are launched from their own installed CLIs, so each vendor continues to own OAuth storage and token refresh.

The core is a headless service. A client attaches to it and can detach again: a run belongs to the core, not to whichever window started it.

## Runtime shape

```text
Client (React)
        |
        |  same-origin JSON over HTTP
        |  WebSocket /api/realtime — capability handshake, replayed run streams,
        |                            permission answers, cancellation
        v
Core service (Fastify) ------------------------------------- SQLite
        |
        +-- work board — cards, gate columns, artifacts, activity
        +-- governance engine — roles, sealed reviews, findings, rulings,
        |                       override register, P0 escalation
        +-- rooms — per-card conversation an agent speaks into
        +-- obsidian mirror — transactional outbox, replayed by a worker
        +-- run supervisor — one ACP session per run
                 |
                 |  session lifecycle; updates stored then fanned out; usage
                 |  metered against a cost ceiling; permission requests held
                 |  open for a person; protocol-level cancellation
                 v
        ACP client — JSON-RPC 2.0, newline-delimited, over the provider's stdio
                 |
                 v
        Provider process launched from the runtime registry
        (shell: false, windowsHide, ${VAR} environment references)
```

The bundled React client uses the JSON routes today. `/api/realtime` is the core's streaming contract: a client says what it can do, the core answers with the intersection and names anything it does not support with a reason, and the socket stays open — an older client degrades rather than failing, because the core, the laptop and staff machines will not update in step.

## Security invariants

1. OAuth tokens, API keys, passwords, and browser cookies are never copied into this application or its database.
2. Agent processes inherit the user's existing CLI login. Authentication remains owned by each provider CLI.
3. Executables are launched with `shell: false`; prompts are discrete argv values or stdin, never interpolated into a shell command.
4. A run is always scoped to a registered project root and cannot silently change its working directory.
5. Custom runtimes store only executable paths, argument arrays, non-secret metadata, and optional environment-variable *names*. The UI warns against storing secret values.
6. Runs are bounded by selected participants, fixed phases, per-agent timeout, and a maximum output size.
7. Destructive repository operations are not performed by the board itself. Any tool authority belongs to the invoked agent and its own approval policy.
8. Every state transition and agent message is written to the run timeline for auditability.

Invariant 3 binds the launch of the provider process, which is still `shell: false` with arguments taken verbatim from the runtime registry. Under ACP the prompt itself travels as a JSON-RPC parameter on that process's stdin rather than as an argv value, and never reaches a shell either way.

## Data model

- **users**, **user_venture_grants** — people, and the ventures each may reach. A run is reachable only through the venture that owns its card's project.
- **platform_portfolios**, **platform_ventures**, **platform_projects** — the governed hierarchy. A project carries its gate ladder, any raised reviewer count, and its repository path; a repository is an attribute of a project rather than a peer concept.
- **org_agents**, **departments**, **org_agent_skills** — organizational identities: name, job title, department, function, responsibilities, instructions, authority level, provider runtime and model, manager, delegation permission, tenure.
- **agents** — the provider runtime registry: command and launch arguments, environment-variable references, option templates and verified option values, output format, timeout, enabled flag. This is how a provider process is *started*; everything said to it afterwards is ACP.
- **cards**, **card_activity**, **card_artifacts** — the board. A card records its gate, the owner's notes as a column agents may not write, and the artifacts it closes on.
- **rooms**, **room_members**, **room_messages**, **room_canvas** — per-card conversation. An agent's streamed speech is mirrored into the room as it arrives.
- **agent_runs**, **agent_run_updates**, **run_permission_requests** — one ACP session per run: session id, parent run for session lineage, status and stop reason, token usage against a cost ceiling, every update in sequence, and every permission request with who answered it.
- **review_assignments**, **reviews**, **review_findings** — who builds and who reviews at each gate, the reviews filed there, and the findings inside them.
- **finding_rulings**, **finding_contests**, **p0_escalations**, **override_register** — the builder's rulings, a reviewer's single contest, P0 escalations to the owner, and the append-only override register.
- **card_specifications**, **card_handovers**, **adjudication_reports** — the three written records a gate consults: one specification per card, one handover per card, and one report per calendar day.
- **projects**, **tasks**, **runs**, **messages** — the pre-gate board, superseded by the platform project, the card and the agent run above, and still read by the retired coordinators described below.

## Governance: gates, reviews and findings

A **gate ladder** attaches to a project and is policy, not a constant. Two ship: *product and code* (**G1** design · **G2** slice · **G3** pre-merge · **G4** pre-deploy) and *business and operations* (**G1** draft review · **G4** pre-send, which the owner signs). The board's columns are derived from the ladder — backlog, ready, in progress, one column per gate, blocked, done — so raising a project's scrutiny changes its board rather than requiring a different one.

A **role is authority over one card at one gate**, not a job title. The same agent is a builder on its own card and a reviewer on somebody else's.

- **Builder** — sole write authority for the assigned work, and the one who adjudicates findings. One per card-gate, enforced by a partial unique index rather than by convention. It cannot review its own work.
- **Reviewer** — reviews within the gate's scope and never writes. A proposed fix is a proposal in the review artefact.

A reviewer may not run the builder's model, and the check runs in both assignment orders: assigning a builder onto a card that already has reviewers applies the same test, so the rule cannot be defeated by ordering. An agent with no explicit model counts as its runtime's default model, so two agents on one runtime are not treated as independent.

One reviewer is the default. A project or an individual card may raise the count, and the raise records who made it and why. Where two or more are required, **a filed review is sealed until every required review is in** — sealed from the other reviewer, whose independent judgement is the point, and from the builder, who must read both before ruling on either. An outstanding reviewer's deadline can release the seal, but only once *every* outstanding reviewer is out of time. A reviewer correcting itself files again and the earlier review is marked superseded rather than edited, so one reviewer cannot satisfy a two-reviewer gate by filing twice.

Every reviewer answers the gate's full checklist — "not applicable" is an answer, silence is not — and every finding carries evidence at `file:line` and a predicted failure, or it is a worry rather than a finding.

Findings are ranked **P0** to **P4**. The builder rules on each: *adopted*, *deferred* (which requires a named next step), or *overridden*. Adoption is not an override; every other outcome appends an entry to the override register, which has exactly one writer, no update and no delete — a correction is a new entry marking the original superseded. A reviewer may contest a ruling once, with new evidence; the re-ruling is final.

**P0 is why the ladder has a top rung.** The builder may not override one. Filing a review that carries a P0 stops the card in the same transaction that records the review — the card moves to blocked, attributed to the platform because no person chose it — and raises an escalation for the owner. The card returns to work only when the last open escalation on it is resolved.

A run that completes its turn moves its card to the ladder's first gate.

`council.ts` (proposal → critique → synthesis, with a hardcoded coordinator) and `hierarchy.ts` (whole-subtree execution) are retired by this model and are no longer the coordination protocol. Both files remain in the tree behind `/api/tasks/:taskId/council` and `/api/tasks/:taskId/hierarchy`, working against the legacy task tables. One export is shared with the new path: `roleContext`, which renders an agent's stable identity and is used by the ACP prompt builder so the two renderings cannot drift.

## Governance: the written records

Three records are not documentation about the work — they are conditions on it, checked when a card moves.

**The specification card** — thirteen sections, written before code: problem, outcome, acceptance criteria, scope, out of scope, constraints, interfaces, data and migrations, permissions and audit, failure modes, verification, rollout and rollback, open questions. G1 on the product ladder carries `requiresSpecification`, so a card cannot leave design until every section is written; whitespace counts as unwritten, because an empty heading is not an answer. Every missing section is named at once rather than one per attempt. If the card cannot be completed, the feature is not understood well enough to build.

**The handover report** — nine points, including two the spec names literally: commands run with their *actual output*, and the exact next work item. A card cannot reach done without all nine. "Actual output" is checked rather than trusted: a fenced block or a shell prompt line counts, a sentence does not, and neither a leading digit nor a Markdown blockquote is accepted — "326 tests passed" is a claim however it is punctuated, and a rule that a quotation mark defeats is not a rule.

**The daily adjudication report** — eight sections in fixed order, P0 escalations first, so the most urgent line is never the one nobody scrolls to. Every open P0 appears whatever day it was raised, since an unresolved one is still today's problem. A section with nothing to report gets an explicit sentence rather than an empty list, because *silence must be informative*: "no overrides were recorded" and a missing section are different facts and only one is reassuring. A day with no governance activity and no board movement produces no report at all — a report invented for a day nobody worked is noise that teaches people to skim. The report date must be a real calendar day; rows are matched by date prefix, so a month-shaped string would quietly gather thirty days and file them as one.

So a card closes on all of: an inspectable artifact, a complete handover, its reviews filed and adjudicated, and the owner's signature where the gate demands it. Closing is an advance whatever the card was doing beforehand — a blocked card is not exempt.

None of these have an HTTP surface yet. They are written through the repository layer, and `/api/cards/:cardId/move` reads them to decide whether a move is allowed.

## Export, and the checks around it

**The Obsidian mirror** is opt-in and has no default path: a hardcoded vault location would be personal data in a published repository. Without one configured, events are still recorded durably and simply queue in the outbox.

Export is a **transactional outbox** rather than a write at the point of the event. An event is enqueued in `platform-export-outbox` alongside the state change that produced it, and `platform-export-worker` drains the queue, so a mirror that is offline or slow delays an export and never loses one. A failed job is retried with backoff — one second, five, thirty, then five minutes — and the last failure is kept with its attempt count and next retry time, so a stuck export is a visible status rather than silence.

What leaves the application is narrower than what is stored. `obsidian-exporter` projects each event through a **payload allowlist** keyed by event type — `VentureCreated` exports a name and a kind, `ApprovalDecided` an approval id and a status — so a field added to an event later does not silently start being mirrored. YAML scalars are quoted, and each note is written to a temporary path and renamed into place, so a reader never sees a half-written file.

**The secret tripwire** (`secret-safety`) asserts six credential shapes against free-text input: assignments to `api_key`, `access_token`, `password`, `secret` or `authorization`; bearer tokens; `sk-`/`rk-`/`pk-` prefixes; GitHub `ghp_`-family and `github_pat_` tokens; AWS `AKIA` access-key ids; and PEM private-key headers. It is a tripwire for an obvious mistake, not a data-loss prevention system, and is written down as such so nobody comes to rely on it for the second thing.

**The runtime health probe** (`runtime-health`) runs a provider's own version command with `shell: false`, a five-second timeout and an 8 KB output cap, and keeps the first non-empty line. An unreachable or misconfigured CLI is visible before a run depends on it.

**The tenure sweep** (`tenure-sweep`) is what makes a recorded end date more than a promise. A pass every minute expires organizational agents whose tenure has ended. An agent that cannot be expired — today, one holding direct reports with no manager to re-parent them to — is reported as blocked rather than thrown, so one stuck record cannot stop the sweep for everyone else.

## Organizational model

Runtime adapters and organizational agents are separate. One authenticated provider runtime can power multiple job roles, while changing a role's provider does not alter its reporting line or project assignments. A role's *model* is not cosmetic: it is what reviewer independence is checked against.

Each organizational agent contains:

- display name and job title;
- department and concise job function;
- detailed responsibilities and role instructions;
- provider runtime reference and model;
- manager reference and numerical authority level;
- whether it may delegate to direct reports;
- enabled state, tenure, and project-team assignments.

The reporting graph is an acyclic forest. Manager cycles, self-management, duplicate project assignments, disabled runtimes, and excessive depth are rejected, at the schema level as well as in the repository.

The graph describes reporting, not execution. Work reaches an agent because a card is assigned to it and a run is started against that card; it does not flow down a subtree and synthesize back up. Escalation is the governance ladder above, not a management chain.

## Execution contract

**The Agent Client Protocol is the execution contract.** A run is one ACP session against one provider process, spoken as newline-delimited JSON-RPC 2.0 over that process's stdio. The transport knows nothing about ACP and the protocol client knows nothing about sockets, so each is testable without the other.

What a run gets from the protocol:

- **Session lifecycle** — `initialize` negotiates the protocol version and declares what this client can do; `session/new` opens the session in the project's own checkout, never the core's directory; the session id is recorded on the run.
- **Streamed updates** — message and thought chunks, tool calls and their updates, plans, and usage. Every update is stored with a monotonic per-run sequence *before* it is fanned out, so a client that arrives late or reconnects replays exactly what happened in the order it happened, and can never see an update missing from the record it would replay from.
- **Permission requests** — `session/request_permission` is persisted and then held open for a person with access to the card's venture. Nothing has a default answer: with no handler listening the client denies, and an unanswered request blocks its tool call rather than being treated as consent by a client that went away.
- **Cancellation** — at the protocol level, including a cancel that arrives while the provider is still starting, which is applied the moment the session exists.
- **Metering** — reported usage accumulates on the run, and crossing a cost ceiling cancels the session and records that the platform, not the agent, ended the run.

A prompt is assembled in three tiers and sent as separate content blocks so the boundary is visible in the transcript: **stable** (who the agent is), **context** (the card, the owner's read-only notes, assigned skills), **volatile** (this turn's message).

Two extension points remain, and neither touches the protocol:

- **The runtime registry** decides how a provider process is *launched*: executable, argument array, environment-variable references, option templates with verified value lists, version-probe arguments, timeout and output cap. Adding a runtime that speaks ACP is a registry entry.
- **The gate ladder** decides how work is *governed*: gates, per-gate reviewer counts, independence, and where the owner signs. Adding a ladder changes a project's board and its evidence requirements, and changes nothing about projects, cards, runs or messages.
