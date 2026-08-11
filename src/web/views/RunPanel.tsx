import { useId, useState } from 'react';
import { readUsage, type SessionUpdate } from '../../shared/acp.js';
import type { RunSummary } from '../api/client.js';
import { useRunStream, type RunUpdate } from '../realtime/useRunStream.js';

export interface RunPanelProps {
  cardId: string;
  /** The run this panel watches, or null when the card has none yet — in which case this panel offers to start one. */
  runId: string | null;
  /**
   * The known record for `runId` — `GET /api/cards/:cardId`'s own `runs`
   * entry, already held by the caller (`CardDetailView`). Seeds the
   * accumulated cost and status before anything has streamed, and is the
   * ONLY source for either once the run already finished in a past session:
   * `RunSupervisor.subscribe` (src/server/run-supervisor.ts) replays the
   * stored `agent_run_updates` on reconnect, but the `finished` event itself
   * fires once, live, to whoever is subscribed at that exact moment — a
   * client that reconnects afterward never receives it. Optional; omitting
   * it only means cost and status read as unknown until something streams.
   */
  run?: RunSummary | null;
  /**
   * `Card.assigneeOrgAgentId` — who a run started from here runs as. The
   * start control states plainly why it is unavailable when this is null,
   * rather than a button that would fail the request silently.
   */
  assigneeOrgAgentId: string | null;
}

/**
 * Comma-grouped, regardless of the host's own locale. `toLocaleString()` with
 * no locale argument reads the runtime's default locale, which is not always
 * `en-US` — this repository's own dev/CI environment resolves to one that
 * groups with a space instead of a comma, so an unpinned call here would
 * render a different, environment-dependent separator on every machine that
 * runs it. A run's token count is a machine fact either way (`--font-mono`,
 * per DESIGN.md's Mono Means Machine rule); it should read the same on every
 * machine that displays it, the same way the type face does not change with
 * the host locale either.
 */
function formatTokenCount(count: number): string {
  return count.toLocaleString('en-US');
}

/** Best-effort label for an ACP tool call. `toolCall` is a passthrough `Record<string, unknown>` (src/shared/acp.ts) — provider-defined beyond `toolCallId`, so nothing here assumes a field exists. */
function toolCallLabel(toolCall: Record<string, unknown>): string {
  const title = toolCall.title;
  if (typeof title === 'string' && title.trim()) return title;
  const name = toolCall.name;
  if (typeof name === 'string' && name.trim()) return name;
  const id = toolCall.toolCallId;
  return typeof id === 'string' && id ? `Tool ${id}` : 'A tool call';
}

/** One line of transcript text for one ACP session update. */
function describeUpdate(update: SessionUpdate): { label: string; text: string } {
  switch (update.sessionUpdate) {
    case 'agent_message_chunk':
      return { label: 'Message', text: update.content.text };
    case 'agent_thought_chunk':
      return { label: 'Thinking', text: update.content.text };
    case 'tool_call':
      return { label: 'Tool call', text: toolCallLabel(update.toolCall) };
    case 'tool_call_update':
      return { label: 'Tool update', text: toolCallLabel(update.toolCall) };
    case 'plan': {
      const count = update.entries?.length ?? 0;
      return { label: 'Plan', text: count === 1 ? '1 step' : `${count} steps` };
    }
    case 'usage_update': {
      const usage = readUsage(update);
      return { label: 'Usage', text: usage ? `${usage.input} in / ${usage.output} out` : 'reported' };
    }
    default: {
      // SessionUpdate is a closed union (src/shared/acp.ts names every ACP
      // member it supports): a new protocol member fails typecheck here
      // rather than silently rendering a blank transcript row.
      const exhaustive: never = update;
      return { label: 'Update', text: JSON.stringify(exhaustive) };
    }
  }
}

/**
 * One row of the transcript.
 *
 * Keyed by array index at the call site: `updates` is append-only and never
 * sorted, deduped or reordered (see `useRunStream`'s own doc comment), so
 * index is stable for exactly as long as this list is ever displayed — the
 * one case where index-as-key is not a foot-gun.
 */
function TranscriptRow({ item }: { item: RunUpdate }) {
  if (item.type === 'update') {
    const { label, text } = describeUpdate(item.update);
    return (
      <li className="transcript-row">
        <span className="card-pill">{label}</span>
        <span className="transcript-text">{text}</span>
      </li>
    );
  }
  if (item.type === 'permission_request') {
    return (
      <li className="transcript-row">
        <span className="card-pill">Permission</span>
        <span className="transcript-text">Requested: {item.request.title || 'a permission'}</span>
      </li>
    );
  }
  if (item.type === 'permission_answered') {
    const verdict = item.request.status === 'answered' ? item.request.selectedOptionId : 'cancelled';
    return (
      <li className="transcript-row">
        <span className="card-pill">Permission</span>
        <span className="transcript-text">Answered: {verdict ?? 'cancelled'}</span>
      </li>
    );
  }
  // The only remaining member of RunUpdate: 'finished'.
  return (
    <li className="transcript-row">
      <span className="card-pill">Finished</span>
      <span className="transcript-text">
        {item.run.status}{item.run.stopReason ? ` — ${item.run.stopReason}` : ''}
      </span>
    </li>
  );
}

/**
 * The freshest known `RunSummary` for this run: the last `finished` event in
 * `updates` (there is at most one, but this does not assume that), else
 * `null`. Deliberately not derived from `usage_update` chunks — the server
 * treats each chunk's numbers as a delta to ADD to the run row
 * (`RunSupervisor.handleUpdate` -> `runs.addUsage`, src/server/run-supervisor.ts),
 * and re-deriving that accumulation here would risk silently drifting from
 * the server's own arithmetic. Showing the run record itself, refreshed only
 * when the server hands over a fresher copy of it, cannot drift.
 */
function findFinishedRun(updates: RunUpdate[]): RunSummary | null {
  for (let index = updates.length - 1; index >= 0; index -= 1) {
    const item = updates[index];
    if (item.type === 'finished') return item.run;
  }
  return null;
}

async function postRun(
  cardId: string,
  input: { orgAgentId: string; message: string; costCeilingTokens: number | null },
): Promise<RunSummary> {
  // Mirrors `request()` in src/web/api/client.ts field for field (verbatim
  // server refusal text, a distinct message when the request never arrived)
  // without adding to that file's route table — this task's brief calls
  // starting a run out as the one route deliberately left unwrapped there.
  let response: Response;
  try {
    response = await fetch(`/api/cards/${cardId}/runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
  } catch (cause) {
    throw new Error('Could not reach the server', { cause });
  }
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `Request failed (${response.status})`);
  }
  return (await response.json()) as RunSummary;
}

export function RunPanel({ cardId, runId, run = null, assigneeOrgAgentId }: RunPanelProps) {
  const [startedRunId, setStartedRunId] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const [ceilingDraft, setCeilingDraft] = useState('');
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const messageFieldId = useId();
  const ceilingFieldId = useId();

  // A run started from this panel becomes what it watches, the same as if
  // the card had opened with it. `runId` is a prop and cannot be reassigned;
  // this is the one piece of run-identity state this panel owns itself.
  const watchedRunId = startedRunId ?? runId;
  // The seed record describes `runId`, the run the card opened with — not a
  // run just started here, which has no such record yet (its own summary
  // arrives once something streams).
  const seedRun = startedRunId ? null : run;

  const { updates, pending, unsupported, connection, answer, cancel } = useRunStream(watchedRunId);

  const latestRun = findFinishedRun(updates) ?? seedRun;
  const cancelUnsupported = unsupported.find((entry) => entry.capability === 'run.cancel');
  const permissionUnsupported = unsupported.find((entry) => entry.capability === 'run.permission');
  const runIsOver = updates.some((item) => item.type === 'finished')
    || (latestRun ? latestRun.status !== 'running' : false);
  const cancelDisabled = Boolean(cancelUnsupported) || runIsOver || !watchedRunId;
  const cancelReason = cancelUnsupported?.reason
    ?? (runIsOver ? 'This run has already finished.' : null);

  const canStart = Boolean(assigneeOrgAgentId) && message.trim().length > 0 && !starting;

  async function submitStart(): Promise<void> {
    if (!assigneeOrgAgentId) return;
    const trimmedMessage = message.trim();
    if (!trimmedMessage) return;
    setStarting(true);
    setStartError(null);
    try {
      const ceiling = ceilingDraft.trim() ? Number(ceilingDraft.trim()) : null;
      const started = await postRun(cardId, {
        orgAgentId: assigneeOrgAgentId,
        message: trimmedMessage,
        costCeilingTokens: ceiling !== null && Number.isFinite(ceiling) ? ceiling : null,
      });
      setStartedRunId(started.id);
      setMessage('');
      setCeilingDraft('');
    } catch (reason) {
      setStartError(reason instanceof Error ? reason.message : 'Unable to start the run');
    } finally {
      setStarting(false);
    }
  }

  return (
    <div className="run-panel">
      {watchedRunId && (
        <p className="run-connection">
          {connection === 'connecting' && 'Connecting to the live run…'}
          {connection === 'open' && 'Connected — watching live.'}
          {connection === 'error' && 'Connection error. The transcript below may be incomplete.'}
          {connection === 'closed' && 'Disconnected from the live run.'}
        </p>
      )}

      {latestRun && (
        <div className="run-panel-status">
          {latestRun.status === 'running' && (
            <span aria-hidden="true" className="run-live-dot run-live-dot-running" />
          )}
          <span className={`run-status run-${latestRun.status}`}>{latestRun.status}</span>
          <span className="run-cost-figure">
            {formatTokenCount(latestRun.inputTokens)} in / {formatTokenCount(latestRun.outputTokens)} out
            {latestRun.costCeilingTokens != null
              && ` · ceiling ${formatTokenCount(latestRun.costCeilingTokens)}`}
          </span>
        </div>
      )}

      {pending && (
        <div className="run-permission" role="alert">
          <div className="run-permission-heading">
            <span aria-hidden="true" className="run-live-dot run-live-dot-permission" />
            <span className="field-label">Needs your decision</span>
          </div>
          <p className="detail-prose">{pending.title || 'The agent is asking for permission to continue.'}</p>
          <div className="run-permission-options">
            {pending.options.map((option) => (
              <button
                className="ghost-button"
                disabled={Boolean(permissionUnsupported)}
                key={option.optionId}
                onClick={() => answer(option.optionId)}
                type="button"
              >
                {option.name}
              </button>
            ))}
          </div>
          {permissionUnsupported && <p className="form-note">{permissionUnsupported.reason}</p>}
        </div>
      )}

      {watchedRunId && (
        <ul aria-label="Run transcript" className="transcript-list">
          {updates.map((item, index) => <TranscriptRow item={item} key={index} />)}
          {updates.length === 0 && <li className="detail-empty">No activity recorded yet.</li>}
        </ul>
      )}

      {watchedRunId && (
        <div>
          <button className="ghost-button" disabled={cancelDisabled} onClick={cancel} type="button">
            Cancel run
          </button>
          {cancelReason && <p className="form-note">{cancelReason}</p>}
        </div>
      )}

      <div className="detail-field run-start">
        <p className="field-label">Start a run</p>
        <label className="field-label" htmlFor={messageFieldId}>Message to the agent</label>
        <textarea
          disabled={starting}
          id={messageFieldId}
          onChange={(event) => setMessage(event.target.value)}
          rows={3}
          value={message}
        />
        <label className="field-label" htmlFor={ceilingFieldId}>Token cost ceiling (optional)</label>
        <input
          disabled={starting}
          id={ceilingFieldId}
          min="1"
          onChange={(event) => setCeilingDraft(event.target.value)}
          type="number"
          value={ceilingDraft}
        />
        {startError && <p className="form-error" role="alert">{startError}</p>}
        <button className="task-action" disabled={!canStart} onClick={() => { void submitStart(); }} type="button">
          {starting ? 'Starting…' : 'Start run'}
        </button>
        {!assigneeOrgAgentId && (
          <p className="form-note">Assign an agent to this card before starting a run.</p>
        )}
      </div>
    </div>
  );
}
