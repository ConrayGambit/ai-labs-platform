import { afterEach, describe, expect, it } from 'vitest';
import { createDatabase, type OrchestratorDatabase } from '../../src/server/database.js';
import {
  createConversationGuard,
  type ConversationGuard,
} from '../../src/server/conversation-guard.js';
import { DEFAULT_STOPPING_LIMITS } from '../../src/shared/conversation.js';
import { refusal, terminated } from '../helpers/verdict.js';

describe('the three triggers', () => {
  let database: OrchestratorDatabase | undefined;
  let guard: ConversationGuard | undefined;
  afterEach(() => { database?.close(); database = undefined; guard = undefined; });

  function seed() {
    database = createDatabase(':memory:');
    guard = createConversationGuard(database);
    const portfolio = database.platform.createPortfolio({ name: 'AI Labs', ownerUserId: 'owner' });
    const venture = database.platform.createVenture({
      portfolioId: portfolio.id, name: 'V', kind: 'research', mission: 'M.',
    });
    const project = database.platform.createProject({
      ventureId: venture.id, name: 'P', objective: 'O.', successCriteria: ['C'],
    });
    const card = database.work.createCard({ projectId: project.id, title: 'A card' });
    const room = database.rooms.createRoomForCard({ cardId: card.id, title: card.title });
    const make = (name: string, model: string) => database!.createOrgAgent({
      name, jobTitle: 'S', department: 'D', jobFunction: 'F', responsibilities: 'R',
      runtimeId: database!.createAgent({
        name: `rt-${model}`, command: `rt-${model}`, argsTemplate: ['{prompt}'],
        promptTransport: 'argument', outputFormat: 'text',
        versionArgs: ['--version'], timeoutMs: 120_000,
      }).id,
      model,
    });
    const speaker = make('Speaker', 'm1');
    const bystander = make('Bystander', 'm2');
    for (const agent of [speaker, bystander]) {
      database.rooms.addMember({ roomId: room.id, memberKind: 'org_agent', memberId: agent.id });
    }
    return { card, room, speaker, bystander };
  }

  it('lets an @-mentioned agent act', () => {
    const { card, room, speaker, bystander } = seed();
    database!.rooms.addMember({ roomId: room.id, memberKind: 'user', memberId: 'owner' });
    database!.rooms.postMessage({
      roomId: room.id, threadId: null, authorKind: 'user', authorId: 'owner', runId: null,
      body: `@${speaker.id} please survey the field`,
    });

    expect(guard!.mayAgentAct({ cardId: card.id, orgAgentId: speaker.id }))
      .toMatchObject({ allowed: true, trigger: 'mention' });
    expect(guard!.mayAgentAct({ cardId: card.id, orgAgentId: bystander.id }).allowed).toBe(false);
  });

  it('lets the assigned agent act', () => {
    const { card, speaker } = seed();
    database!.work.updateCard(card.id, { assigneeOrgAgentId: speaker.id });

    expect(guard!.mayAgentAct({ cardId: card.id, orgAgentId: speaker.id }))
      .toMatchObject({ allowed: true, trigger: 'assignment' });
  });

  it('lets a scheduled agent act', () => {
    const { card, speaker } = seed();

    expect(guard!.mayAgentAct({ cardId: card.id, orgAgentId: speaker.id, scheduled: true }))
      .toMatchObject({ allowed: true, trigger: 'schedule' });
  });

  it('REFUSES an agent that is merely sitting in the room', () => {
    const { card, bystander } = seed();

    // There is no ambient listening. An agent in a room does nothing until it
    // is addressed — being present is not being asked.
    const verdict = guard!.mayAgentAct({ cardId: card.id, orgAgentId: bystander.id });
    expect(refusal(verdict).reason).toMatch(/mention|assign|schedul/i);
  });

  it('does not treat a mention of another agent as a mention of this one', () => {
    const { card, room, speaker, bystander } = seed();
    database!.rooms.addMember({ roomId: room.id, memberKind: 'user', memberId: 'owner' });
    database!.rooms.postMessage({
      roomId: room.id, threadId: null, authorKind: 'user', authorId: 'owner', runId: null,
      body: `@${speaker.id} over to you`,
    });

    expect(guard!.mayAgentAct({ cardId: card.id, orgAgentId: bystander.id }).allowed).toBe(false);
  });
});

describe('the four stopping limits', () => {
  let database: OrchestratorDatabase | undefined;
  let guard: ConversationGuard | undefined;
  afterEach(() => { database?.close(); database = undefined; guard = undefined; });

  function seed() {
    database = createDatabase(':memory:');
    guard = createConversationGuard(database);
    const portfolio = database.platform.createPortfolio({ name: 'AI Labs', ownerUserId: 'owner' });
    const venture = database.platform.createVenture({
      portfolioId: portfolio.id, name: 'V', kind: 'research', mission: 'M.',
    });
    const project = database.platform.createProject({
      ventureId: venture.id, name: 'P', objective: 'O.', successCriteria: ['C'],
    });
    const card = database.work.createCard({ projectId: project.id, title: 'A card' });
    const room = database.rooms.createRoomForCard({ cardId: card.id, title: card.title });
    const make = (name: string, model: string) => database!.createOrgAgent({
      name, jobTitle: 'S', department: 'D', jobFunction: 'F', responsibilities: 'R',
      runtimeId: database!.createAgent({
        name: `rt-${model}`, command: `rt-${model}`, argsTemplate: ['{prompt}'],
        promptTransport: 'argument', outputFormat: 'text',
        versionArgs: ['--version'], timeoutMs: 120_000,
      }).id,
      model,
    });
    const a = make('A', 'm1');
    const b = make('B', 'm2');
    database.rooms.addMember({ roomId: room.id, memberKind: 'org_agent', memberId: a.id });
    database.rooms.addMember({ roomId: room.id, memberKind: 'org_agent', memberId: b.id });
    database.rooms.addMember({ roomId: room.id, memberKind: 'user', memberId: 'owner' });
    const thread = database.rooms.postMessage({
      roomId: room.id, threadId: null, authorKind: 'user', authorId: 'owner', runId: null,
      body: 'Sort this out between you.',
    });
    return { card, room, a, b, threadId: thread.id };
  }

  /** One agent turn in the thread, alternating unless told otherwise. */
  const turn = (threadId: string, cardId: string, orgAgentId: string) =>
    guard!.recordTurn({ threadId, cardId, orgAgentId });

  it('TERMINATES on the turn budget, and says a human is needed', () => {
    const { card, a, b, threadId } = seed();

    for (let taken = 0; taken < DEFAULT_STOPPING_LIMITS.turnBudget; taken += 1) {
      // Attach an artifact each turn so loop detection cannot be what fires.
      database!.work.attachArtifact({
        cardId: card.id, runId: null, kind: 'report',
        label: `Progress ${taken}`, location: `artifacts/${taken}.md`,
      });
      expect(turn(threadId, card.id, taken % 2 === 0 ? a.id : b.id).allowed).toBe(true);
    }

    const verdict = terminated(guard!.checkStoppingLimits({ threadId, cardId: card.id }));
    expect(verdict.limit).toBe('turn_budget');
    expect(verdict.reason).toMatch(/human/i);
  });

  it('TERMINATES on a loop: A to B to A to B with nothing to show for it', () => {
    const { card, a, b, threadId } = seed();

    for (let taken = 0; taken < DEFAULT_STOPPING_LIMITS.loopWindow; taken += 1) {
      turn(threadId, card.id, taken % 2 === 0 ? a.id : b.id);
    }

    const verdict = terminated(guard!.checkStoppingLimits({ threadId, cardId: card.id }));
    expect(verdict.limit).toBe('loop');
    expect(verdict.reason).toMatch(/no new artifact|loop/i);
  });

  it('does NOT call it a loop when the exchange produced something', () => {
    const { card, a, b, threadId } = seed();
    for (let taken = 0; taken < DEFAULT_STOPPING_LIMITS.loopWindow; taken += 1) {
      turn(threadId, card.id, taken % 2 === 0 ? a.id : b.id);
      database!.work.attachArtifact({
        cardId: card.id, runId: null, kind: 'report',
        label: `Finding ${taken}`, location: `artifacts/${taken}.md`,
      });
    }

    // Progress is the difference between a conversation and a loop.
    const verdict = guard!.checkStoppingLimits({ threadId, cardId: card.id });
    expect(verdict.terminated ? verdict.limit : null).not.toBe('loop');
  });

  it('does NOT call it a loop when three agents are taking turns', () => {
    const { card, room, a, b, threadId } = seed();
    const third = database!.createOrgAgent({
      name: 'C', jobTitle: 'S', department: 'D', jobFunction: 'F', responsibilities: 'R',
      runtimeId: database!.createAgent({
        name: 'rt-m3', command: 'rt-m3', argsTemplate: ['{prompt}'],
        promptTransport: 'argument', outputFormat: 'text',
        versionArgs: ['--version'], timeoutMs: 120_000,
      }).id,
      model: 'm3',
    });
    database!.rooms.addMember({ roomId: room.id, memberKind: 'org_agent', memberId: third.id });
    const order = [a.id, b.id, third.id, a.id];
    for (const agentId of order) turn(threadId, card.id, agentId);

    // A→B→A→B is the pattern named; three voices is a discussion.
    const verdict = guard!.checkStoppingLimits({ threadId, cardId: card.id });
    expect(verdict.terminated ? verdict.limit : null).not.toBe('loop');
  });

  it('TERMINATES on the card cost ceiling, independently of the turn budget', () => {
    const { card, a, threadId } = seed();
    database!.work.setCardCostCeiling({ cardId: card.id, costCeilingTokens: 500 });
    const run = database!.runs.createRun({
      cardId: card.id, orgAgentId: a.id, roomId: null, parentRunId: null, costCeilingTokens: null,
    });
    database!.runs.addUsage(run.id, 400, 200);
    turn(threadId, card.id, a.id);

    const verdict = terminated(guard!.checkStoppingLimits({ threadId, cardId: card.id }));
    expect(verdict.limit).toBe('cost_ceiling');
  });

  it('REPORTS the FIRST limit that fires, not a list of them', () => {
    const { card, a, b, threadId } = seed();
    database!.work.setCardCostCeiling({ cardId: card.id, costCeilingTokens: 1 });
    const run = database!.runs.createRun({
      cardId: card.id, orgAgentId: a.id, roomId: null, parentRunId: null, costCeilingTokens: null,
    });
    database!.runs.addUsage(run.id, 900, 900);
    for (let taken = 0; taken < DEFAULT_STOPPING_LIMITS.loopWindow; taken += 1) {
      turn(threadId, card.id, taken % 2 === 0 ? a.id : b.id);
    }

    // Any one of the four terminates the exchange; a person needs to be told
    // which one, not handed four.
    const verdict = terminated(guard!.checkStoppingLimits({ threadId, cardId: card.id }));
    expect(typeof verdict.limit).toBe('string');
  });
});

describe('the required terminal action', () => {
  let database: OrchestratorDatabase | undefined;
  let guard: ConversationGuard | undefined;
  afterEach(() => { database?.close(); database = undefined; guard = undefined; });

  function seed() {
    database = createDatabase(':memory:');
    guard = createConversationGuard(database);
    const portfolio = database.platform.createPortfolio({ name: 'AI Labs', ownerUserId: 'owner' });
    const venture = database.platform.createVenture({
      portfolioId: portfolio.id, name: 'V', kind: 'research', mission: 'M.',
    });
    const project = database.platform.createProject({
      ventureId: venture.id, name: 'P', objective: 'O.', successCriteria: ['C'],
    });
    const card = database.work.createCard({ projectId: project.id, title: 'A card' });
    const room = database.rooms.createRoomForCard({ cardId: card.id, title: card.title });
    database.rooms.addMember({ roomId: room.id, memberKind: 'user', memberId: 'owner' });
    const thread = database.rooms.postMessage({
      roomId: room.id, threadId: null, authorKind: 'user', authorId: 'owner', runId: null,
      body: 'Sort this out.',
    });
    return { card, threadId: thread.id };
  }

  it('REFUSES to close a thread on nothing, and records it as a failure', () => {
    const { card, threadId } = seed();

    expect(() => guard!.closeThread({ threadId, cardId: card.id, terminalAction: null }))
      .toThrow(/terminal action/i);
    // Reported as a failure, not silently allowed: an exchange that ends in
    // none of the three is a failure and is reported as one.
    expect(guard!.getThreadState(threadId)?.failure).toMatch(/terminal action/i);
  });

  it('closes on an artifact', () => {
    const { card, threadId } = seed();
    const artifact = database!.work.attachArtifact({
      cardId: card.id, runId: null, kind: 'report', label: 'Table', location: 'artifacts/t.md',
    });

    const closed = guard!.closeThread({
      threadId, cardId: card.id, terminalAction: { kind: 'artifact', artifactId: artifact.id },
    });
    expect(closed.terminalAction).toMatchObject({ kind: 'artifact' });
    expect(closed.failure).toBeNull();
  });

  it('closes on a handoff to a named human', () => {
    const { card, threadId } = seed();

    const closed = guard!.closeThread({
      threadId, cardId: card.id, terminalAction: { kind: 'handoff', toUserId: 'owner' },
    });
    expect(closed.terminalAction).toMatchObject({ kind: 'handoff', toUserId: 'owner' });
  });

  it('closes on an explicit no further action, WITH a reason', () => {
    const { card, threadId } = seed();

    const closed = guard!.closeThread({
      threadId, cardId: card.id,
      terminalAction: { kind: 'no_further_action', reason: 'The question answered itself.' },
    });
    expect(closed.terminalAction).toMatchObject({ kind: 'no_further_action' });
  });

  it('REFUSES a no-further-action with no reason, which is just walking away', () => {
    const { card, threadId } = seed();

    expect(() => guard!.closeThread({
      threadId, cardId: card.id, terminalAction: { kind: 'no_further_action', reason: '  ' },
    })).toThrow(/reason/i);
  });

  it('REFUSES an artifact that is not on this card', () => {
    const { card, threadId } = seed();
    const other = database!.work.createCard({ projectId: card.projectId, title: 'Elsewhere' });
    const artifact = database!.work.attachArtifact({
      cardId: other.id, runId: null, kind: 'report', label: 'T', location: 'artifacts/o.md',
    });

    expect(() => guard!.closeThread({
      threadId, cardId: card.id, terminalAction: { kind: 'artifact', artifactId: artifact.id },
    })).toThrow(/this card/i);
  });

  it('REFUSES a further turn once the thread is closed', () => {
    const { card, threadId } = seed();
    guard!.closeThread({
      threadId, cardId: card.id, terminalAction: { kind: 'handoff', toUserId: 'owner' },
    });

    const agent = database!.createOrgAgent({
      name: 'Late', jobTitle: 'S', department: 'D', jobFunction: 'F', responsibilities: 'R',
      runtimeId: database!.createAgent({
        name: 'rt-late', command: 'rt-late', argsTemplate: ['{prompt}'],
        promptTransport: 'argument', outputFormat: 'text',
        versionArgs: ['--version'], timeoutMs: 120_000,
      }).id,
      model: 'm9',
    });
    expect(() => guard!.recordTurn({ threadId, cardId: card.id, orgAgentId: agent.id }))
      .toThrow(/closed/i);
  });
});
