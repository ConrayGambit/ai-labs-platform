/**
 * Agent Client Protocol wire types.
 *
 * Method and field names below are taken from the protocol specification, not
 * inferred. Where a field is optional here it is optional there.
 */
export const ACP_PROTOCOL_VERSION = 1;

export type StopReason =
  | 'end_turn' | 'max_tokens' | 'max_turn_requests' | 'refusal' | 'cancelled';

export interface TextContentBlock { type: 'text'; text: string }
export type ContentBlock = TextContentBlock;

export interface InitializeRequest {
  protocolVersion: number;
  clientCapabilities: {
    fs?: { readTextFile?: boolean; writeTextFile?: boolean };
    terminal?: boolean;
  };
  clientInfo: { name: string; version: string };
}

export interface InitializeResponse {
  protocolVersion: number;
  agentCapabilities?: Record<string, unknown>;
  agentInfo?: { name: string; version: string };
  authMethods?: unknown[];
}

export interface SessionNewRequest {
  cwd: string;
  mcpServers: unknown[];
  additionalDirectories?: string[];
}

export interface SessionNewResponse {
  sessionId: string;
  modes?: unknown;
  configOptions?: unknown;
}

export interface SessionPromptRequest { sessionId: string; prompt: ContentBlock[] }
export interface SessionPromptResponse { stopReason: StopReason }
export interface SessionCancelNotification { sessionId: string }

export type SessionUpdate =
  | { sessionUpdate: 'agent_message_chunk'; content: ContentBlock; messageId?: string }
  | { sessionUpdate: 'agent_thought_chunk'; content: ContentBlock }
  | { sessionUpdate: 'tool_call'; toolCall: Record<string, unknown> }
  | { sessionUpdate: 'tool_call_update'; toolCall: Record<string, unknown> }
  | { sessionUpdate: 'plan'; entries?: unknown[] }
  | { sessionUpdate: 'usage_update'; usage?: Record<string, number> };

export interface SessionUpdateNotification { sessionId: string; update: SessionUpdate }

export interface PermissionOption { optionId: string; name: string; kind: string }

export interface PermissionRequest {
  sessionId: string;
  toolCall: { toolCallId: string; title?: string };
  options: PermissionOption[];
}

export interface PermissionResponse {
  outcome: { outcome: 'selected'; optionId: string } | { outcome: 'cancelled' };
}

/** Tokens reported by `usage_update`, under the names the protocol uses. */
export function readUsage(update: SessionUpdate): { input: number; output: number } | null {
  if (update.sessionUpdate !== 'usage_update' || !update.usage) return null;
  const usage = update.usage;
  return {
    input: usage.inputTokens ?? usage.input_tokens ?? 0,
    output: usage.outputTokens ?? usage.output_tokens ?? 0,
  };
}
