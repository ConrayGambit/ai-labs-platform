# Hermes Orchestrator — MVP Architecture

## Purpose

Hermes Orchestrator is a local-first application for managing multiple development projects on one Kanban board and coordinating authenticated AI coding agents in an explicit reporting hierarchy. Hermes is the default root coordinator. Kimi Code, Claude Code, Codex, and future runtimes are invoked through their installed CLIs so each vendor continues to own OAuth storage and token refresh. It has no Buzz dependency.

## Runtime shape

```text
Browser dashboard (React)
        |
        | same-origin JSON + event polling
        v
Local API (Fastify) -------------------- SQLite
        |
        +-- task/run state machine
        +-- agent organization and reporting graph
        +-- bounded council coordinator
        +-- bounded hierarchical coordinator
        +-- safe process adapter (shell: false)
                 |-- hermes chat -q <prompt>
                 |-- kimi -p <prompt> --output-format text
                 |-- claude -p <prompt> ...
                 |-- codex exec <prompt>
                 `-- user-defined executable + argument template
```

## Security invariants

1. OAuth tokens, API keys, passwords, and browser cookies are never copied into this application or its database.
2. Agent processes inherit the user's existing CLI login. Authentication remains owned by each provider CLI.
3. Executables are launched with `shell: false`; prompts are discrete argv values or stdin, never interpolated into a shell command.
4. A run is always scoped to a registered project root and cannot silently change its working directory.
5. Custom runtimes store only executable paths, argument arrays, non-secret metadata, and optional environment-variable *names*. The UI warns against storing secret values.
6. Council runs are bounded by selected participants, fixed phases, per-agent timeout, and a maximum output size.
7. Destructive repository operations are not performed by the board itself. Any tool authority belongs to the invoked agent and its own approval policy.
8. Every state transition and agent message is written to the run timeline for auditability.

## Data model

- **projects** — name, local path, description, color, timestamps.
- **tasks** — project, title, description, Kanban status, priority, assignee, rank, timestamps.
- **agents** — provider runtime adapters: runtime kind, command, argv template, output parser, enabled/coordinator flags, timeout.
- **org_agents** — organizational identities: name, job title, department, function, responsibilities, instructions, authority level, runtime, manager, delegation permission.
- **project_agent_assignments** — reusable organizational agents assigned to individual development projects.
- **runs** — task, mode (`direct` or `council`), coordinator, state, timing, failure reason.
- **run_participants** — agent role and execution state for a run.
- **messages** — proposal, critique, synthesis, system/error, content, agent, timing.
- **run_events** — append-only operational timeline.

## Council protocol

1. **Proposal:** selected workers independently answer the task brief.
2. **Critique:** each worker receives the other proposals and identifies risks, disagreements, and improvements.
3. **Synthesis:** Hermes receives the task, proposals, and critiques and produces the final recommendation or execution brief.
4. **Review:** the task moves to Review; a human explicitly decides whether to accept further code-changing work.

The protocol does not permit open-ended autonomous conversation in the MVP.

## Organizational hierarchy

Runtime adapters and organizational agents are separate. One authenticated provider runtime can power multiple job roles, while changing a role's provider does not alter its reporting line or project assignments.

Each organizational agent contains:

- display name and job title;
- department and concise job function;
- detailed responsibilities and role instructions;
- provider runtime reference;
- manager reference and numerical authority level;
- whether it may delegate to direct reports;
- enabled state and project-team assignments.

The reporting graph is an acyclic forest. Manager cycles, self-management, duplicate project assignments, disabled runtimes, and excessive depth are rejected. Hermes normally occupies the root role.

Hierarchical execution is bounded:

1. Hermes or a selected root receives the task and project context.
2. Work moves through the reporting graph to the relevant specialists.
3. Specialists return role-scoped findings to their direct manager.
4. Managers review and synthesize direct reports before reporting upward.
5. Hermes records the final synthesis and moves the task to Review.

The application caps hierarchy depth, participants, subprocess time, output size, and the number of upward synthesis passes. Code-changing execution remains human-approved.

## Extensibility contract

A runtime definition contains:

- stable ID and display name;
- executable and argument template array;
- prompt transport (`argument` or `stdin`);
- output format (`text`, `json`, or `jsonl`) and optional result field;
- version-probe arguments;
- timeout and output cap;
- coordinator capability flag.

Placeholders are replaced as individual values: `{prompt}`, `{projectPath}`, `{taskId}`, and `{runId}`. Adding an ACP transport later does not change projects, tasks, runs, or messages.

## Deliverable location

The working source lives at `/root/hermes-orchestrator` in the isolated build environment. The verified Windows-ready source archive will be produced alongside it as `/root/hermes-orchestrator.zip`.
