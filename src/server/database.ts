import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { TASK_STATUSES } from '../shared/domain.js';
import { applyMigrations } from './migrations.js';
import { createIdentityRepository, type IdentityRepository } from './identity-repository.js';
import { createOrgRepository, type OrgRepository } from './org-repository.js';
import { createPlatformRepository, type PlatformRepository } from './platform-repository.js';
import { createRoomRepository, type RoomRepository } from './room-repository.js';
import { createGovernanceRepository, type GovernanceRepository } from './governance-repository.js';
import { createRunRepository, type RunRepository } from './run-repository.js';
import { createWorkRepository, type WorkRepository } from './work-repository.js';
import { assertTenureOrdering, type Dedication, type ExpiryKind, type Tenure } from '../shared/org.js';
import type {
  AgentKind,
  AgentOutputFormat,
  AgentRuntime,
  CreateAgentInput,
  CreateOrganizationInput,
  CreateOrgAgentInput,
  CreateProjectInput,
  CreateRunInput,
  CreateRunMessageInput,
  CreateSkillInput,
  CreateTaskInput,
  DashboardStats,
  KanbanBoard,
  Organization,
  OrgAgent,
  OrchestrationRun,
  Project,
  PromptTransport,
  RecentRun,
  RunMessage,
  RunMode,
  RunStatus,
  RuntimeOptionChoices,
  RuntimeOptionTemplates,
  RuntimeEnv,
  Skill,
  SkillCategory,
  Task,
  TaskPriority,
  TaskStatus,
} from '../shared/domain.js';

const MAX_HIERARCHY_DEPTH = 6;

interface AgentRow {
  id: string;
  name: string;
  kind: AgentKind;
  command: string;
  args_json: string;
  acp_command: string | null;
  acp_args_json: string;
  prompt_transport: PromptTransport;
  output_format: AgentOutputFormat;
  result_field: string | null;
  version_args_json: string;
  option_templates_json: string;
  option_values_json: string;
  env_json: string;
  enabled: number;
  is_coordinator: number;
  timeout_ms: number;
  created_at: string;
  updated_at: string;
}

interface OrganizationRow {
  id: string;
  name: string;
  description: string;
  color: string;
  created_at: string;
  updated_at: string;
}

interface SkillRow {
  id: string;
  name: string;
  slug: string;
  description: string;
  category: SkillCategory;
  source_url: string;
  install_command: string;
  instructions: string;
  builtin: number;
  enabled: number;
  created_at: string;
  updated_at: string;
}

interface OrgAgentRow {
  id: string;
  organization_id: string;
  name: string;
  job_title: string;
  department: string;
  job_function: string;
  responsibilities: string;
  instructions: string;
  runtime_id: string;
  manager_id: string | null;
  authority_level: number;
  can_delegate: number;
  model: string | null;
  speed: string | null;
  effort: string | null;
  skill_ids?: string | null;
  enabled: number;
  tenure: Tenure;
  expiry_kind: ExpiryKind | null;
  expiry_at: string | null;
  venture_id: string | null;
  department_id: string | null;
  dedication: Dedication;
  dedication_reason: string | null;
  reports_to_user_id: string | null;
  created_at: string;
  updated_at: string;
}

interface ProjectRow {
  id: string;
  organization_id: string;
  name: string;
  path: string;
  description: string;
  color: string;
  created_at: string;
  updated_at: string;
}

interface TaskRow {
  id: string;
  project_id: string;
  title: string;
  description: string;
  status: TaskStatus;
  priority: TaskPriority;
  assigned_agent_id: string | null;
  position: number;
  created_at: string;
  updated_at: string;
}

interface RunRow {
  id: string;
  task_id: string;
  mode: RunMode;
  status: RunStatus;
  coordinator_agent_id: string;
  root_org_agent_id: string | null;
  error: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

interface MessageRow {
  id: string;
  run_id: string;
  task_id: string;
  agent_id: string | null;
  org_agent_id: string | null;
  phase: RunMessage['phase'];
  role: RunMessage['role'];
  content: string;
  created_at: string;
}

const BUILTIN_AGENTS = [
  {
    id: 'hermes',
    name: 'Hermes Coordinator',
    kind: 'hermes',
    command: 'hermes',
    args: ['chat', '-q', '{prompt}'],
    acpCommand: null,
    acpArgs: [],
    outputFormat: 'text',
    resultField: null,
    coordinator: 1,
    env: {},
  },
  {
    id: 'kimi',
    name: 'Kimi Code',
    kind: 'kimi',
    command: 'kimi',
    args: ['-p', '{prompt}', '--output-format', 'text'],
    acpCommand: null,
    acpArgs: [],
    outputFormat: 'text',
    resultField: null,
    coordinator: 0,
    env: {},
  },
  {
    id: 'claude',
    name: 'Claude Code',
    kind: 'claude',
    command: 'claude',
    args: ['-p', '{prompt}', '--output-format', 'json', '--max-turns', '10'],
    // Claude Code's own CLI has no ACP mode — verified against `claude --help`
    // on v2.1.226, 2026-08-11: no acp subcommand, no --acp, no
    // --experimental-acp. The adapter carries its own agent runtime through
    // @anthropic-ai/claude-agent-sdk, so the claude CLI is not needed for it.
    // Executed end to end 2026-08-11: initialize -> protocolVersion 1,
    // session/new -> a real session id.
    acpCommand: 'npm:@agentclientprotocol/claude-agent-acp',
    acpArgs: [],
    outputFormat: 'json',
    resultField: 'result',
    coordinator: 0,
    env: {},
  },
  {
    id: 'codex',
    name: 'OpenAI Codex',
    kind: 'codex',
    command: 'codex',
    args: ['exec', '{prompt}'],
    // @agentclientprotocol/codex-acp bundles @openai/codex, so no separate
    // install; auth is CODEX_API_KEY, OPENAI_API_KEY or ChatGPT login. From
    // the project README, 2026-08-11 — documented, not executed here.
    acpCommand: 'npm:@agentclientprotocol/codex-acp',
    acpArgs: [],
    outputFormat: 'text',
    resultField: null,
    coordinator: 0,
    env: {},
  },
  {
    // Prime Intellect open-sourced Prime Agent on 6 August 2026 (MIT). It speaks
    // ACP natively and its sessions are daemon-backed (survive disconnect,
    // reattach with `prime-agent attach <agent>` / `--resume <path|id>`), but
    // this task registers only the print-mode spawn invocation confirmed in
    // the commit message. Choosing whether it connects over ACP instead
    // (src/server/acp/) is a separate task with its own test surface.
    id: 'prime',
    name: 'Prime Agent',
    kind: 'custom',
    command: 'prime-agent',
    args: ['-p', '{prompt}'],
    acpCommand: null,
    acpArgs: [],
    outputFormat: 'text',
    resultField: null,
    coordinator: 0,
    env: {},
  },
  {
    // DeepSeek has no official agent CLI; its API is Anthropic-compatible, so it
    // runs through the installed Claude Code CLI against the DeepSeek endpoint.
    id: 'deepseek',
    name: 'DeepSeek (via Claude Code)',
    kind: 'custom',
    command: 'claude',
    args: ['-p', '{prompt}', '--output-format', 'json', '--max-turns', '10'],
    // Same adapter as claude, reached through the ANTHROPIC_BASE_URL this row
    // already sets. Documented, not executed: the redirection assumes the
    // bundled Agent SDK honours that variable the way the Claude CLI does.
    acpCommand: 'npm:@agentclientprotocol/claude-agent-acp',
    acpArgs: [],
    outputFormat: 'json',
    resultField: 'result',
    coordinator: 0,
    env: {
      ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic',
      ANTHROPIC_AUTH_TOKEN: '${DEEPSEEK_API_KEY}',
      ANTHROPIC_API_KEY: '${DEEPSEEK_API_KEY}',
    },
  },
  {
    // MiniMax has no official agent CLI; its API is Anthropic-compatible, so it
    // runs through the installed Claude Code CLI against the MiniMax endpoint.
    id: 'minimax',
    name: 'MiniMax (via Claude Code)',
    kind: 'custom',
    command: 'claude',
    args: ['-p', '{prompt}', '--output-format', 'json', '--max-turns', '10'],
    // Same adapter as claude, reached through the ANTHROPIC_BASE_URL this row
    // already sets. Documented, not executed: the redirection assumes the
    // bundled Agent SDK honours that variable the way the Claude CLI does.
    acpCommand: 'npm:@agentclientprotocol/claude-agent-acp',
    acpArgs: [],
    outputFormat: 'json',
    resultField: 'result',
    coordinator: 0,
    env: {
      ANTHROPIC_BASE_URL: 'https://api.minimax.io/anthropic',
      ANTHROPIC_AUTH_TOKEN: '${MINIMAX_API_KEY}',
      ANTHROPIC_API_KEY: '${MINIMAX_API_KEY}',
    },
  },
  {
    // Gemini CLI speaks ACP natively — `gemini --acp`, per docs/cli/acp-mode.md
    // on google-gemini/gemini-cli@main, checked 2026-08-11. (--experimental-acp
    // is the former name of the same flag.) The single-shot fields come from
    // docs/cli/headless.md: -p enters headless mode, --output-format json
    // returns one object whose top-level `response` is the final answer.
    // Documented, not executed: the CLI is not installed on the machine this
    // was written on, and no run has been made through it.
    id: 'gemini',
    name: 'Gemini CLI',
    kind: 'custom',
    command: 'gemini',
    args: ['-p', '{prompt}', '--output-format', 'json'],
    acpCommand: 'npm:@google/gemini-cli',
    acpArgs: ['--acp'],
    outputFormat: 'json',
    resultField: 'response',
    coordinator: 0,
    env: {},
  },
] as const;

export const DEFAULT_ORGANIZATION_ID = 'default-org';

/**
 * No runtime in this registry publishes a launch flag for output speed, as of
 * the dates recorded in the commit message for every runtime checked (claude,
 * codex, kimi, hermes, prime; deepseek/minimax have no dedicated CLI). This is
 * deliberate absence, not an oversight: `org_agents.speed` is a real column
 * and `TuningOptionField` renders a `Speed` label for it, but no CLI flag
 * exists to send it on yet. MiniMax comes closest — its `-highspeed` model
 * variants are a genuine speed axis — and it is modeled as a model choice
 * (see the `minimax` comment in BUILTIN_OPTION_VALUES below), not as a speed
 * template, because the flag that varies is `--model`, not a separate speed
 * flag. Add a `speed` key here only when a provider CLI actually accepts one.
 */
const BUILTIN_OPTION_TEMPLATES: Record<string, RuntimeOptionTemplates> = {
  claude: {
    model: ['--model', '{value}'],
    effort: ['--effort', '{value}'],
  },
  codex: {
    model: ['--model', '{value}'],
    effort: ['-c', 'model_reasoning_effort={value}'],
  },
  kimi: {
    // `-m`/`--model` overrides the configured default model for one run
    // (kimi-command reference, "Model selection"). Thinking is a boolean
    // launch flag, not a valued option: any truthy effort selection appends
    // `--thinking`.
    model: ['--model', '{value}'],
    effort: ['--thinking'],
  },
  hermes: {
    // `hermes chat` accepts `-m`/`--model` to override the model for one run
    // (full CLI reference at hermes-agent.nousresearch.com/docs/reference/
    // cli-commands — the top-level README only documents the interactive
    // `/model` and `hermes model` paths, which undersells this). No
    // effort/thinking launch flag is documented anywhere in that reference;
    // "reasoning effort" appears only as a config.yaml agent default (listed
    // under what `hermes migrate` carries over), never as a `hermes chat`
    // flag, so effort is deliberately left unpublished here rather than
    // invented. `--provider <name>` is also real (a closed list of ~30
    // backends) but has no matching RuntimeOptionKey to attach to, so it is
    // left unmapped rather than folded into `model` — unlike Prime Agent,
    // Hermes's `--model`/`--provider` split does not document a combined
    // `provider/id` pattern for `--model` itself.
    model: ['--model', '{value}'],
  },
  deepseek: {
    model: ['--model', '{value}'],
  },
  minimax: {
    model: ['--model', '{value}'],
  },
  prime: {
    // `--model <pattern>` takes a free-form pattern (`provider/id`, optional
    // `:thinking` suffix) with no published enum — `prime-agent model list`
    // queries it live — so no curated optionValues.model is published either;
    // see BUILTIN_OPTION_VALUES.prime. `--thinking <level>` is a closed,
    // documented enum and is published below. `--provider <name>` exists but
    // has no matching RuntimeOptionKey and is left unmapped, same reasoning
    // as Hermes above.
    model: ['--model', '{value}'],
    effort: ['--thinking', '{value}'],
  },
};

/**
 * Provider-accurate dropdown choices, re-verified against each provider's own
 * current documentation on 2026-08-11 (one line per runtime — flag, values,
 * source URL, date checked — is in the commit message that introduced this
 * comment). The prior "verified August 2026" comment here named no source and
 * had drifted: codex's model and effort lists were both stale, and claude's
 * effort list was missing a value the CLI's own --help documents. Only keys
 * with a matching option template emit CLI flags; a runtime absent from this
 * map, or missing a key present in BUILTIN_OPTION_TEMPLATES, gets the
 * "middle case" free-text field rather than an invented enum (see
 * TuningOptionField) — hermes, kimi and prime's `model` keys are examples:
 * each has a confirmed --model/-m flag but no published fixed value list.
 */
const BUILTIN_OPTION_VALUES: Record<string, RuntimeOptionChoices> = {
  claude: {
    // claude-mythos-5 is also current but deliberately excluded: it is gated
    // to the Project Glasswing invite program, not generally available.
    model: ['claude-opus-5', 'claude-sonnet-5', 'claude-fable-5', 'claude-haiku-4-5'],
    // Note: claude-haiku-4-5 rejects --effort; leave effort unset for Haiku agents.
    effort: ['low', 'medium', 'high', 'xhigh', 'max'],
  },
  codex: {
    // gpt-5.1-codex-max/-codex/-codex-mini (the prior list) no longer appear
    // anywhere in OpenAI's current model docs, not even as deprecated. The
    // current "Recommended models" section actually lists FOUR CLI-available
    // models, not three: these plus gpt-5.3-codex-spark, a ChatGPT-Pro-only,
    // text-only research preview (no API access, no Codex cloud, not on the
    // web surface). Deliberately excluded as not generally available, same
    // reasoning as claude-mythos-5 above being left off the claude list —
    // stated here rather than left for the next re-verification pass to miss.
    model: ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'],
    // Confirmed exact enum from OpenAI's own config reference
    // (model_reasoning_effort: "minimal | low | medium | high | xhigh").
    // The prior list had "none", which is not a documented value; xhigh is
    // noted there as model-dependent, so it may not apply to every model above.
    effort: ['minimal', 'low', 'medium', 'high', 'xhigh'],
  },
  kimi: {
    // -m/--model is a real flag, but Kimi is multi-provider/multi-platform
    // (Kimi Code, Moonshot CN/Global, or a configured OpenAI/Anthropic/Gemini/
    // Vertex provider) with no fixed catalog — models are picked from a
    // dynamic list via the /login wizard, so no curated list is published
    // here (see BUILTIN_OPTION_TEMPLATES.kimi). Thinking is a boolean flag;
    // this single sentinel value drives it on.
    effort: ['high'],
  },
  deepseek: {
    // Legacy aliases deepseek-chat / deepseek-reasoner were retired July 2026.
    model: ['deepseek-v4-pro', 'deepseek-v4-flash'],
  },
  minimax: {
    // Speed is a model choice: each -highspeed variant ~100 tps vs ~60 tps standard.
    model: [
      'MiniMax-M3',
      'MiniMax-M2.7',
      'MiniMax-M2.7-highspeed',
      'MiniMax-M2.5',
      'MiniMax-M2.5-highspeed',
      'MiniMax-M2.1',
      'MiniMax-M2.1-highspeed',
      'MiniMax-M2',
    ],
  },
  prime: {
    // Confirmed exact enum from packages/coding-agent/docs/usage.md's Model
    // Options table (--thinking <level>). No optionValues.model: --model
    // takes a free-form pattern, not an enum (see BUILTIN_OPTION_TEMPLATES).
    effort: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
  },
};

const BUILTIN_SKILLS = [
  {
    id: 'skill-taste',
    name: 'Taste Skill',
    slug: 'design-taste-frontend',
    description:
      'Anti-slop frontend design framework: infer the design language from the brief, then tune variance, motion, and density instead of shipping boilerplate UI.',
    category: 'design',
    sourceUrl: 'https://github.com/Leonxlnx/taste-skill',
    installCommand: 'npx skills add https://github.com/Leonxlnx/taste-skill',
    instructions: [
      'Apply the Taste Skill for interface work. Read the brief first and infer a deliberate design language before coding; do not ship generic SaaS boilerplate.',
      'Tune three dials (1-10): DESIGN_VARIANCE for layout experimentation (higher = asymmetric/modern), MOTION_INTENSITY for animation depth (hover → scroll/magnetic GSAP), VISUAL_DENSITY for information per viewport (spacious → dense dashboards).',
      'Banned AI-slop tells: Inter-everything typography, purple-to-blue gradients, cards nested in cards, gray text on colored backgrounds, the rounded-square icon tile above every heading, and em-dashes in UI copy.',
      'A vendored copy of the full SKILL.md ships with this platform at vendor/skills/taste-skill/SKILL.md. Install globally with `npx skills add https://github.com/Leonxlnx/taste-skill` (install name design-taste-frontend); variants exist for minimalist, brutalist, high-end, and image-to-code workflows.',
    ].join('\n'),
  },
  {
    id: 'skill-impeccable',
    name: 'Impeccable',
    slug: 'impeccable',
    description:
      'Design quality system with 23 commands and 59 deterministic anti-slop detector rules for AI-generated frontend design.',
    category: 'design',
    sourceUrl: 'https://github.com/pbakaus/impeccable',
    installCommand: 'npx impeccable install',
    instructions: [
      'Apply Impeccable for design review and polish. Its command vocabulary includes polish, audit, critique, distill, animate, bolder, quieter, harden, clarify, typeset, layout, and onboard.',
      'Anti-patterns to avoid: overused fonts (Arial, Inter, system defaults), gray text on colored backgrounds, pure black/gray without tint, wrapping everything in cards or nesting cards, and bounce/elastic easing.',
      'For a new project, gather design context first (audience, brand lane, voice, colors, type, components) as the skill\'s `/impeccable init` flow would, and let it steer later passes.',
      'A vendored copy ships with this platform at vendor/skills/impeccable/SKILL.md. Deterministic checks run without a model via `npx impeccable detect <path>`; install globally with `npx impeccable install`.',
    ].join('\n'),
  },
  {
    id: 'skill-playwright-cli',
    name: 'Playwright CLI',
    slug: 'playwright-cli',
    description:
      'Token-efficient browser automation: drive a real browser through concise CLI commands instead of loading page trees into model context.',
    category: 'browser',
    sourceUrl: 'https://github.com/microsoft/playwright-cli',
    installCommand: 'npm install -g @playwright/cli@latest',
    instructions: [
      'Use playwright-cli to verify web work in a real browser. Core loop: `playwright-cli open <url>`, then `playwright-cli snapshot` to obtain element refs, then act by ref: click, type, fill, check, hover, select.',
      'Capture evidence with `playwright-cli screenshot` (optionally --hires or --filename), `playwright-cli pdf`, `playwright-cli console` for console messages, and `playwright-cli requests` for network activity.',
      'Isolate work with named sessions (`playwright-cli -s=<name> ...`), persist storage with `state-save` / `state-load`, and inspect running sessions with `playwright-cli list` / `show`.',
      'A vendored copy ships with this platform at vendor/skills/playwright-cli/SKILL.md. Install the CLI with `npm install -g @playwright/cli@latest`, then `playwright-cli install --skills` so coding agents pick up the bundled skills.',
    ].join('\n'),
  },
  {
    id: 'skill-awesome-design',
    name: 'Awesome Design (DESIGN.md)',
    slug: 'awesome-design-md',
    description:
      'Curated library of DESIGN.md design-system documents extracted from real products (Linear, Vercel, Stripe, Notion, Apple) for consistent AI-generated UI.',
    category: 'design',
    sourceUrl: 'https://github.com/VoltAgent/awesome-design-md',
    installCommand: 'git clone https://github.com/VoltAgent/awesome-design-md',
    instructions: [
      'Use the awesome-design-md collection when a target look is named or a brand direction must stay consistent. A DESIGN.md is a plain-text design system any agent can read.',
      'Each document captures: visual theme and atmosphere, color palette with semantic roles, typography hierarchy, component stylings with states, layout principles and spacing scale, depth/elevation, do\'s and don\'ts, responsive behavior, and ready-to-use agent prompts.',
      'Workflow: pick the closest reference (e.g. Linear for ultra-minimal product UI, Stripe for elegant fintech, Vercel for black-and-white precision), copy its DESIGN.md into the project root, and build to match it exactly.',
      'A vendored index ships with this platform at vendor/skills/awesome-design-md/README.md. Full collection: https://github.com/VoltAgent/awesome-design-md',
    ].join('\n'),
  },
  {
    id: 'skill-img2threejs',
    name: 'img2threejs',
    slug: 'img2threejs',
    description:
      'Rebuild an object from a reference image as a code-only, procedural Three.js model — quality-gated, animation-ready, no mesh files.',
    category: '3d',
    sourceUrl: 'https://github.com/img2threejs/img2threejs',
    installCommand: 'git clone https://github.com/img2threejs/img2threejs.git',
    instructions: [
      'Use img2threejs to reconstruct a reference image as a procedural Three.js model written in TypeScript — primitives, generated geometry, and procedural shaders only; never downloaded art packs.',
      'Pipeline: classify the subject (object / character / hybrid), enumerate the identity-defining detail inventory (bevels, panel seams, fasteners, engraved linework, gloss vs matte zones, wear), then advance staged passes — blockout, structural, form, material, surface, lighting, interaction, optimization — each gated by a side-by-side render-vs-reference review.',
      'Never fake a detail that cannot be placed on a real component; report per-region confidence for anything the image cannot show. Deliver a THREE.Group factory with pivots, sockets, and userData.tick so the result is ready to animate.',
      'A vendored copy of the full SKILL.md ships with this platform at vendor/skills/img2threejs/SKILL.md. Skill source: https://github.com/img2threejs/img2threejs (its helper scripts need only Python 3.10+ stdlib).',
    ].join('\n'),
  },
  {
    id: 'skill-claude-code-builtins',
    name: 'Claude Code built-in skills',
    slug: 'claude-code-builtins',
    description:
      'Anthropic-format agent skills loaded by the Claude Code CLI from ~/.claude/skills (personal), .claude/skills (project), or installed plugins.',
    category: 'custom',
    sourceUrl: 'https://code.claude.com/docs/en/skills',
    installCommand: 'mkdir -p ~/.claude/skills/<name> && add a SKILL.md with YAML frontmatter',
    instructions: [
      'Claude Code skills are on-demand knowledge packs in agentskills.io format: a SKILL.md with `name` and `description` frontmatter, plus optional supporting files.',
      'Discovery order: plugin skills, then personal skills in ~/.claude/skills/<name>/SKILL.md, then project skills in <project>/.claude/skills/<name>/SKILL.md. Claude auto-invokes a skill when its description matches the task; users can also call /skill-name directly.',
      'To add one of the registry skills (Taste, Impeccable, Playwright CLI, awesome-design, img2threejs) to Claude Code, place its SKILL.md under ~/.claude/skills/ or the target project\'s .claude/skills/ directory.',
      'Machine status (verified 2026-08-09): ~/.claude exists (Claude Code is in use) but no personal skills are installed yet.',
    ].join('\n'),
  },
  {
    id: 'skill-codex-builtins',
    name: 'Codex built-in skills',
    slug: 'codex-builtin-plugins',
    description:
      'OpenAI Codex plugins and skills from the bundled marketplace (~/.codex), including browser, visualize, and documents capabilities.',
    category: 'custom',
    sourceUrl: 'https://developers.openai.com/codex/plugins',
    installCommand: 'enable plugins in ~/.codex/config.toml under [plugins."<name>@<marketplace>"]',
    instructions: [
      'Codex loads capabilities as plugins from configured marketplaces in ~/.codex/config.toml; enabled plugins inject their skills and tools into Codex sessions.',
      'This machine has the openai-bundled and openai-primary-runtime marketplaces configured with the browser, visualize, and documents plugins enabled (verified 2026-08-09).',
      'Project-level guidance lives in AGENTS.md at the repository root; keep agent-facing conventions there so Codex picks them up automatically.',
      'Community skills in agentskills.io format can be added under ~/.agents/skills/<name>/SKILL.md for CLIs that read the shared agents directory (none installed on this machine yet).',
    ].join('\n'),
  },
  {
    id: 'skill-hermes-builtins',
    name: 'Hermes built-in skills + Skills Hub',
    slug: 'hermes-builtin-skills',
    description:
      'Nous Research Hermes ships builtin-trust skills (e.g. duckduckgo-search fallback), creates its own skills from experience, and installs community skills from agentskills.io.',
    category: 'custom',
    sourceUrl: 'https://github.com/NousResearch/hermes-agent',
    installCommand: 'hermes skills install skills-sh/<owner>/<repo>/<skill>',
    instructions: [
      'Hermes skills are procedural memory: the agent writes new skills after complex tasks and improves them during use. Trust levels: builtin (ships with Hermes), official (repo optional-skills/), trusted registries (openai, anthropics, huggingface, NVIDIA), community (everything else, security-scanned before use).',
      'Install from the Skills Hub with `hermes skills install skills-sh/<owner>/<repo>/<skill>`; use `hermes skills inspect` to review upstream metadata and audit status before `--force` overrides (never overrides a dangerous verdict).',
      'Conditional activation: fallback skills hide automatically when their premium toolset is available (e.g. the builtin duckduckgo-search skill appears only when the web toolset is unavailable).',
      'Machine status (verified 2026-08-09): one Hermes skill installed at ~/.hermes/skills/workspace-dispatch — a single-agent mission orchestrator (decompose → spawn worker per task → verify exit criteria → chain).',
    ].join('\n'),
  },
] as const;

/**
 * Seeded reporting lines. Aria is the root of the agent graph and reports to the
 * owner once a user exists. The Chief of Staff is a coordinating layer rather
 * than a peer, per the role definition.
 *
 * The Chief Innovation Officer reports to the Group CEO, not the Chief of Staff:
 * her promotion boundary is the owner's alone, and routing her through the Chief
 * of Staff would imply an approval path that does not exist.
 */
const EXECUTIVE_MANAGER: Record<string, string | null> = {
  'exec-ceo': null,
  'exec-chief-of-staff': 'exec-ceo',
  'exec-cino': 'exec-ceo',
  'exec-cto': 'exec-chief-of-staff',
  'exec-cmo': 'exec-chief-of-staff',
  'exec-cdo': 'exec-chief-of-staff',
};

/**
 * Prebuilt executive team for the default organization. Seeded only for
 * file-backed databases (production), never for :memory: test fixtures.
 * Stable ids keep reseeding idempotent via INSERT OR IGNORE.
 */
const BUILTIN_EXECUTIVES = [
  {
    id: 'exec-ceo',
    name: 'Aria',
    jobTitle: 'Group CEO',
    department: 'Executive',
    jobFunction:
      'Own company strategy, final decisions, and cross-organization priorities. Root of the executive reporting line.',
    responsibilities:
      'Set mission and guardrails, arbitrate executive disagreement, approve major commitments, and review synthesized reports from the Chief of Staff and executive team.',
    instructions:
      'Operate at strategy level: delegate execution to direct reports, demand evidence and dissent before deciding, and keep decisions bounded and reversible where possible. Preserve material dissent in final summaries.',
    runtimeId: 'hermes',
    authorityLevel: 100,
    canDelegate: true,
    model: null,
    speed: null,
    effort: null,
    skillIds: [] as string[],
  },
  {
    id: 'exec-chief-of-staff',
    name: 'Sloane',
    jobTitle: 'Chief of Staff',
    department: 'Executive',
    jobFunction:
      'Run the CEO\'s operating rhythm: prioritize inbound work, coordinate the executive team, and turn strategy into tracked execution.',
    responsibilities:
      'Triage and route work to the right executive, prepare decision briefs for the Group CEO, follow up on commitments, and keep cross-functional initiatives unblocked.',
    instructions:
      'Be crisp and organized. Convert ambiguity into a short list of owners, deadlines, and next actions. Escalate only true decision points to the CEO with options and a recommendation.',
    runtimeId: 'claude',
    authorityLevel: 90,
    canDelegate: true,
    model: 'claude-opus-5',
    speed: null,
    effort: 'high',
    skillIds: [] as string[],
  },
  {
    id: 'exec-cino',
    name: 'Nova',
    jobTitle: 'Chief Innovation Officer',
    department: 'Executive',
    jobFunction:
      'Own the innovation pipeline: scan new AI platforms, agent runtimes, and design tools; prototype bets; graduate winners into the organization.',
    responsibilities:
      'Evaluate new products and research (agent platforms, CLIs, skill ecosystems), run small experiments, and recommend adopt / watch / drop calls with evidence.',
    instructions:
      'Think in portfolios: many small bets, fast kill criteria, clear graduation gates. Always compare against what the team already has before recommending new tooling.',
    runtimeId: 'kimi',
    authorityLevel: 90,
    canDelegate: true,
    model: null,
    speed: null,
    effort: 'high',
    skillIds: ['skill-hermes-builtins', 'skill-claude-code-builtins', 'skill-codex-builtins'],
  },
  {
    id: 'exec-cto',
    name: 'Ada',
    jobTitle: 'Chief Technology Officer',
    department: 'Executive',
    jobFunction:
      'Own technical strategy, architecture, and engineering quality across all projects.',
    responsibilities:
      'Approve architecture and runtime choices, review implementation risk, protect local-first data boundaries, and verify that work ships with tests and evidence.',
    instructions:
      'Prefer maintainable, local-first designs. Reject unverifiable claims: every technical recommendation needs reproducible evidence. Keep credential material out of stores and prompts.',
    runtimeId: 'claude',
    authorityLevel: 90,
    canDelegate: true,
    model: 'claude-sonnet-5',
    speed: null,
    effort: null,
    skillIds: [] as string[],
  },
  {
    id: 'exec-cmo',
    name: 'Marlow',
    jobTitle: 'Chief Marketing Officer',
    department: 'Executive',
    jobFunction:
      'Own positioning, messaging, and go-to-market for everything the organization ships.',
    responsibilities:
      'Define narrative and channel strategy, review campaign copy and creative, keep the brand voice consistent, and measure message-market fit.',
    instructions:
      'Lead with the outcome, then proof, then the ask. Ground claims in the product\'s real capabilities — never promise features that do not exist. Use the assigned design skills to keep creative distinctive.',
    runtimeId: 'codex',
    authorityLevel: 80,
    canDelegate: true,
    // gpt-5.6-terra: the balanced, everyday-work tier — the same relative
    // position (not the flagship, not the cheapest) the retired gpt-5.1-codex
    // held before this task's re-verification found it gone from the current
    // model docs. Reaches fresh installs only: model is an owner's-choice
    // field, never rewritten by reseed (spec 4.1.3) — correct behavior, not
    // a shortfall, see the runtime-registry commit's follow-up note.
    model: 'gpt-5.6-terra',
    speed: null,
    effort: 'medium',
    skillIds: ['skill-taste', 'skill-awesome-design'],
  },
  {
    id: 'exec-cdo',
    name: 'Iris',
    jobTitle: 'Chief Design Officer',
    department: 'Executive',
    jobFunction:
      'Own visual and interaction quality across product and marketing surfaces.',
    responsibilities:
      'Set the design language, run anti-slop design review, approve UI direction, and keep typography, color, and motion deliberate.',
    instructions:
      'Every surface gets a deliberate design language inferred from the brief — no generic SaaS boilerplate. Apply the Taste, Impeccable, and awesome-design skills; call out AI-slop patterns by name.',
    runtimeId: 'claude',
    authorityLevel: 80,
    canDelegate: true,
    model: 'claude-sonnet-5',
    speed: null,
    effort: 'medium',
    skillIds: ['skill-taste', 'skill-impeccable', 'skill-awesome-design'],
  },
] as const;

function mapAgent(row: AgentRow): AgentRuntime {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    command: row.command,
    argsTemplate: JSON.parse(row.args_json) as string[],
    acpCommand: row.acp_command,
    acpArgs: JSON.parse(row.acp_args_json || '[]') as string[],
    promptTransport: row.prompt_transport,
    outputFormat: row.output_format,
    resultField: row.result_field,
    versionArgs: JSON.parse(row.version_args_json) as string[],
    optionTemplates: JSON.parse(row.option_templates_json || '{}') as RuntimeOptionTemplates,
    optionValues: JSON.parse(row.option_values_json || '{}') as RuntimeOptionChoices,
    env: JSON.parse(row.env_json || '{}') as RuntimeEnv,
    enabled: row.enabled === 1,
    isCoordinator: row.is_coordinator === 1,
    timeoutMs: row.timeout_ms,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapOrganization(row: OrganizationRow): Organization {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    color: row.color,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapSkill(row: SkillRow): Skill {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    description: row.description,
    category: row.category,
    sourceUrl: row.source_url,
    installCommand: row.install_command,
    instructions: row.instructions,
    builtin: row.builtin === 1,
    enabled: row.enabled === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapOrgAgent(row: OrgAgentRow): OrgAgent {
  return {
    id: row.id,
    organizationId: row.organization_id,
    name: row.name,
    jobTitle: row.job_title,
    department: row.department,
    jobFunction: row.job_function,
    responsibilities: row.responsibilities,
    instructions: row.instructions,
    runtimeId: row.runtime_id,
    managerId: row.manager_id,
    authorityLevel: row.authority_level,
    canDelegate: row.can_delegate === 1,
    model: row.model ?? null,
    speed: row.speed ?? null,
    effort: row.effort ?? null,
    skillIds: row.skill_ids ? row.skill_ids.split(',').filter(Boolean) : [],
    enabled: row.enabled === 1,
    tenure: row.tenure,
    expiryKind: row.expiry_kind ?? null,
    expiryAt: row.expiry_at ?? null,
    ventureId: row.venture_id ?? null,
    departmentId: row.department_id ?? null,
    dedication: row.dedication,
    dedicationReason: row.dedication_reason ?? null,
    reportsToUserId: row.reports_to_user_id ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapProject(row: ProjectRow): Project {
  return {
    id: row.id,
    organizationId: row.organization_id,
    name: row.name,
    path: row.path,
    description: row.description,
    color: row.color,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapTask(row: TaskRow): Task {
  return {
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    description: row.description,
    status: row.status,
    priority: row.priority,
    assignedAgentId: row.assigned_agent_id,
    position: row.position,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapRun(row: RunRow): OrchestrationRun {
  return {
    id: row.id,
    taskId: row.task_id,
    mode: row.mode,
    status: row.status,
    coordinatorAgentId: row.coordinator_agent_id,
    rootOrgAgentId: row.root_org_agent_id,
    error: row.error,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

function mapMessage(row: MessageRow): RunMessage {
  return {
    id: row.id,
    runId: row.run_id,
    taskId: row.task_id,
    agentId: row.agent_id,
    orgAgentId: row.org_agent_id,
    phase: row.phase,
    role: row.role,
    content: row.content,
    createdAt: row.created_at,
  };
}

export interface OrchestratorDatabase {
  listAgents(): AgentRuntime[];
  getAgent(agentId: string): AgentRuntime | null;
  createAgent(input: CreateAgentInput): AgentRuntime;
  updateAgentOptions(
    agentId: string,
    patch: {
      optionTemplates?: RuntimeOptionTemplates;
      optionValues?: RuntimeOptionChoices;
      env?: RuntimeEnv;
    },
  ): AgentRuntime;
  listOrganizations(): Organization[];
  getOrganization(organizationId: string): Organization | null;
  createOrganization(input: CreateOrganizationInput): Organization;
  listSkills(): Skill[];
  getSkill(skillId: string): Skill | null;
  createSkill(input: CreateSkillInput): Skill;
  listOrgAgentSkills(orgAgentId: string): Skill[];
  createOrgAgent(input: CreateOrgAgentInput): OrgAgent;
  getOrgAgent(orgAgentId: string): OrgAgent | null;
  listOrgAgents(): OrgAgent[];
  setOrgAgentManager(orgAgentId: string, managerId: string | null): OrgAgent;
  assignOrgAgentToProject(projectId: string, orgAgentId: string): void;
  listProjectOrgAgents(projectId: string): OrgAgent[];
  createProject(input: CreateProjectInput): Project;
  listProjects(): Project[];
  getProject(projectId: string): Project | null;
  createTask(input: CreateTaskInput): Task;
  getTask(taskId: string): Task | null;
  moveTask(taskId: string, status: TaskStatus, position: number): Task;
  getBoard(projectId: string): KanbanBoard;
  createRun(input: CreateRunInput): OrchestrationRun;
  getRun(runId: string): OrchestrationRun | null;
  updateRunStatus(runId: string, status: RunStatus, error?: string): OrchestrationRun;
  addRunMessage(input: CreateRunMessageInput): RunMessage;
  listRunMessages(runId: string): RunMessage[];
  listRecentRuns(limit?: number): RecentRun[];
  getDashboardStats(): DashboardStats;
  /** Human identities, roles and venture-scoped access. Deny by default. */
  identity: IdentityRepository;
  /** Departments, tenure, permanence and re-parenting. */
  org: OrgRepository;
  /** Portfolio, venture, governed project, approval and event persistence. */
  platform: PlatformRepository;
  /** The card board agents work off: cards, owner notes, activity, artifacts. */
  work: WorkRepository;
  /** Per-card rooms: membership, one-level threads and a shared canvas. */
  rooms: RoomRepository;
  /** Agent runs and their replayable update transcripts. */
  runs: RunRepository;
  /** Roles, reviews, findings, rulings and the override register. */
  governance: GovernanceRepository;
  /**
   * The underlying connection, for services that must span repositories inside
   * one transaction. Repositories remain the way to reach data; this exists so
   * a governance action that stops a card cannot half-happen.
   */
  connection: Database.Database;
  close(): void;
}

export function createDatabase(filename: string): OrchestratorDatabase {
  if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true });

  const connection = new Database(filename);
  connection.pragma('foreign_keys = ON');
  connection.pragma('journal_mode = WAL');
  applyMigrations(connection);

  const now = new Date().toISOString();
  const seed = connection.prepare(`
    INSERT OR IGNORE INTO agents (
      id, name, kind, command, args_json, prompt_transport, output_format,
      result_field, version_args_json, env_json, enabled, is_coordinator, timeout_ms,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 'argument', ?, ?, '["--version"]', ?, 1, ?, 600000, ?, ?)
  `);
  const seedOrganization = connection.prepare(`
    INSERT OR IGNORE INTO organizations (id, name, description, color, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const seedSkill = connection.prepare(`
    INSERT INTO skills (
      id, name, slug, description, category, source_url, install_command,
      instructions, builtin, enabled, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 1, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      slug = excluded.slug,
      description = excluded.description,
      category = excluded.category,
      source_url = excluded.source_url,
      install_command = excluded.install_command,
      instructions = excluded.instructions,
      updated_at = excluded.updated_at
  `);
  const mergeBuiltinOptions = (
    agentId: string,
    column: 'option_templates_json' | 'option_values_json',
    builtins: RuntimeOptionTemplates | RuntimeOptionChoices,
  ): void => {
    // Merge only missing keys: user-edited flags and values are never overwritten.
    const row = connection.prepare(`SELECT ${column} AS json FROM agents WHERE id = ?`).get(agentId) as
      | { json: string }
      | undefined;
    if (!row) return;
    const current = JSON.parse(row.json || '{}') as Record<string, unknown>;
    let changed = false;
    for (const [key, value] of Object.entries(builtins)) {
      if (!(key in current)) {
        current[key] = value;
        changed = true;
      }
    }
    if (changed) {
      connection.prepare(`UPDATE agents SET ${column} = ? WHERE id = ?`).run(JSON.stringify(current), agentId);
    }
  };
  connection.transaction(() => {
    seedOrganization.run(
      DEFAULT_ORGANIZATION_ID,
      'AI Labs',
      'Default organization for every team and project.',
      '#7170ff',
      now,
      now,
    );
    for (const agent of BUILTIN_AGENTS) {
      seed.run(
        agent.id,
        agent.name,
        agent.kind,
        agent.command,
        JSON.stringify(agent.args),
        agent.outputFormat,
        agent.resultField,
        JSON.stringify(agent.env),
        agent.coordinator,
        now,
        now,
      );
    }
    for (const [agentId, templates] of Object.entries(BUILTIN_OPTION_TEMPLATES)) {
      mergeBuiltinOptions(agentId, 'option_templates_json', templates);
    }
    for (const [agentId, values] of Object.entries(BUILTIN_OPTION_VALUES)) {
      mergeBuiltinOptions(agentId, 'option_values_json', values);
    }
    for (const agent of BUILTIN_AGENTS) {
      // Backfill env for builtin runtimes that predate the env column or were
      // seeded before their env bridge was defined; never overwrite user edits.
      if (Object.keys(agent.env).length === 0) continue;
      const row = connection.prepare('SELECT env_json AS json FROM agents WHERE id = ?').get(agent.id) as
        | { json: string }
        | undefined;
      if (!row) continue;
      const current = JSON.parse(row.json || '{}') as Record<string, string>;
      let changed = false;
      for (const [key, value] of Object.entries(agent.env)) {
        if (!(key in current)) {
          current[key] = value;
          changed = true;
        }
      }
      if (changed) {
        connection.prepare('UPDATE agents SET env_json = ? WHERE id = ?').run(JSON.stringify(current), agent.id);
      }
    }
    for (const agent of BUILTIN_AGENTS) {
      // Backfill for builtin runtimes seeded before the ACP columns existed.
      // Guarded on NULL rather than on the row's other columns: NULL is the
      // precise "never set" state, so an owner's own adapter is never
      // overwritten. Same posture as the env and option backfills above.
      if (!agent.acpCommand) continue;
      connection
        .prepare('UPDATE agents SET acp_command = ?, acp_args_json = ? WHERE id = ? AND acp_command IS NULL')
        .run(agent.acpCommand, JSON.stringify(agent.acpArgs), agent.id);
    }
    for (const skill of BUILTIN_SKILLS) {
      seedSkill.run(
        skill.id,
        skill.name,
        skill.slug,
        skill.description,
        skill.category,
        skill.sourceUrl,
        skill.installCommand,
        skill.instructions,
        now,
        now,
      );
    }
    if (filename !== ':memory:') {
      const seedExecutive = connection.prepare(`
        INSERT OR IGNORE INTO org_agents (
          id, organization_id, name, job_title, department, job_function, responsibilities,
          instructions, runtime_id, manager_id, authority_level, can_delegate,
          model, speed, effort, enabled, tenure, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'permanent', ?, ?)
      `);
      const seedExecutiveSkill = connection.prepare(`
        INSERT OR IGNORE INTO org_agent_skills (org_agent_id, skill_id, created_at) VALUES (?, ?, ?)
      `);
      /**
       * Reseed policy. Identity (id, name, job_title) is written once and never
       * again. Doctrine text is refreshed from the seed ONLY while the owner has
       * not edited it, so genuine corrections reach existing databases without
       * overwriting deliberate changes. Model, speed, effort and runtime are the
       * owner's choice and are never written by seeding after the first insert.
       */
      const refreshDoctrine = connection.prepare(`
        UPDATE org_agents
           SET department = ?, job_function = ?, responsibilities = ?, instructions = ?,
               updated_at = ?
         WHERE id = ? AND doctrine_edited_at IS NULL
      `);
      for (const executive of BUILTIN_EXECUTIVES) {
        seedExecutive.run(
          executive.id,
          DEFAULT_ORGANIZATION_ID,
          executive.name,
          executive.jobTitle,
          executive.department,
          executive.jobFunction,
          executive.responsibilities,
          executive.instructions,
          executive.runtimeId,
          // Not `?? 'exec-ceo'`: the CEO's manager is deliberately null, and `??`
          // would treat that as absent and make her report to herself.
          executive.id in EXECUTIVE_MANAGER ? EXECUTIVE_MANAGER[executive.id] : 'exec-ceo',
          executive.authorityLevel,
          executive.canDelegate ? 1 : 0,
          executive.model,
          executive.speed,
          executive.effort,
          now,
          now,
        );
        refreshDoctrine.run(
          executive.department,
          executive.jobFunction,
          executive.responsibilities,
          executive.instructions,
          now,
          executive.id,
        );
        for (const skillId of executive.skillIds) {
          seedExecutiveSkill.run(executive.id, skillId, now);
        }
      }
    }
  })();

  const getAgent = (agentId: string): AgentRuntime | null => {
    const row = connection.prepare('SELECT * FROM agents WHERE id = ?').get(agentId) as
      | AgentRow
      | undefined;
    return row ? mapAgent(row) : null;
  };

  const ORG_AGENT_SELECT = `
    SELECT org_agents.*, assigned_skills.skill_ids AS skill_ids
    FROM org_agents
    LEFT JOIN (
      SELECT org_agent_id, GROUP_CONCAT(skill_id) AS skill_ids
      FROM (
        SELECT org_agent_id, skill_id
        FROM org_agent_skills
        ORDER BY created_at, rowid
      )
      GROUP BY org_agent_id
    ) AS assigned_skills ON assigned_skills.org_agent_id = org_agents.id
  `;

  const getOrgAgent = (orgAgentId: string): OrgAgent | null => {
    const row = connection
      .prepare(`${ORG_AGENT_SELECT} WHERE org_agents.id = ?`)
      .get(orgAgentId) as OrgAgentRow | undefined;
    return row ? mapOrgAgent(row) : null;
  };

  const getOrganization = (organizationId: string): Organization | null => {
    const row = connection.prepare('SELECT * FROM organizations WHERE id = ?').get(organizationId) as
      | OrganizationRow
      | undefined;
    return row ? mapOrganization(row) : null;
  };

  const getSkill = (skillId: string): Skill | null => {
    const row = connection.prepare('SELECT * FROM skills WHERE id = ?').get(skillId) as
      | SkillRow
      | undefined;
    return row ? mapSkill(row) : null;
  };

  const getRun = (runId: string): OrchestrationRun | null => {
    const row = connection.prepare('SELECT * FROM runs WHERE id = ?').get(runId) as
      | RunRow
      | undefined;
    return row ? mapRun(row) : null;
  };

  const assertManagerAssignment = (orgAgentId: string, managerId: string | null): void => {
    if (managerId === null) return;
    const immediateManager = getOrgAgent(managerId);
    if (!immediateManager) throw new Error(`Organizational agent not found: ${managerId}`);
    let cursor: string | null = managerId;
    let depth = 0;
    while (cursor !== null) {
      if (cursor === orgAgentId) throw new Error('Reporting cycle detected');
      const manager = getOrgAgent(cursor);
      if (!manager) throw new Error(`Organizational agent not found: ${cursor}`);
      cursor = manager.managerId;
      depth += 1;
      if (depth > MAX_HIERARCHY_DEPTH) {
        throw new Error(`Hierarchy exceeds maximum depth of ${MAX_HIERARCHY_DEPTH}`);
      }
    }
    if (!immediateManager.canDelegate) {
      throw new Error(`Manager cannot delegate: ${immediateManager.id}`);
    }
  };

  return {
    listAgents() {
      return connection
        .prepare('SELECT * FROM agents ORDER BY rowid')
        .all()
        .map((row) => mapAgent(row as AgentRow));
    },
    getAgent,
    createAgent(input) {
      const timestamp = new Date().toISOString();
      const runtime: AgentRuntime = {
        id: randomUUID(),
        name: input.name,
        kind: 'custom',
        command: input.command,
        argsTemplate: input.argsTemplate,
        acpCommand: input.acpCommand ?? null,
        acpArgs: input.acpArgs ?? [],
        promptTransport: input.promptTransport ?? 'argument',
        outputFormat: input.outputFormat ?? 'text',
        resultField: input.resultField ?? null,
        versionArgs: input.versionArgs ?? ['--version'],
        optionTemplates: input.optionTemplates ?? {},
        optionValues: input.optionValues ?? {},
        env: input.env ?? {},
        enabled: true,
        isCoordinator: false,
        timeoutMs: input.timeoutMs ?? 600_000,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      connection
        .prepare(`
          INSERT INTO agents (
            id, name, kind, command, args_json, acp_command, acp_args_json,
            prompt_transport, output_format,
            result_field, version_args_json, option_templates_json, option_values_json,
            env_json, enabled, is_coordinator, timeout_ms, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, ?, ?, ?)
        `)
        .run(
          runtime.id,
          runtime.name,
          runtime.kind,
          runtime.command,
          JSON.stringify(runtime.argsTemplate),
          runtime.acpCommand,
          JSON.stringify(runtime.acpArgs),
          runtime.promptTransport,
          runtime.outputFormat,
          runtime.resultField,
          JSON.stringify(runtime.versionArgs),
          JSON.stringify(runtime.optionTemplates),
          JSON.stringify(runtime.optionValues),
          JSON.stringify(runtime.env),
          runtime.timeoutMs,
          runtime.createdAt,
          runtime.updatedAt,
        );
      return runtime;
    },
    updateAgentOptions(agentId, patch) {
      const runtime = getAgent(agentId);
      if (!runtime) throw new Error(`Agent not found: ${agentId}`);
      const timestamp = new Date().toISOString();
      if (patch.optionTemplates !== undefined) {
        connection
          .prepare('UPDATE agents SET option_templates_json = ?, updated_at = ? WHERE id = ?')
          .run(JSON.stringify(patch.optionTemplates), timestamp, agentId);
      }
      if (patch.optionValues !== undefined) {
        connection
          .prepare('UPDATE agents SET option_values_json = ?, updated_at = ? WHERE id = ?')
          .run(JSON.stringify(patch.optionValues), timestamp, agentId);
      }
      if (patch.env !== undefined) {
        connection
          .prepare('UPDATE agents SET env_json = ?, updated_at = ? WHERE id = ?')
          .run(JSON.stringify(patch.env), timestamp, agentId);
      }
      const updated = getAgent(agentId);
      if (!updated) throw new Error(`Agent not found: ${agentId}`);
      return updated;
    },
    listOrganizations() {
      return connection
        .prepare('SELECT * FROM organizations ORDER BY created_at, rowid')
        .all()
        .map((row) => mapOrganization(row as OrganizationRow));
    },
    getOrganization,
    createOrganization(input) {
      const timestamp = new Date().toISOString();
      const organization: Organization = {
        id: randomUUID(),
        name: input.name,
        description: input.description ?? '',
        color: input.color ?? '#7170ff',
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      connection
        .prepare(`
          INSERT INTO organizations (id, name, description, color, created_at, updated_at)
          VALUES (@id, @name, @description, @color, @createdAt, @updatedAt)
        `)
        .run(organization);
      return organization;
    },
    listSkills() {
      return connection
        .prepare('SELECT * FROM skills ORDER BY builtin DESC, created_at, rowid')
        .all()
        .map((row) => mapSkill(row as SkillRow));
    },
    getSkill,
    createSkill(input) {
      const timestamp = new Date().toISOString();
      const slug = input.name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/(^-|-$)/g, '');
      const skill: Skill = {
        id: randomUUID(),
        name: input.name,
        slug: slug || randomUUID().slice(0, 8),
        description: input.description,
        category: input.category ?? 'custom',
        sourceUrl: input.sourceUrl ?? '',
        installCommand: input.installCommand ?? '',
        instructions: input.instructions,
        builtin: false,
        enabled: true,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      connection
        .prepare(`
          INSERT INTO skills (
            id, name, slug, description, category, source_url, install_command,
            instructions, builtin, enabled, created_at, updated_at
          ) VALUES (
            @id, @name, @slug, @description, @category, @sourceUrl, @installCommand,
            @instructions, 0, 1, @createdAt, @updatedAt
          )
        `)
        .run(skill);
      return skill;
    },
    listOrgAgentSkills(orgAgentId) {
      return connection
        .prepare(`
          SELECT skills.*
          FROM org_agent_skills AS assignment
          JOIN skills ON skills.id = assignment.skill_id
          WHERE assignment.org_agent_id = ? AND skills.enabled = 1
          ORDER BY assignment.created_at, assignment.rowid
        `)
        .all(orgAgentId)
        .map((row) => mapSkill(row as SkillRow));
    },
    createOrgAgent(input) {
      const runtime = getAgent(input.runtimeId);
      if (!runtime) throw new Error(`Agent runtime not found: ${input.runtimeId}`);
      if (!runtime.enabled) throw new Error(`Agent runtime is disabled: ${input.runtimeId}`);
      const organizationId = input.organizationId ?? DEFAULT_ORGANIZATION_ID;
      if (!getOrganization(organizationId)) {
        throw new Error(`Organization not found: ${organizationId}`);
      }
      const skillIds = [...new Set(input.skillIds ?? [])];
      for (const skillId of skillIds) {
        if (!getSkill(skillId)) throw new Error(`Skill not found: ${skillId}`);
      }
      const id = randomUUID();
      const managerId = input.managerId ?? null;
      assertManagerAssignment(id, managerId);

      const tenure: Tenure = input.tenure ?? 'hired';
      const expiryKind = input.expiryKind ?? null;
      // What makes an agent temporary is a recorded end, not a label. Without one
      // it is a hire under another name.
      if (tenure === 'temporary' && expiryKind === null) {
        throw new Error('Temporary staff require an expiry condition');
      }
      if (tenure !== 'temporary' && expiryKind !== null) {
        throw new Error(`Only temporary staff carry an expiry condition: ${tenure}`);
      }
      if (managerId !== null) {
        const manager = getOrgAgent(managerId);
        if (!manager) throw new Error(`Organizational agent not found: ${managerId}`);
        assertTenureOrdering(tenure, manager.tenure);
      }

      const timestamp = new Date().toISOString();
      connection.transaction(() => {
        connection
          .prepare(`
            INSERT INTO org_agents (
              id, organization_id, name, job_title, department, job_function, responsibilities,
              instructions, runtime_id, manager_id, authority_level, can_delegate,
              model, speed, effort, enabled, tenure, expiry_kind, expiry_at,
              venture_id, department_id, dedication, dedication_reason, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `)
          .run(
            id,
            organizationId,
            input.name,
            input.jobTitle,
            input.department,
            input.jobFunction,
            input.responsibilities,
            input.instructions ?? '',
            input.runtimeId,
            managerId,
            input.authorityLevel ?? 50,
            input.canDelegate ? 1 : 0,
            input.model ?? null,
            input.speed ?? null,
            input.effort ?? null,
            tenure,
            expiryKind,
            input.expiryAt ?? null,
            input.ventureId ?? null,
            input.departmentId ?? null,
            input.dedication ?? 'shared',
            input.dedicationReason ?? null,
            timestamp,
            timestamp,
          );
        const assignSkill = connection.prepare(`
          INSERT INTO org_agent_skills (org_agent_id, skill_id, created_at) VALUES (?, ?, ?)
        `);
        for (const skillId of skillIds) assignSkill.run(id, skillId, timestamp);
      })();
      const created = getOrgAgent(id);
      if (!created) throw new Error(`Organizational agent not found: ${id}`);
      return created;
    },
    getOrgAgent,
    listOrgAgents() {
      return connection
        .prepare(`${ORG_AGENT_SELECT} ORDER BY org_agents.created_at, org_agents.rowid`)
        .all()
        .map((row) => mapOrgAgent(row as OrgAgentRow));
    },
    setOrgAgentManager(orgAgentId, managerId) {
      const agent = getOrgAgent(orgAgentId);
      if (!agent) throw new Error(`Organizational agent not found: ${orgAgentId}`);
      assertManagerAssignment(orgAgentId, managerId);
      connection
        .prepare('UPDATE org_agents SET manager_id = ?, updated_at = ? WHERE id = ?')
        .run(managerId, new Date().toISOString(), orgAgentId);
      const updated = getOrgAgent(orgAgentId);
      if (!updated) throw new Error(`Organizational agent not found: ${orgAgentId}`);
      return updated;
    },
    assignOrgAgentToProject(projectId, orgAgentId) {
      const project = connection.prepare('SELECT id FROM projects WHERE id = ?').get(projectId);
      if (!project) throw new Error(`Project not found: ${projectId}`);
      if (!getOrgAgent(orgAgentId)) {
        throw new Error(`Organizational agent not found: ${orgAgentId}`);
      }
      connection
        .prepare(`
          INSERT OR IGNORE INTO project_agent_assignments (project_id, org_agent_id, created_at)
          VALUES (?, ?, ?)
        `)
        .run(projectId, orgAgentId, new Date().toISOString());
    },
    listProjectOrgAgents(projectId) {
      return connection
        .prepare(`
          ${ORG_AGENT_SELECT}
          JOIN project_agent_assignments AS assignment
            ON assignment.org_agent_id = org_agents.id
          WHERE assignment.project_id = ?
          ORDER BY assignment.created_at, assignment.rowid
        `)
        .all(projectId)
        .map((row) => mapOrgAgent(row as OrgAgentRow));
    },
    createProject(input) {
      const organizationId = input.organizationId ?? DEFAULT_ORGANIZATION_ID;
      if (!getOrganization(organizationId)) {
        throw new Error(`Organization not found: ${organizationId}`);
      }
      const timestamp = new Date().toISOString();
      const project: Project = {
        id: randomUUID(),
        organizationId,
        name: input.name,
        path: input.path,
        description: input.description ?? '',
        color: input.color ?? '#7170ff',
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      connection
        .prepare(`
          INSERT INTO projects (
            id, organization_id, name, path, description, color, created_at, updated_at
          ) VALUES (
            @id, @organizationId, @name, @path, @description, @color, @createdAt, @updatedAt
          )
        `)
        .run(project);
      return project;
    },
    listProjects() {
      return connection
        .prepare('SELECT * FROM projects ORDER BY created_at, rowid')
        .all()
        .map((row) => mapProject(row as ProjectRow));
    },
    getProject(projectId) {
      const row = connection.prepare('SELECT * FROM projects WHERE id = ?').get(projectId) as
        | ProjectRow
        | undefined;
      return row ? mapProject(row) : null;
    },
    createTask(input) {
      const status = input.status ?? 'backlog';
      const { position } = connection
        .prepare(
          'SELECT COALESCE(MAX(position) + 1, 0) AS position FROM tasks WHERE project_id = ? AND status = ?',
        )
        .get(input.projectId, status) as { position: number };
      const timestamp = new Date().toISOString();
      const task: Task = {
        id: randomUUID(),
        projectId: input.projectId,
        title: input.title,
        description: input.description ?? '',
        status,
        priority: input.priority ?? 'medium',
        assignedAgentId: input.assignedAgentId ?? null,
        position,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      connection
        .prepare(`
          INSERT INTO tasks (
            id, project_id, title, description, status, priority,
            assigned_agent_id, position, created_at, updated_at
          ) VALUES (
            @id, @projectId, @title, @description, @status, @priority,
            @assignedAgentId, @position, @createdAt, @updatedAt
          )
        `)
        .run(task);
      return task;
    },
    getTask(taskId) {
      const row = connection.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as
        | TaskRow
        | undefined;
      return row ? mapTask(row) : null;
    },
    moveTask(taskId, destinationStatus, destinationPosition) {
      return connection.transaction(() => {
        const source = connection.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as
          | TaskRow
          | undefined;
        if (!source) throw new Error(`Task not found: ${taskId}`);
        connection
          .prepare(
            'UPDATE tasks SET position = position - 1 WHERE project_id = ? AND status = ? AND position > ?',
          )
          .run(source.project_id, source.status, source.position);
        connection
          .prepare(
            'UPDATE tasks SET position = position + 1 WHERE project_id = ? AND status = ? AND position >= ? AND id <> ?',
          )
          .run(source.project_id, destinationStatus, destinationPosition, taskId);
        connection
          .prepare('UPDATE tasks SET status = ?, position = ?, updated_at = ? WHERE id = ?')
          .run(destinationStatus, destinationPosition, new Date().toISOString(), taskId);
        return mapTask(connection.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as TaskRow);
      })();
    },
    getBoard(projectId) {
      const board: KanbanBoard = {
        backlog: [],
        ready: [],
        in_progress: [],
        review: [],
        done: [],
        blocked: [],
      };
      const rows = connection
        .prepare('SELECT * FROM tasks WHERE project_id = ? ORDER BY status, position, created_at')
        .all(projectId) as TaskRow[];
      for (const row of rows) board[row.status].push(mapTask(row));
      return board;
    },
    createRun(input) {
      const run: OrchestrationRun = {
        id: randomUUID(),
        taskId: input.taskId,
        mode: input.mode,
        status: 'queued',
        coordinatorAgentId: input.coordinatorAgentId,
        rootOrgAgentId: input.rootOrgAgentId ?? null,
        error: null,
        createdAt: new Date().toISOString(),
        startedAt: null,
        finishedAt: null,
      };
      connection
        .prepare(`
          INSERT INTO runs (
            id, task_id, mode, status, coordinator_agent_id, root_org_agent_id, error,
            created_at, started_at, finished_at
          ) VALUES (
            @id, @taskId, @mode, @status, @coordinatorAgentId, @rootOrgAgentId, @error,
            @createdAt, @startedAt, @finishedAt
          )
        `)
        .run(run);
      return run;
    },
    getRun,
    updateRunStatus(runId, status, error) {
      const timestamp = new Date().toISOString();
      const startedAt = status === 'running' ? timestamp : null;
      const finishedAt = ['completed', 'failed', 'cancelled'].includes(status) ? timestamp : null;
      connection
        .prepare(`
          UPDATE runs
          SET status = ?, error = COALESCE(?, error),
              started_at = COALESCE(?, started_at),
              finished_at = COALESCE(?, finished_at)
          WHERE id = ?
        `)
        .run(status, error ?? null, startedAt, finishedAt, runId);
      const updated = getRun(runId);
      if (!updated) throw new Error(`Run not found: ${runId}`);
      return updated;
    },
    addRunMessage(input) {
      const message: RunMessage = {
        id: randomUUID(),
        runId: input.runId,
        taskId: input.taskId,
        agentId: input.agentId ?? null,
        orgAgentId: input.orgAgentId ?? null,
        phase: input.phase,
        role: input.role,
        content: input.content,
        createdAt: new Date().toISOString(),
      };
      connection
        .prepare(`
          INSERT INTO messages (
            id, run_id, task_id, agent_id, org_agent_id, phase, role, content, created_at
          ) VALUES (
            @id, @runId, @taskId, @agentId, @orgAgentId, @phase, @role, @content, @createdAt
          )
        `)
        .run(message);
      return message;
    },
    listRunMessages(runId) {
      return connection
        .prepare('SELECT * FROM messages WHERE run_id = ? ORDER BY created_at, rowid')
        .all(runId)
        .map((row) => mapMessage(row as MessageRow));
    },
    listRecentRuns(limit = 10) {
      const rows = connection
        .prepare(`
          SELECT
            runs.id, runs.task_id, runs.mode, runs.status, runs.error,
            runs.created_at, runs.finished_at,
            tasks.title AS task_title,
            projects.id AS project_id, projects.name AS project_name,
            projects.organization_id AS organization_id
          FROM runs
          JOIN tasks ON tasks.id = runs.task_id
          JOIN projects ON projects.id = tasks.project_id
          ORDER BY runs.created_at DESC, runs.rowid DESC
          LIMIT ?
        `)
        .all(Math.max(1, Math.min(limit, 100))) as Array<Record<string, unknown>>;
      return rows.map((row) => ({
        id: row.id as string,
        taskId: row.task_id as string,
        taskTitle: row.task_title as string,
        projectId: row.project_id as string,
        projectName: row.project_name as string,
        organizationId: row.organization_id as string,
        mode: row.mode as RunMode,
        status: row.status as RunStatus,
        error: (row.error as string | null) ?? null,
        createdAt: row.created_at as string,
        finishedAt: (row.finished_at as string | null) ?? null,
      }));
    },
    getDashboardStats() {
      const count = (sql: string): number =>
        (connection.prepare(sql).get() as { n: number }).n;
      const tasksByStatus = Object.fromEntries(
        TASK_STATUSES.map((status) => [status, 0]),
      ) as Record<TaskStatus, number>;
      const rows = connection
        .prepare('SELECT status, COUNT(*) AS n FROM tasks GROUP BY status')
        .all() as Array<{ status: TaskStatus; n: number }>;
      for (const row of rows) tasksByStatus[row.status] = row.n;
      return {
        organizations: count('SELECT COUNT(*) AS n FROM organizations'),
        projects: count('SELECT COUNT(*) AS n FROM projects'),
        orgAgents: count('SELECT COUNT(*) AS n FROM org_agents'),
        skills: count('SELECT COUNT(*) AS n FROM skills WHERE enabled = 1'),
        activeRuns: count("SELECT COUNT(*) AS n FROM runs WHERE status IN ('queued', 'running')"),
        tasksByStatus,
      };
    },
    identity: createIdentityRepository(connection),
    org: createOrgRepository(connection),
    platform: createPlatformRepository(connection),
    work: createWorkRepository(connection),
    rooms: createRoomRepository(connection),
    runs: createRunRepository(connection),
    governance: createGovernanceRepository(connection),
    connection,
    close() {
      connection.close();
    },
  };
}
