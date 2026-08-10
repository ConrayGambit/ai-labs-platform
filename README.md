# AI Labs Platform

A transparent, local-first alternative to Buzz for coordinating development agents. It runs as ordinary Node.js/TypeScript source and a loopback web dashboard; it does not depend on, bundle, or invoke the Buzz desktop application.

## What it supports

- Multiple local development projects on a durable SQLite Kanban board.
- Provider runtimes for Hermes, Kimi Code, Claude Code, Codex, DeepSeek, MiniMax, and custom CLIs. DeepSeek and MiniMax have no official agent CLI; both expose Anthropic-compatible APIs, so they run through the installed Claude Code CLI with an endpoint environment bridge (`ANTHROPIC_BASE_URL` + a `${VAR}` reference to your API key — never the key itself).
- Model / speed / effort tuning as dropdowns fed by each provider's real option lists (verified against official docs, August 2026): Claude Code models + `--effort`, Codex models + `model_reasoning_effort`, Kimi thinking via `--thinking`, DeepSeek V4 models, MiniMax M-series models including the faster `-highspeed` variants. Runtimes without a flag for an option show it as unsupported instead of pretending.
- A prebuilt executive team in the default organization: Group CEO, Chief of Staff, Chief Innovation Officer, CTO, CMO, and Chief Design Officer, with reporting lines, authority levels, and skill assignments. Edit or extend them like any other agents.
- A skills registry covering design/marketing tools (Taste, Impeccable, Playwright CLI, awesome-design, img2threejs — vendored copies ship in `vendor/skills/`) plus the built-in skill systems of Claude Code, Codex, and Hermes. Assigned skills are injected into hierarchy prompts as guidance.
- Organizational agents with a name, job title, department, job function, responsibilities, role instructions, authority level, runtime, manager, and delegation permission.
- A visible reporting hierarchy with cycle and maximum-depth prevention.
- Project-specific teams made from reusable organizational agents.
- Bounded hierarchy runs: specialists report to direct managers, managers synthesize upward, and the root coordinator produces the final review result.
- Bounded council runs with independent proposals, cross-critique, and Hermes synthesis.
- Attributed transcripts that record both the provider runtime and the organizational identity.
- Runtime probes, subprocess timeouts, bounded output, and `shell: false` execution.

## Security model

AI Labs Platform **does not store OAuth tokens, API keys, passwords, cookies, or browser sessions**. Kimi Code, Claude Code, Codex, and Hermes continue to own their authentication and token refresh. Runtime environment configuration stores only endpoint URLs and `${VAR}` *references* to secrets (for example `${DEEPSEEK_API_KEY}`), which are resolved from the host environment at spawn time — the secret value never touches the database. The database stores only non-secret agent roles, executable commands, argument templates, option value lists, projects, tasks, runs, and transcripts.

Do not disable antivirus protection or add exclusions for Buzz. This project is intended to run transparently from source. If a native installer is produced later, it should be code-signed rather than relying on antivirus bypasses.

## Requirements

- Node.js 20 or later.
- The provider CLIs you intend to use, installed and configured separately.
- Existing local repositories for projects you register.

A CLI being installed is not the same as being ready for inference. Complete each official CLI's own login and model-selection flow before assigning it to a role.

## Run on Windows

Open PowerShell in the extracted project directory:

```powershell
npm install
npm run build
npm start
```

Then open <http://127.0.0.1:4317>.

The server binds to loopback only by default. Its SQLite database is written to `./data/orchestrator.db`.

## First-run workflow

1. Click **+** beside Projects and register an existing local repository path.
2. Open **Organization**.
3. Create a root coordinator, normally powered by Hermes. Give it a high authority level and enable **Can delegate**.
4. Create managers and specialists, choosing their job title, function, provider runtime, and direct manager.
5. Return to **Board**, create a task, and click **Run hierarchy**.
6. Review the attributed output before accepting any code-changing work.

New agents are automatically added to the currently selected project. Create the project before its team in this MVP.

## Development

```bash
npm install
npm run dev
```

The API listens on `127.0.0.1:4317`; Vite listens on `127.0.0.1:4318` and proxies `/api`.

## Verification

```bash
npm test
npm run typecheck
npm run build
```

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `ORCHESTRATOR_HOST` | `127.0.0.1` | Server bind address. Keep loopback unless remote access is explicitly secured. |
| `ORCHESTRATOR_PORT` | `4317` | Local HTTP port. |
| `ORCHESTRATOR_DATA_DIR` | `./data` | Directory containing the SQLite database. |

## Current MVP limits

- Source distribution only; no signed native installer yet.
- Hierarchy runs use a bounded synchronous request; streaming and cancellation UI are future work.
- When a project has multiple root agents, the board currently uses the first assigned root.
- Existing agents cannot yet be bulk-assigned to a newly created project from the UI; create the project first.
- The Kanban API supports movement and ranking, but drag-and-drop UI is not included yet.
