# AI Labs

One place to run your companies and build your products, with AI agents working alongside you
inside it.

AI Labs coordinates durable organizational agents powered by Claude Code, Codex, Kimi, Hermes and
other runtimes. **The model powers an employee; it does not define that employee's identity.**

## Status

Early, and honest about it. What exists today:

- Multiple projects on a durable SQLite Kanban board.
- A provider runtime registry for Hermes, Kimi Code, Claude Code, Codex, DeepSeek and MiniMax, plus
  custom CLIs. Model, speed and effort are dropdowns fed by each provider's real option lists;
  a runtime with no flag for an option shows it as unsupported rather than pretending.
- A prebuilt executive team — Group CEO, Chief of Staff, Chief Innovation Officer, CTO, CMO and
  Chief Design Officer — with reporting lines, authority levels and skill assignments.
- A skills registry with five vendored skills, plus the built-in skill systems of Claude Code,
  Codex and Hermes.
- Organizational agents with a name, title, department, function, responsibilities, instructions,
  authority level, runtime, manager and delegation permission, over a validated reporting graph
  with cycle and depth prevention.

- **The Agent Client Protocol execution core.** An agent works a card as a live streamed turn:
  every update is recorded before it is streamed, mirrored into the card's room, metered against a
  per-run token ceiling, and interruptible. A tool the agent may not run on its own asks you, and
  waits.
- **Gate ladders as policy.** A project's board columns come from its ladder. A card cannot close
  on nothing, and the gate is enforced by the service, not by the browser.
- **Rooms.** One per card, with one-level threads, membership and a shared canvas.

What is in progress: the governance engine (two-reviewer independence, adjudication, the override
register), and the desktop client.

## Credentials — read this first

**AI Labs never holds a model provider credential.** It spawns each vendor's own CLI, on your
machine, under your own login. Claude Code holds its own OAuth. Codex holds its own. Kimi holds its
own. AI Labs holds nothing, stores nothing and proxies nothing.

This is deliberate. Anthropic does not permit third-party developers to offer Claude.ai login or to
route requests through subscription plan credentials on behalf of users, and providers have
suspended accounts for it. For services that need an API key, AI Labs stores only a `${VAR}`
*reference* resolved from the host environment at spawn time — the secret value never touches the
database, the logs or an export.

## Requirements

- Node.js 22 or later
- The provider CLIs you intend to use, installed and authenticated separately
- Existing local repositories for the projects you register

## Getting started

```bash
npm ci
npm rebuild better-sqlite3
npm run verify
npm run dev
```

Operational data and your deployment profile live **outside** this repository:

| Variable | Default | Holds |
|---|---|---|
| `AI_LABS_DATA_DIR` | `%LOCALAPPDATA%\AI Labs\data` | Database, worktrees, artifacts, run output |
| `AI_LABS_PROFILE_DIR` | `%LOCALAPPDATA%\AI Labs\profile` | Ventures, staffing, policy packs, configuration |

A path inside the repository is refused at startup, not merely gitignored.

## Running a card

This is the whole loop, and it works today.

1. **Create a project.** It belongs to a venture, and it carries a gate ladder — `product` (G1
   design, G2 slice, G3 pre-merge, G4 pre-deploy) or `business` (G1 draft review, G4 the owner
   signs). The ladder decides the board's columns.
2. **Create a card.** `POST /api/cards` creates the card and its room together, so there is never a
   card whose conversation lives nowhere.
3. **Write your notes on it.** `PUT /api/cards/:cardId/notes`. Agents read these and are told they
   are read-only. **No agent can write them** — not through the card update, not through the
   activity log, not through a request body claiming to be you.
4. **Assign one agent.** Exactly one is accountable. Everyone else takes part through the room.
5. **Start a run.** `POST /api/cards/:cardId/runs` returns as soon as the run is recorded — it does
   not wait for the agent to finish.
6. **Watch it.** Connect to `GET /api/realtime`, say hello, and subscribe to the run. You get the
   whole transcript replayed from the beginning and then the live stream.
7. **Answer when it asks.** If the agent needs permission for a tool call, it stops and asks you.
   Nothing is allowed by default, and an unanswered request stays pending — including across a
   restart. An agent never proceeds because a client went away.
8. **Attach an artifact**, then advance the card. A card cannot reach `done` with nothing to
   inspect, and it cannot leave a gate without the reviews that gate requires.

**Runs continue when every client is closed.** The run belongs to the core service, not to the
window watching it. Close the browser mid-run, reopen it, reconnect — you get everything back from
the first update onward, and the work never stopped.

### Reaching it from another machine

The core binds to `127.0.0.1` by default. To reach it from your laptop while it runs on your own
server, bind it to your **private mesh** interface:

```bash
AI_LABS_HOST=0.0.0.0 npm start
```

**Do not expose the port to the public internet, and do not forward it through a router.** There is
no authentication in front of it yet. Remote reach comes from a private mesh network and nothing
else.

## No real data in this repository

Every venture, department, person and piece of business data is created at runtime and lives in your
profile directory. Nothing about a real business is committed here, ever. `npm run guard` enforces
it and runs on every commit. See [CONTRIBUTING.md](CONTRIBUTING.md).

## Contributing

Contributions and comments are welcome. Start with [CONTRIBUTING.md](CONTRIBUTING.md). Security
issues go to [SECURITY.md](SECURITY.md), never a public issue.

## Licence

Apache License 2.0 — see [LICENSE](LICENSE).
