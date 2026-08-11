/**
 * Everything this platform knows about the providers it ships with.
 *
 * This lives outside database.ts because two callers need it and they must
 * never disagree: the seed writes these rows, and GET /api/agent-catalog
 * serves them to the client that registers new runtimes. A second, hand-kept
 * copy in the client is how a registry drifts, and this one has already been
 * corrected twice for drift (c57b379, 492db83).
 */
import type {
  AgentKind,
  AgentOutputFormat,
  RuntimeOptionTemplates,
  RuntimeOptionChoices,
  RuntimeEnv,
} from '../shared/domain.js';

export const BUILTIN_AGENTS = [
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
    // Handshake executed 2026-08-11 against adapter 0.66.0: initialize ->
    // protocolVersion 1 (matching ACP_PROTOCOL_VERSION), session/new -> a real
    // session id, cold start ~20s. No session/prompt was sent, so this does
    // NOT prove a completed turn — tests/server/acp-live.test.ts (Task 5,
    // gated behind AI_LABS_ACP_LIVE=1) is where that proof will live.
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
    // Prime Intellect open-sourced Prime Agent on 6 August 2026 (MIT). It is
    // daemon-backed (reattach with `prime-agent attach <agent>` / `--resume
    // <path|id>`); the print-mode command/args above are from an earlier
    // task. acpCommand/acpArgs below are new, 2026-08-11, from v0.6.0's
    // release notes, quoted verbatim: "Added `--mode acp`: Prime Agent now
    // runs as an Agent Client Protocol agent over NDJSON on stdio, driving
    // an `AgentConnection` in-process." packages/coding-agent/docs/usage.md
    // — the CLI reference's own Modes table — has zero mentions of ACP
    // anywhere on the page, checked in full and not just the table; the next
    // person to check only that file will conclude this entry is wrong. It
    // isn't: docs/acp.md (one line from the docs index; named by the release
    // notes as where this lives) gives the invocation in full —
    // `prime-agent --mode acp` — documented, just not on the page normally
    // checked first. Plain command, not `npm:`: the installer README says it
    // "downloads a versioned release, verifies its SHA-256 checksum,
    // installs the `prime-agent` command" — a real PATH executable, not an
    // npm shim — so resolveAcpLaunch's non-prefixed branch applies, same as
    // gemini above. Unresolved, and not relied on: that repository's
    // packages/coding-agent/package.json names the package
    // `@earendil-works/pi-coding-agent` with bin `pi` (dist/bundle/cli.js),
    // neither of which is `prime-agent`; could not square this with the
    // installer, so the installer — what actually lands a binary on an
    // operator's PATH — is treated as authoritative for the command name
    // here.
    id: 'prime',
    name: 'Prime Agent',
    kind: 'custom',
    command: 'prime-agent',
    args: ['-p', '{prompt}'],
    acpCommand: 'prime-agent',
    acpArgs: ['--mode', 'acp'],
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
export const BUILTIN_OPTION_TEMPLATES: Record<string, RuntimeOptionTemplates> = {
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
export const BUILTIN_OPTION_VALUES: Record<string, RuntimeOptionChoices> = {
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

/** A provider template, shaped the way CreateAgentInput expects it. */
export interface AgentCatalogEntry {
  id: string;
  name: string;
  kind: AgentKind;
  command: string;
  argsTemplate: string[];
  acpCommand: string | null;
  acpArgs: string[];
  outputFormat: AgentOutputFormat;
  resultField: string | null;
  versionArgs: string[];
  optionTemplates: RuntimeOptionTemplates;
  optionValues: RuntimeOptionChoices;
  env: RuntimeEnv;
}

/**
 * The builtin rows merged with their option flags and renamed to the field
 * names the API uses (`args` -> `argsTemplate`), so a catalog entry can be
 * posted to /api/agents almost unchanged. `versionArgs` is stated here because
 * the seed statement hardcodes it rather than reading it from the row.
 */
export const AGENT_CATALOG: AgentCatalogEntry[] = BUILTIN_AGENTS.map((agent) => ({
  id: agent.id,
  name: agent.name,
  kind: agent.kind as AgentKind,
  command: agent.command,
  argsTemplate: [...agent.args],
  acpCommand: agent.acpCommand,
  acpArgs: [...agent.acpArgs],
  outputFormat: agent.outputFormat as AgentOutputFormat,
  resultField: agent.resultField,
  versionArgs: ['--version'],
  optionTemplates: (BUILTIN_OPTION_TEMPLATES as Record<string, RuntimeOptionTemplates>)[agent.id] ?? {},
  optionValues: (BUILTIN_OPTION_VALUES as Record<string, RuntimeOptionChoices>)[agent.id] ?? {},
  env: { ...agent.env },
}));
