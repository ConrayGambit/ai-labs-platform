import { afterEach, describe, expect, it } from 'vitest';
import { createDatabase, type OrchestratorDatabase } from '../../src/server/database.js';
import type { Card } from '../../src/shared/work.js';

describe('rooms, threads and the canvas', () => {
  let database: OrchestratorDatabase | undefined;

  afterEach(() => database?.close());

  function seedCard(): Card {
    database = database ?? createDatabase(':memory:');
    const portfolio = database.platform.createPortfolio({ name: 'AI Labs', ownerUserId: 'owner' });
    const venture = database.platform.createVenture({
      portfolioId: portfolio.id,
      name: 'Research Lab',
      kind: 'research',
      mission: 'Evaluate useful tools.',
    });
    const project = database.platform.createProject({
      ventureId: venture.id,
      name: 'Tool Survey',
      objective: 'Compare free research services.',
      successCriteria: ['A sourced comparison is approved'],
    });
    return database.work.createCard({ projectId: project.id, title: 'Survey the field' });
  }

  it('opens a room for a card and finds it again by the card', () => {
    database = createDatabase(':memory:');
    const card = seedCard();

    const room = database.rooms.createRoomForCard({ cardId: card.id, title: card.title });

    expect(room).toMatchObject({ cardId: card.id, title: card.title, status: 'open' });
    expect(database.rooms.getRoomForCard(card.id)?.id).toBe(room.id);
    expect(database.rooms.getRoom(room.id)?.id).toBe(room.id);
  });

  it('gives a card exactly one room', () => {
    database = createDatabase(':memory:');
    const card = seedCard();
    database.rooms.createRoomForCard({ cardId: card.id, title: card.title });

    // Two rooms for one card means two places to look for the same
    // conversation, and half of it lost in whichever one nobody opens.
    expect(() =>
      database!.rooms.createRoomForCard({ cardId: card.id, title: 'Second room' }),
    ).toThrow(/already has a room/i);
  });

  it('archives a room without losing what was said in it', () => {
    database = createDatabase(':memory:');
    const card = seedCard();
    const room = database.rooms.createRoomForCard({ cardId: card.id, title: card.title });
    database.rooms.addMember({ roomId: room.id, memberKind: 'user', memberId: 'owner' });
    const posted = database.rooms.postMessage({
      roomId: room.id, authorKind: 'user', authorId: 'owner',
      threadId: null, runId: null, body: 'Where did we land on this?',
    });

    const archived = database.rooms.archiveRoom(room.id);

    expect(archived).toMatchObject({ status: 'archived' });
    expect(archived.archivedAt).not.toBeNull();
    // A closed room is searchable, not deleted.
    expect(database.rooms.listMessages(room.id)[0]?.message.id).toBe(posted.id);
  });

  it('REFUSES a post into an archived room', () => {
    database = createDatabase(':memory:');
    const card = seedCard();
    const room = database.rooms.createRoomForCard({ cardId: card.id, title: card.title });
    database.rooms.addMember({ roomId: room.id, memberKind: 'user', memberId: 'owner' });
    database.rooms.archiveRoom(room.id);

    expect(() =>
      database!.rooms.postMessage({
        roomId: room.id, authorKind: 'user', authorId: 'owner',
        threadId: null, runId: null, body: 'One more thing.',
      }),
    ).toThrow(/archived/i);
  });

  it('holds both people and agents as members, each with its kind', () => {
    database = createDatabase(':memory:');
    const card = seedCard();
    const room = database.rooms.createRoomForCard({ cardId: card.id, title: card.title });

    database.rooms.addMember({ roomId: room.id, memberKind: 'user', memberId: 'owner' });
    database.rooms.addMember({ roomId: room.id, memberKind: 'org_agent', memberId: 'exec-cto' });

    expect(database.rooms.listMembers(room.id)).toEqual([
      expect.objectContaining({ memberKind: 'org_agent', memberId: 'exec-cto' }),
      expect.objectContaining({ memberKind: 'user', memberId: 'owner' }),
    ]);

    database.rooms.removeMember({ roomId: room.id, memberKind: 'org_agent', memberId: 'exec-cto' });
    expect(database.rooms.listMembers(room.id)).toHaveLength(1);
  });

  it('adding a member twice is not an error and does not duplicate them', () => {
    database = createDatabase(':memory:');
    const card = seedCard();
    const room = database.rooms.createRoomForCard({ cardId: card.id, title: card.title });

    database.rooms.addMember({ roomId: room.id, memberKind: 'user', memberId: 'owner' });
    database.rooms.addMember({ roomId: room.id, memberKind: 'user', memberId: 'owner' });

    expect(database.rooms.listMembers(room.id)).toHaveLength(1);
  });

  it('REFUSES a post from an agent that is not in the room', () => {
    database = createDatabase(':memory:');
    const card = seedCard();
    const room = database.rooms.createRoomForCard({ cardId: card.id, title: card.title });

    expect(() =>
      database!.rooms.postMessage({
        roomId: room.id, authorKind: 'org_agent', authorId: 'exec-cto',
        threadId: null, runId: null, body: 'Reporting in.',
      }),
    ).toThrow(/not a member/i);
  });

  it('lets the system post without membership, since it belongs to no room', () => {
    database = createDatabase(':memory:');
    const card = seedCard();
    const room = database.rooms.createRoomForCard({ cardId: card.id, title: card.title });

    const posted = database.rooms.postMessage({
      roomId: room.id, authorKind: 'system', authorId: null,
      threadId: null, runId: 'run-1', body: 'Run started.',
    });

    expect(posted).toMatchObject({ authorKind: 'system', runId: 'run-1' });
  });

  it('groups thread replies under their parent, oldest first', () => {
    database = createDatabase(':memory:');
    const card = seedCard();
    const room = database.rooms.createRoomForCard({ cardId: card.id, title: card.title });
    database.rooms.addMember({ roomId: room.id, memberKind: 'user', memberId: 'owner' });
    database.rooms.addMember({ roomId: room.id, memberKind: 'org_agent', memberId: 'exec-cto' });

    const question = database.rooms.postMessage({
      roomId: room.id, authorKind: 'user', authorId: 'owner',
      threadId: null, runId: null, body: 'Which sources publish their method?',
    });
    const firstReply = database.rooms.postMessage({
      roomId: room.id, authorKind: 'org_agent', authorId: 'exec-cto',
      threadId: question.id, runId: null, body: 'Three of the six.',
    });
    const secondReply = database.rooms.postMessage({
      roomId: room.id, authorKind: 'user', authorId: 'owner',
      threadId: question.id, runId: null, body: 'List them.',
    });
    const separate = database.rooms.postMessage({
      roomId: room.id, authorKind: 'user', authorId: 'owner',
      threadId: null, runId: null, body: 'Unrelated point.',
    });

    const thread = database.rooms.listMessages(room.id);
    expect(thread.map((entry) => entry.message.id)).toEqual([question.id, separate.id]);
    expect(thread[0]?.replies.map((reply) => reply.id)).toEqual([firstReply.id, secondReply.id]);
    expect(thread[1]?.replies).toEqual([]);
  });

  it('REFUSES a reply to a message in a different room', () => {
    database = createDatabase(':memory:');
    const first = seedCard();
    const second = seedCard();
    const firstRoom = database.rooms.createRoomForCard({ cardId: first.id, title: 'First' });
    const secondRoom = database.rooms.createRoomForCard({ cardId: second.id, title: 'Second' });
    database.rooms.addMember({ roomId: firstRoom.id, memberKind: 'user', memberId: 'owner' });
    database.rooms.addMember({ roomId: secondRoom.id, memberKind: 'user', memberId: 'owner' });
    const parent = database.rooms.postMessage({
      roomId: firstRoom.id, authorKind: 'user', authorId: 'owner',
      threadId: null, runId: null, body: 'Over here.',
    });

    expect(() =>
      database!.rooms.postMessage({
        roomId: secondRoom.id, authorKind: 'user', authorId: 'owner',
        threadId: parent.id, runId: null, body: 'Replying from elsewhere.',
      }),
    ).toThrow(/same room/i);
  });

  it('REFUSES a reply to a reply, keeping threads one level deep', () => {
    database = createDatabase(':memory:');
    const card = seedCard();
    const room = database.rooms.createRoomForCard({ cardId: card.id, title: card.title });
    database.rooms.addMember({ roomId: room.id, memberKind: 'user', memberId: 'owner' });
    const parent = database.rooms.postMessage({
      roomId: room.id, authorKind: 'user', authorId: 'owner',
      threadId: null, runId: null, body: 'Top level.',
    });
    const reply = database.rooms.postMessage({
      roomId: room.id, authorKind: 'user', authorId: 'owner',
      threadId: parent.id, runId: null, body: 'A reply.',
    });

    // One level, like a chat thread. Arbitrary nesting produces conversations
    // nobody can follow and a renderer nobody can write.
    expect(() =>
      database!.rooms.postMessage({
        roomId: room.id, authorKind: 'user', authorId: 'owner',
        threadId: reply.id, runId: null, body: 'A reply to a reply.',
      }),
    ).toThrow(/one level/i);
  });

  it('starts the canvas empty and bumps the revision on every write', () => {
    database = createDatabase(':memory:');
    const card = seedCard();
    const room = database.rooms.createRoomForCard({ cardId: card.id, title: card.title });

    expect(database.rooms.getCanvas(room.id)).toMatchObject({ revision: 0, content: '' });

    const first = database.rooms.setCanvas({ roomId: room.id, content: '# Findings' });
    const second = database.rooms.setCanvas({ roomId: room.id, content: '# Findings\n\nOne.' });

    expect(first.revision).toBe(1);
    expect(second.revision).toBe(2);
    expect(database.rooms.getCanvas(room.id)).toMatchObject({
      revision: 2, content: '# Findings\n\nOne.',
    });
  });
});
