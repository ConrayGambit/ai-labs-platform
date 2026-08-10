import { afterEach, describe, expect, it } from 'vitest';
import { createDatabase, type OrchestratorDatabase } from '../../src/server/database.js';
import { OWNER_USER_ID } from '../../src/shared/identity.js';

describe('identity and venture-scoped access', () => {
  let database: OrchestratorDatabase | undefined;
  afterEach(() => {
    database?.close();
    database = undefined;
  });

  const open = (): OrchestratorDatabase => (database = createDatabase(':memory:'));

  it('seeds exactly one owner, with the well-known id', () => {
    const db = open();
    const owner = db.identity.getOwner();
    expect(owner).not.toBeNull();
    expect(owner?.id).toBe(OWNER_USER_ID);
    expect(owner?.role).toBe('owner');
    expect(owner?.enabled).toBe(true);
  });

  it('creates additional users with generated ids and distinct roles', () => {
    const db = open();
    const staff = db.identity.createUser({ displayName: 'Staff', role: 'staff' });
    const observer = db.identity.createUser({ displayName: 'Observer', role: 'observer' });
    expect(staff.role).toBe('staff');
    expect(observer.role).toBe('observer');
    expect(staff.id).not.toBe(OWNER_USER_ID);
  });

  it('refuses a second owner', () => {
    const db = open();
    expect(() => db.identity.createUser({ displayName: 'Other', role: 'owner' })).toThrow(
      /owner already exists/i,
    );
  });

  it('grants the owner access to every venture without an explicit grant', () => {
    const db = open();
    expect(() => db.identity.assertVentureAccess(OWNER_USER_ID, 'venture-anything')).not.toThrow();
  });

  it('DENIES a staff user access to a venture they were not granted', () => {
    const db = open();
    const staff = db.identity.createUser({ displayName: 'Staff', role: 'staff' });
    expect(() => db.identity.assertVentureAccess(staff.id, 'venture-a')).toThrow(/access denied/i);
  });

  it('allows a staff user only the ventures they were granted', () => {
    const db = open();
    const staff = db.identity.createUser({ displayName: 'Staff', role: 'staff' });
    db.identity.grantVentureAccess(staff.id, 'venture-a');
    expect(() => db.identity.assertVentureAccess(staff.id, 'venture-a')).not.toThrow();
    expect(() => db.identity.assertVentureAccess(staff.id, 'venture-b')).toThrow(/access denied/i);
    expect(db.identity.listAccessibleVentureIds(staff.id)).toEqual(['venture-a']);
  });

  it('DENIES access again once a grant is revoked', () => {
    const db = open();
    const staff = db.identity.createUser({ displayName: 'Staff', role: 'staff' });
    db.identity.grantVentureAccess(staff.id, 'venture-a');
    db.identity.revokeVentureAccess(staff.id, 'venture-a');
    expect(() => db.identity.assertVentureAccess(staff.id, 'venture-a')).toThrow(/access denied/i);
  });

  it('DENIES a disabled user even with a valid grant', () => {
    const db = open();
    const staff = db.identity.createUser({ displayName: 'Staff', role: 'staff' });
    db.identity.grantVentureAccess(staff.id, 'venture-a');
    db.identity.setUserEnabled(staff.id, false);
    expect(() => db.identity.assertVentureAccess(staff.id, 'venture-a')).toThrow(/disabled/i);
  });

  it('DENIES an observer a role-gated action', () => {
    const db = open();
    const observer = db.identity.createUser({ displayName: 'Observer', role: 'observer' });
    expect(() => db.identity.assertRole(observer.id, ['owner', 'staff'])).toThrow(/not permitted/i);
  });

  it('DENIES an unknown user id', () => {
    const db = open();
    expect(() => db.identity.assertVentureAccess('no-such-user', 'venture-a')).toThrow(
      /user not found/i,
    );
  });
});
