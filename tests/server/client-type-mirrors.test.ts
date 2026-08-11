/**
 * The client (`src/web`) may only import from `src/shared` — never from
 * `src/server` — so three of its types cannot import their server originals
 * and instead hand-mirror them field for field:
 *
 *   - `src/web/api/client.ts`'s `RunSummary`          mirrors `AgentRun`
 *   - `src/web/realtime/useRunStream.ts`'s `PendingPermission` mirrors `PermissionRecord`
 *   - `src/web/realtime/useRunStream.ts`'s `RunUpdate`        mirrors `RunEvent`
 *
 * Nothing else enforces that a mirror stays accurate: rename a field on the
 * server side and no runtime test fails (both sides are just plain objects;
 * nothing throws), and no test in `tests/web` can catch it either, because a
 * client-side test cannot import the server type it would need to compare
 * against. Only a place that is allowed to see both sides — a test under
 * `tests/server`, which is not "client code" — can make drift a compile
 * error instead of an `undefined` value discovered at runtime.
 *
 * This file asserts nothing at runtime; `AssertEqual` below only has to fail
 * to compile.
 */
import { describe, expect, it } from 'vitest';
import type { AgentRun, PermissionRecord } from '../../src/server/run-repository.js';
import type { RunEvent } from '../../src/server/run-supervisor.js';
import type { RunSummary } from '../../src/web/api/client.js';
import type { PendingPermission, RunUpdate } from '../../src/web/realtime/useRunStream.js';

/**
 * `true` when `T` and `U` are structurally identical; `never` otherwise.
 *
 * Wrapped in one-element tuples so the check is not distributive over union
 * members (a bare `T extends U ? ... : ...` decomposes a union type member by
 * member, which is not what a whole-shape equality check wants — `RunUpdate`
 * and `RunEvent` are both unions). Checked in both directions: `T extends U`
 * alone would pass if `T` merely had every field `U` has plus extras (or vice
 * versa), missing exactly the kind of drift — a field renamed, added, or
 * retyped on one side only — this exists to catch.
 */
type AssertEqual<T, U> = [T] extends [U] ? ([U] extends [T] ? true : never) : never;

// If any of the three lines below fails to compile, a mirror type has
// drifted from its server original. Fix the mirror (or, if the server type
// itself changed on purpose, update the mirror to match) — do not weaken or
// remove the assertion to make the build pass again.
const runSummaryMirrorsAgentRun: AssertEqual<RunSummary, AgentRun> = true;
const pendingPermissionMirrorsPermissionRecord: AssertEqual<PendingPermission, PermissionRecord> = true;
const runUpdateMirrorsRunEvent: AssertEqual<RunUpdate, RunEvent> = true;

describe('client-side mirror types stay in sync with their server originals', () => {
  it('is a compile-time check — a drifted mirror fails `npm run typecheck`, not this assertion', () => {
    // Referenced so nothing here is reported unused; the real check already
    // ran, at compile time, before this test body ever executed.
    expect([
      runSummaryMirrorsAgentRun,
      pendingPermissionMirrorsPermissionRecord,
      runUpdateMirrorsRunEvent,
    ]).toEqual([true, true, true]);
  });
});
