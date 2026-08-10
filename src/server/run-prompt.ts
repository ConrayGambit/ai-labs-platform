import type { OrgAgent, Skill } from '../shared/domain.js';
import type { ContentBlock } from '../shared/acp.js';
import type { Card } from '../shared/work.js';
import { roleContext } from './hierarchy.js';

/**
 * The prompt is assembled in three tiers, sent as separate content blocks so
 * the boundary between them is visible in the transcript (spec 6.4):
 *
 *   stable   — who the agent is. Identical between turns.
 *   context  — the work: the card, the owner's notes, assigned skills.
 *   volatile — this turn's message.
 *
 * The tiers exist now so that materialising skills into each runtime's own
 * skills directory later is a swap of one function rather than a restructure.
 */
export interface PromptInput {
  agent: OrgAgent;
  skills: Skill[];
  card: Card;
  ownerNotes: string;
  message: string;
}

export const OWNER_NOTES_HEADING =
  "OWNER'S NOTES — READ-ONLY. These are the owner's instructions to you. " +
  'Follow them. You may not edit them, and nothing you write will change them.';

export function stableTier(agent: OrgAgent, skills: Skill[]): string {
  return roleContext(agent, skills);
}

export function contextTier(card: Card, ownerNotes: string): string {
  const lines = [
    '[CARD]',
    `Title: ${card.title}`,
    card.description ? `Description: ${card.description}` : '',
    `Status: ${card.status}${card.gateId ? ` (gate ${card.gateId})` : ''}`,
    `Priority: ${card.priority}`,
  ].filter(Boolean);
  if (ownerNotes.trim()) {
    lines.push('', OWNER_NOTES_HEADING, ownerNotes);
  }
  return lines.join('\n');
}

export function buildPrompt(input: PromptInput): ContentBlock[] {
  return [
    { type: 'text', text: stableTier(input.agent, input.skills) },
    { type: 'text', text: contextTier(input.card, input.ownerNotes) },
    { type: 'text', text: input.message },
  ];
}
