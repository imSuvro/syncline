// Regressions for the stage-15 review findings. Each test fails against
// the code as it stood before the fix.
import { describe, expect, test } from 'vitest';
import type { ClientFrame, Op, ServerFrame } from '@syncline/protocol';
import {
  createMemoryStorage,
  createWorkspace,
  workspaceStep,
  type ServerEffect,
  type ServerInput,
  type WorkspaceConfig,
} from '@syncline/server';
import { DEMO_RULESET, SEED_CLIENT_ID, migrateOp, seedOps } from 'syncline-demo-schema';

const setup = () => {
  const storage = createMemoryStorage();
  const state = createWorkspace();
  const config: WorkspaceConfig = {
    workspaceId: 'acme',
    schemaVersion: 2,
    minWritableVersion: 1,
    ruleset: DEMO_RULESET,
    migrateOp,
  };
  const step = (input: ServerInput): ServerEffect[] => workspaceStep(state, config, storage, input);
  step({ type: 'seed', clientId: SEED_CLIENT_ID, ops: seedOps('acme'), now: 0 });
  return { storage, step };
};
type Step = ReturnType<typeof setup>['step'];

const hello = (step: Step, connId: string, userId: string, clientId: string, cursor?: { seq: number; epoch: number }): ServerEffect[] =>
  step({ type: 'hello', connId, userId, clientId, schemaVersion: 2, ...(cursor !== undefined ? { cursor } : {}), now: 1 });

const push = (step: Step, connId: string, ops: { opId: number; op: Op }[]): ServerEffect[] =>
  step({
    type: 'frame',
    connId,
    frame: { t: 'push', ops: ops.map(({ opId, op }) => ({ opId, baseSchemaVersion: 2, op })) } satisfies ClientFrame,
    now: 2,
  });

const frameOf = <T extends ServerFrame['t']>(effects: ServerEffect[], connId: string, t: T): Extract<ServerFrame, { t: T }> | undefined =>
  effects
    .filter((e): e is Extract<ServerEffect, { type: 'send' }> => e.type === 'send' && e.connId === connId)
    .map((e) => e.frame)
    .find((f): f is Extract<ServerFrame, { t: T }> => f.t === t);

describe('a clientId belongs to exactly one user (review #1)', () => {
  test('claiming another user\'s clientId is refused', () => {
    const { step } = setup();
    hello(step, 'c1', 'priya', 'priya-device');
    // Maya has a valid identity but claims Priya's device id, whose dedup
    // marks she could otherwise advance — destroying Priya's pending writes.
    const effects = hello(step, 'c2', 'maya', 'priya-device');
    expect(frameOf(effects, 'c2', 'error')?.code).toBe('AUTH_FAILED');
  });

  test('a user reconnecting with their own clientId is fine', () => {
    const { step } = setup();
    hello(step, 'c1', 'priya', 'priya-device');
    step({ type: 'disconnect', connId: 'c1', now: 2 });
    const effects = hello(step, 'c2', 'priya', 'priya-device');
    expect(frameOf(effects, 'c2', 'helloAck')).toBeDefined();
  });
});

describe('role is re-read for every op in a batch (review #2)', () => {
  test('ops after a self-revoke in the same push are not authorized by the stale role', () => {
    const { step, storage } = setup();
    hello(step, 'c1', 'priya', 'priya-device');
    const before = storage.getRow('issues', 'acme-3')?.fields['title']?.v;

    const effects = push(step, 'c1', [
      { opId: 1, op: { kind: 'delete', table: 'memberships', rowId: 'mem-priya-1' } },
      { opId: 2, op: { kind: 'update', table: 'issues', rowId: 'acme-3', field: 'title', value: 'written after revoke' } },
    ]);

    // The membership delete lands; the follow-up write must not.
    expect(storage.getRow('issues', 'acme-3')?.fields['title']?.v).toBe(before);
    const ack = frameOf(effects, 'c1', 'pushAck');
    expect(ack?.results.map((r) => r.opId)).toEqual([1]); // op 2 never processed
    expect(frameOf(effects, 'c1', 'forget')).toBeDefined();
  });
});

describe('a new epoch resets the op-id sequence (review #5)', () => {
  test('the snapshot path clears the dedup mark so a stale device cannot trip OP_GAP', () => {
    const { step, storage } = setup();
    hello(step, 'c1', 'maya', 'maya-phone');
    push(step, 'c1', [{ opId: 1, op: { kind: 'update', table: 'issues', rowId: 'acme-1', field: 'title', value: 'x' } }]);
    expect(storage.getClientMark('maya-phone')).toBe(1);

    // A revoke clears marks; a re-invite bumps the epoch again.
    hello(step, 'owner', 'priya', 'priya-device');
    push(step, 'owner', [{ opId: 1, op: { kind: 'delete', table: 'memberships', rowId: 'mem-maya-1' } }]);
    push(step, 'owner', [
      { opId: 2, op: { kind: 'create', table: 'memberships', rowId: 'mem-maya-2', fields: { userId: 'maya', role: 'editor' } } },
    ]);

    // The phone reconnects with a stale cursor → snapshot path → mark reset.
    const effects = hello(step, 'c2', 'maya', 'maya-phone', { seq: 3, epoch: 0 });
    expect(frameOf(effects, 'c2', 'helloAck')?.mode).toBe('snapshot');
    expect(storage.getClientMark('maya-phone')).toBe(0);

    // Its renumbered outbox now pushes cleanly instead of gapping.
    const replay = push(step, 'c2', [{ opId: 1, op: { kind: 'update', table: 'issues', rowId: 'acme-2', field: 'title', value: 'replayed' } }]);
    expect(frameOf(replay, 'c2', 'error')).toBeUndefined();
    expect(storage.getRow('issues', 'acme-2')?.fields['title']?.v).toBe('replayed');
  });
});

describe('one live membership per user (review #12)', () => {
  test('inviting an existing member is rejected', () => {
    const { step } = setup();
    hello(step, 'c1', 'priya', 'priya-device');
    const effects = push(step, 'c1', [
      { opId: 1, op: { kind: 'create', table: 'memberships', rowId: 'mem-maya-dupe', fields: { userId: 'maya', role: 'owner' } } },
    ]);
    expect(frameOf(effects, 'c1', 'pushAck')?.results).toEqual([{ opId: 1, rejected: 'forbidden' }]);
  });
});
