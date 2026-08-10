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

What is in progress: the Agent Client Protocol execution core, rooms, the governance engine and the
desktop client.

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

## No real data in this repository

Every venture, department, person and piece of business data is created at runtime and lives in your
profile directory. Nothing about a real business is committed here, ever. `npm run guard` enforces
it and runs on every commit. See [CONTRIBUTING.md](CONTRIBUTING.md).

## Contributing

Contributions and comments are welcome. Start with [CONTRIBUTING.md](CONTRIBUTING.md). Security
issues go to [SECURITY.md](SECURITY.md), never a public issue.

## Licence

Apache License 2.0 — see [LICENSE](LICENSE).
