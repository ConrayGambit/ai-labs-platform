# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

**The portfolio owner** is the primary user: a single expert operator who runs several companies
and builds products inside them. He works long, unbroken sessions and moves constantly between a
board, a conversation with an agent, a live run, a document, a repository and a terminal. He is
technical, he reads the code, and he is the only person who signs a consequential action.

Two further roles exist in the schema from the first migration, because retrofitting identity is
ruinous and staff machines are a delivery requirement:

- **Staff** — venture-scoped, deny-by-default. Staff machines run a client-only install: no agent
  ever runs there and no credential is ever stored there, so a lost machine leaks nothing.
- **Observer** — read-only.

**Open, and not to be invented:** whether any staff or observer accounts are held by real people
today, how many, and how technical they are. Nothing in the repository or the specification records
this. Until it is answered, staff-facing surfaces are designed against the role definition above and
not against an imagined person.

**Other operators are a real audience, not a hypothetical one.** The product is published under
Apache 2.0 on a public repository and is meant to be cloned, installed, run and modified by other
operators on their own machines. They are not customers and there is no hosted offering: they
self-install, hold their own credentials, and are free to fork. Two consequences bind future work.
First run must stand on its own for someone who has never read the specification and does not hold
the owner's private profile — the master spec, the wireframe, the deployment profile and the
denylist all live outside this repository by design, so nothing in the installed experience may
assume them. And every default that ships is that operator's default too: the six seeded
executives, the two gate ladders, the deny-by-default access model and the loopback bind are
product decisions made on a stranger's behalf, not personal configuration.

## Product Purpose

**One window, no jumping between applications.** Email, documents, matters, repositories, terminals,
browser, calendar, board and agents all live inside the product, and durable organizational agents
work alongside the owner inside it.

The product coordinates agents powered by several vendor runtimes through the Agent Client Protocol.
**The model powers an employee; it does not define that employee's identity.** An agent is a durable
organizational record — name, title, department, venture, responsibilities, reporting line,
authority level, memory scope and tenure — and changing which model drives it changes none of that.

Success is that the owner runs his companies and builds his products without leaving the window, and
that any card can be traced from intake, through its gates and reviews, to a signed completion, six
months later, in one result set.

## Positioning

Three claims a neighbouring product could not truthfully copy:

1. **It swallows the surfaces the work actually happens in.** A research pass across 230+ agent
   orchestrators found that each is either a coding tool or a business tool, and none absorbs both
   the development surfaces and the operating surfaces of a business. That gap is the product.
2. **The owner's own governance method is the product's method.** The builder / two independent
   reviewers / adjudication / P0-escalation protocol is not an invented feature set — it is a
   binding protocol the owner already runs by hand, implemented natively. Where the two differ, that
   is a defect in the product.
3. **It never holds a model provider credential.** It spawns each vendor's own CLI, on the user's
   machine, under the user's own login. Routing subscription credentials through third-party
   software is prohibited by providers and has cost people their accounts; the product holds
   nothing, stores nothing and proxies nothing.

## Operating Context

**Topology.** A headless core service (Node, run as a Windows Service) owns the session supervisor,
agent processes and terminals, the signed-in vendor CLIs, repositories, database, schedules, the
event bus and backups. Clients are thin and attach to a core over a private mesh network with
per-device pairing — never a forwarded port. Two install profiles: *core + client* on the owner's
server, *client only* on laptops and staff machines. **Runs survive every client disconnecting**;
the run belongs to the core, not to the window watching it.

**Shell.** The shipping client is an Electron desktop application on Windows, packaged as a signed
NSIS installer and an MSI for policy deployment. Windows conventions govern: `Ctrl` not `Cmd`, `Alt`
not `Option`, Windows title-bar conventions, Segoe UI Variable as the interface face, no macOS
traffic lights or menu bar. The browser build served by the core is a development and mesh-access
convenience; its current appearance is provisional and is not a design commitment.

**Hierarchy.** `Portfolio → Venture → Project → Task → Subtask → Run`. A venture is a durable
strategic context — a company, product line, brand, research programme or campaign umbrella. Some
ventures own a product; others are continuous operations with no product at all. Every task traces
upward through its parents to a venture goal, so it can answer why it exists.

**Staff.** Six permanent portfolio executives ship as product content — Aria (Group CEO), Sloane
(Chief of Staff), Nova (Chief Innovation Officer), Ada (CTO), Marlow (CMO) and Iris (Chief Design
Officer). They are roles, not people. The owner sits at the root of the reporting graph above them.
Beneath sit venture leads, a shared staff pool working across ventures, and dedicated agents where
isolation, exclusive ownership or focused memory is required. Staff carry a tenure class —
`permanent`, `hired` or `temporary` — and a temporary agent cannot exist without a recorded expiry
condition.

**How work moves.** Agents work a Kanban board. Exactly one agent is accountable for a card;
everyone else takes part through the card's room. The owner writes notes on cards Trello-style,
agents read them, and **no agent can write them by any route**. A project lead reviews a finished
card and either marks it done or returns it to a named agent with findings attached.

**Gates are policy, not constants.** A gate ladder attaches to a work type and is configurable per
venture. Two ship by default: a *product/code* ladder (G1 design, G2 slice, G3 pre-merge, G4
pre-deploy, G5 on demand — two independent reviewers at every gate) and a lighter *business/legal*
ladder (G1 draft review with one reviewer, G4 the owner signs). Any individual matter can be raised
to the full ladder. A heavy gate honestly applied beats a heavy gate worked around.

**Surfaces.** Twelve, per the wireframe: Command · Intake · Board · Rooms · Staff · Skills ·
Innovation Lab · Build · Venture desk · Mission Control · Connections · Anywhere. Search and a
`Ctrl+K` palette reach any venture, project, human, agent, task, document, decision, run, message or
artifact.

**Modules are switched on per venture, not globally.** One venture's desk is not another's. Four
ship in the foundation — Matters, Inbox, Deadlines, Documents. Seven further families are specified
as contracts only, with canonical objects, navigation slots, permission model and event integration,
so they can be added natively without architectural replacement.

**Embedded browsing** is a first-class surface for statutory and banking portals, delivered with a
hard partition: the owner's browsing runs in a persistent named partition with a password-manager
extension and human-initiated autofill only, and agent browsing runs in an ephemeral partition per
session with no access to the owner's cookies or storage. Agents never fill a credential field under
any circumstance.

**Voice input** is push-to-talk with a selectable engine and a **per-venture policy**. The policy
lives on the venture, not on the microphone: pressing the hotkey inside a venture flagged sensitive
routes to the on-device engine automatically and displays which engine handled it, because the cloud
default has no on-device mode and the audio would otherwise leave the machine.

**A product being built renders in-window** beside its terminal and its diff — the prompt → generate
→ preview → iterate loop.

## Capabilities and Constraints

**Runtime.** The Agent Client Protocol is *the* execution contract, not one option among several. It
provides session lifecycle, streaming updates with usage and context tracking, in-app permission
requests, tool-call reporting, filesystem and terminal access, cancellation, and MCP. A one-shot
subprocess model cannot deliver live supervision and has been retired.

**Credentials — three classes, and only three.** Vendor CLIs own their own logins and the product
never sees them. Services needing an API key store a `${VAR}` *reference* resolved from the host
environment at spawn time; the secret value never reaches the database, the logs or an export.
Product-managed OAuth on behalf of a user is prohibited outright.

**Working today.** A durable multi-project board; a provider runtime registry with real per-CLI
option lists, where an unsupported option is shown as unsupported rather than faked; the six seeded
executives over a validated reporting graph with cycle and depth prevention; a skills registry with
five vendored skills; the ACP execution core streaming a live turn that is recorded before it is
streamed, mirrored into the card's room, metered against a per-run token ceiling and interruptible;
gate ladders enforced by the service rather than the browser; rooms with one-level threads,
membership and a shared canvas; and the governance engine's review filing, adjudication, P0 stop and
append-only override register.

**In progress.** The remainder of the governance engine and the desktop client.

**Enforced invariants.** Access is deny-by-default and venture-scoped, enforced server-side.
Executables launch with `shell: false` and prompts are discrete argv values, never interpolated into
a shell. The core binds to loopback by default. Budgets warn at 80% and hard-stop at 100%. Agent-to-
agent conversation is bounded by an enforced stopping rule rather than by hope. Reviewer
independence is enforced by the application — neither reviewer sees the other's artefact before
filing, and a reviewer may not share the builder's model. A P0 finding stops the affected work and
cannot be overridden by the builder. Corrections are new entries that supersede; records are never
edited in place. Operational data and the deployment profile live outside the repository, and a path
inside it is refused at startup rather than merely ignored.

**Publication raises the cost of the missing authentication layer.** There is no authentication in
front of the core. Safety currently rests on binding to loopback and on a README instruction not to
expose the port or forward it through a router. That holds for one operator on his own machine. It
does not hold once strangers run the same code, because an instruction in a README is documentation,
not an enforced invariant, and some operator will bind `0.0.0.0` and forward a port anyway. This sits
against Principle 5 — *no open port* — and against the standard set everywhere else in this section,
where invariants are enforced server-side rather than asked for politely.

**Undecided, and recorded rather than invented:** which module family is built after the first four;
whether capability promotion ever carries a standing authorisation; when a fourth venture receives a
standing lead; the retention policy for the mirror and event log; and whether a non-loopback bind
must be refused without an explicit acknowledgement, or authentication must land, before any release
is advertised to other operators.

## Brand Commitments

- **The name is fixed: AI Labs.** Two earlier identities found in the repository — a runtime-derived
  product name, and a positioning line describing it as an alternative to another vendor's tool —
  are retired from all documentation, code comments and status files.
- **Voice.** Plain, exact and unembarrassed about immaturity. The existing README sets the register:
  "Early, and honest about it," followed by what actually exists. Claims are stated at the strength
  the evidence supports, and a limit is stated as plainly as a capability. Marketing register is
  wrong here.
- **The product's own interface identity is separate from the identities of products built inside
  it.** Per-product brand identity is a first-class object attached to a venture or product, with
  its own tokens held in the private profile, not in this repository. The Chief Design Officer
  checks a live preview against that product's tokens. The product must never impose its own look on
  what is built inside it.
- **Windows-native conventions are binding**, per Operating Context above.
- Apache 2.0, public repository, outside contribution and comment explicitly wanted.

## Evidence on Hand

**In this repository:** working source for the board, runtime registry, org graph, ACP execution
core, rooms, gate ladders and the governance engine; `docs/architecture.md`; the security invariants;
`vendor/skills/` (five vendored skills, ~180 KB); the publishable-data guard and its pre-commit hook.

**Held outside this repository, in the owner's working set alongside this checkout** — findable by
filename, deliberately not pathed here:

- `2026-08-10-ai-labs-amended-master-spec.md` — 28 sections; the current binding product record,
  amending rather than replacing the 9 August scope, with an appendix indexing all 37 amendments.
- `ai-labs-wireframe.html` — 13 sheets, every region numbered. Two sheets share a number; that is a
  wireframe defect, not a design one.
- Four research documents — the orchestrator landscape and salvage verdict; a spec coverage map;
  a skills, staffing, voice and delivery plan; and a comparative structure study of seven
  neighbouring products with adopt / adapt / avoid verdicts.
- The owner's production governance protocol, which the governance engine implements.
- The deployment profile mapping this document's generic terms to real entities, and the private
  denylist the guard reads.

**Absences that must not be fabricated.** There are no users, no customers, no testimonials, no case
studies, no press, no benchmarks, no pricing, no published release and no deployment record. The
product has one operator today and is pre-release; that other operators are an intended audience is
a distribution decision, not evidence of adoption, and must never be written as though anyone else
has installed it. Nothing in future work may imply otherwise, and no
screenshot, fixture or example may contain a real company, person, matter, path or account.

## Product Principles

1. **One window.** Anything that sends the owner out to another application is a defect in this
   product, not a boundary of it.
2. **The employee is durable; the model is a setting.** Identity, reporting line, memory scope and
   history survive a runtime change, a model change and the employee's own departure.
3. **Approval before consequence, attributed to a named human.** Protected actions belong to the
   owner and do not delegate by default. A P0 stops work. An override is logged with its residual
   risk, permanently, and never edited.
4. **Evidence over claims.** "Done" means demonstrated with actual output, both reviews filed and
   adjudicated, and the handover written. Anything less is in progress and is reported as in
   progress — including by this product's own interface, which must never show a state it has not
   verified.
5. **Hold nothing you do not need.** No model credentials. No real business data in the repository.
   No open port. No access that was not explicitly granted.

## Accessibility & Inclusion

**Voice is a first-class input path**, not an accessory: push-to-talk with a selectable engine, and
an engine policy that is a property of the venture rather than of the microphone. System-wide
dictation already reaches the application through the Windows accessibility API, so the interface
must not fight text entry that arrives without a keystroke.

**Sessions are long and unbroken**, largely at a desk, frequently at night. Sustained legibility and
low visual fatigue are product requirements, not preferences.

Accessibility defects are already a named finding class in the review ladder, so they are caught by
governance rather than by goodwill. **No formal conformance standard has been established** — that
remains open and must not be assumed.
