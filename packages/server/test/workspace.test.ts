import { describe, expect, test } from 'vitest';
import type { ClientFrame, Cursor, Op, ServerFrame } from '@syncline/protocol';
import {
  createMemoryStorage,
  createWorkspace,
  workspaceStep,
  type ServerEffect,
  type ServerInput,
  type WorkspaceConfig,
} from '@syncline/server';
import { DEMO_RULESET, SEED_CLIENT_ID, seedOps } from 'syncline-demo-schema';

const setup = () => {
  const storage = createMemoryStorage();
  const state = createWorkspace();
  const config: WorkspaceConfig = {
    workspaceId: 'acme',
    schemaVersion: 1,
    minWritableVersion: 1,
    ruleset: DEMO_RULESET,
    migrateOp: (op) => op,
  };
  const step = (input: ServerInput): ServerEffect[] => workspaceStep(state, config, storage, input);
  step({ type: 'seed', clientId: SEED_CLIENT_ID, ops: seedOps('acme'), now: 0 });
  return { storage, state, step };
};

type Step = ReturnType<typeof setup>['step'];

const hello = (step: Step, connId: string, userId: string, cursor?: Cursor): ServerEffect[] =>
  step({
    type: 'hello',
    connId,
    userId,
    clientId: `dev-${connId}`,
    schemaVersion: 1,
    ...(cursor !== undefined ? { cursor } : {}),
    now: 1,
  });

const push = (step: Step, connId: string, ops: { opId: number; op: Op; v?: number }[]): ServerEffect[] =>
  step({
    type: 'frame',
    connId,
    frame: {
      t: 'push',
      ops: ops.map(({ opId, op, v }) => ({ opId, baseSchemaVersion: v ?? 1, op })),
    } satisfies ClientFrame,
    now: 2,
  });

const framesTo = (effects: ServerEffect[], connId: string): ServerFrame[] =>
  effects.filter((e): e is Extract<ServerEffect, { type: 'send' }> => e.type === 'send' && e.connId === connId).map((e) => e.frame);

const frameOf = <T extends ServerFrame['t']>(
  effects: ServerEffect[],
  connId: string,
  t: T,
): Extract<ServerFrame, { t: T }> | undefined =>
  framesTo(effects, connId).find((f): f is Extract<ServerFrame, { t: T }> => f.t === t);

const closesOf = (effects: ServerEffect[], connId: string) =>
  effects.filter((e) => e.type === 'close' && e.connId === connId);

describe('hello (ADR-002/004)', () => {
  test('member with no cursor gets snapshot mode with the full permitted slice', () => {
    const { step, storage } = setup();
    const effects = hello(step, 'c1', 'theo');
    const ack = frameOf(effects, 'c1', 'helloAck');
    expect(ack?.mode).toBe('snapshot');
    const snap = frameOf(effects, 'c1', 'snapshot');
    expect(snap?.atSeq).toBe(storage.headSeq());
    // 22 issues + 3 memberships, all readable by a viewer under the demo ruleset
    expect(snap?.rows).toHaveLength(25);
  });

  test('non-member is refused with AUTH_FAILED', () => {
    const { step } = setup();
    const effects = hello(step, 'c1', 'sam');
    expect(frameOf(effects, 'c1', 'error')?.code).toBe('AUTH_FAILED');
    expect(closesOf(effects, 'c1')).toHaveLength(1);
  });

  test('matching-epoch cursor gets incremental backfill with advanceTo', () => {
    const { step, storage } = setup();
    const effects = hello(step, 'c1', 'maya', { seq: 20, epoch: 0 });
    expect(frameOf(effects, 'c1', 'helloAck')?.mode).toBe('incremental');
    const ops = frameOf(effects, 'c1', 'ops');
    expect(ops?.advanceTo).toBe(storage.headSeq());
    expect(ops?.ops[0]?.seq).toBe(21);
  });

  test('cursor ahead of head or epoch is BAD_CURSOR', () => {
    const { step, storage } = setup();
    expect(frameOf(hello(step, 'c1', 'maya', { seq: storage.headSeq() + 5, epoch: 0 }), 'c1', 'error')?.code).toBe('BAD_CURSOR');
    expect(frameOf(hello(step, 'c2', 'maya', { seq: 1, epoch: 9 }), 'c2', 'error')?.code).toBe('BAD_CURSOR');
  });

  test('stale epoch falls back to snapshot mode', () => {
    const { step, storage } = setup();
    storage.setEpoch('maya', { epoch: 3 });
    const effects = hello(step, 'c1', 'maya', { seq: 4, epoch: 1 });
    expect(frameOf(effects, 'c1', 'helloAck')?.mode).toBe('snapshot');
    expect(frameOf(effects, 'c1', 'snapshot')?.epoch).toBe(3);
  });

  test('presence lists connected users and updates on disconnect', () => {
    const { step } = setup();
    hello(step, 'c1', 'priya');
    const effects = hello(step, 'c2', 'maya');
    expect(frameOf(effects, 'c1', 'presence')?.connected).toEqual(['maya', 'priya']);
    const gone = step({ type: 'disconnect', connId: 'c2', now: 3 });
    expect(frameOf(gone, 'c1', 'presence')?.connected).toEqual(['priya']);
  });
});

describe('push (ADR-002/003)', () => {
  test('append acks with seq and echoes to every member including the pusher', () => {
    const { step } = setup();
    hello(step, 'c1', 'priya');
    hello(step, 'c2', 'maya');
    const effects = push(step, 'c2', [
      { opId: 1, op: { kind: 'update', table: 'issues', rowId: 'acme-1', field: 'status', value: 'todo' } },
    ]);
    const ack = frameOf(effects, 'c2', 'pushAck');
    expect(ack?.results).toEqual([{ opId: 1, seq: 26 }]);
    expect(frameOf(effects, 'c1', 'ops')?.ops).toHaveLength(1);
    expect(frameOf(effects, 'c2', 'ops')?.ops).toHaveLength(1); // own-op echo
  });

  test('duplicate replay is acked as duplicate, never re-applied', () => {
    const { step, storage } = setup();
    hello(step, 'c1', 'maya');
    const op: Op = { kind: 'update', table: 'issues', rowId: 'acme-2', field: 'title', value: 'x' };
    push(step, 'c1', [{ opId: 1, op }]);
    const head = storage.headSeq();
    const replay = push(step, 'c1', [{ opId: 1, op }]);
    expect(frameOf(replay, 'c1', 'pushAck')?.results).toEqual([{ opId: 1, duplicate: true }]);
    expect(storage.headSeq()).toBe(head);
  });

  test('an opId gap is a fatal OP_GAP', () => {
    const { step } = setup();
    hello(step, 'c1', 'maya');
    const effects = push(step, 'c1', [
      { opId: 3, op: { kind: 'update', table: 'issues', rowId: 'acme-2', field: 'title', value: 'x' } },
    ]);
    expect(frameOf(effects, 'c1', 'error')?.code).toBe('OP_GAP');
    expect(closesOf(effects, 'c1')).toHaveLength(1);
  });

  test('forbidden ops are rejected but advance the mark (ADR-002 ruling)', () => {
    const { step, storage } = setup();
    hello(step, 'c1', 'theo'); // viewer
    const effects = push(step, 'c1', [
      { opId: 1, op: { kind: 'update', table: 'issues', rowId: 'acme-1', field: 'title', value: 'nope' } },
      { opId: 2, op: { kind: 'update', table: 'issues', rowId: 'acme-1', field: 'status', value: 'done' } },
    ]);
    expect(frameOf(effects, 'c1', 'pushAck')?.results).toEqual([
      { opId: 1, rejected: 'forbidden' },
      { opId: 2, rejected: 'forbidden' },
    ]);
    expect(storage.getClientMark('dev-c1')).toBe(2);
    expect(storage.headSeq()).toBe(25); // nothing appended
  });

  test('version outside [minWritable, server] is rejected per-op', () => {
    const { step } = setup();
    hello(step, 'c1', 'maya');
    const effects = push(step, 'c1', [
      { opId: 1, v: 99, op: { kind: 'update', table: 'issues', rowId: 'acme-1', field: 'title', value: 'x' } },
    ]);
    expect(frameOf(effects, 'c1', 'pushAck')?.results).toEqual([{ opId: 1, rejected: 'version' }]);
  });
});

describe('revocation (ADR-004)', () => {
  // Membership episodes are keyed by minted rowIds; the seeds use mem-<user>-1.
  const revoke = (step: Step, connId: string, opId: number, target: string): ServerEffect[] =>
    push(step, connId, [{ opId, op: { kind: 'delete', table: 'memberships', rowId: `mem-${target}-1` } }]);

  test('revoke pushes forget then REVOKED close to the target, clears marks, bumps epoch', () => {
    const { step, storage } = setup();
    hello(step, 'owner', 'priya');
    hello(step, 'victim', 'maya');
    push(step, 'victim', [
      { opId: 1, op: { kind: 'update', table: 'issues', rowId: 'acme-1', field: 'title', value: 'mine' } },
    ]);
    const effects = revoke(step, 'owner', 1, 'maya');
    const forget = frameOf(effects, 'victim', 'forget');
    expect(forget?.epoch).toBe(1);
    expect(forget?.upToSeq).toBe(storage.headSeq());
    expect(closesOf(effects, 'victim')).toHaveLength(1);
    expect(storage.getEpoch('maya')).toEqual({ epoch: 1, revokedUpToSeq: storage.headSeq() });
    expect(storage.getClientMark('dev-victim')).toBe(0); // marks cleared
    // the victim gets no data frame for the revoke op itself
    expect(frameOf(effects, 'victim', 'ops')).toBeUndefined();
    // remaining members see the membership delete as data
    expect(frameOf(effects, 'owner', 'ops')?.ops[0]?.op.kind).toBe('delete');
  });

  test('a revoked principal reconnecting gets forget then REVOKED, never data', () => {
    const { step } = setup();
    hello(step, 'owner', 'priya');
    revoke(step, 'owner', 1, 'maya');
    const effects = hello(step, 'back', 'maya', { seq: 10, epoch: 0 });
    const frames = framesTo(effects, 'back');
    expect(frames.map((f) => f.t)).toEqual(['forget', 'error']);
    expect(frameOf(effects, 'back', 'error')?.code).toBe('REVOKED');
  });

  test('self-removal acks the push before the forget (ADR-004 step 3)', () => {
    const { step } = setup();
    hello(step, 'me', 'maya');
    const effects = revoke(step, 'me', 1, 'maya');
    const frames = framesTo(effects, 'me');
    const order = frames.map((f) => f.t);
    expect(order.indexOf('pushAck')).toBeLessThan(order.indexOf('forget'));
  });

  test('re-invite starts a fresh epoch and a snapshot bootstrap', () => {
    const { step, storage } = setup();
    hello(step, 'owner', 'priya');
    revoke(step, 'owner', 1, 'maya');
    push(step, 'owner', [
      { opId: 2, op: { kind: 'create', table: 'memberships', rowId: 'mem-maya-2', fields: { userId: 'maya', role: 'editor' } } },
    ]);
    expect(storage.getEpoch('maya')).toEqual({ epoch: 2 });
    const effects = hello(step, 'back', 'maya', { seq: 5, epoch: 0 });
    expect(frameOf(effects, 'back', 'helloAck')?.mode).toBe('snapshot');
    expect(frameOf(effects, 'back', 'snapshot')?.epoch).toBe(2);
  });

  test('role change closes the live connection with EPOCH_CHANGED', () => {
    const { step } = setup();
    hello(step, 'owner', 'priya');
    hello(step, 'target', 'maya');
    const effects = push(step, 'owner', [
      { opId: 1, op: { kind: 'update', table: 'memberships', rowId: 'mem-maya-1', field: 'role', value: 'viewer' } },
    ]);
    expect(frameOf(effects, 'target', 'error')?.code).toBe('EPOCH_CHANGED');
    expect(closesOf(effects, 'target')).toHaveLength(1);
  });

  test('hibernation-stale connection is evicted at next message (receive-time check)', () => {
    const { step, storage } = setup();
    hello(step, 'owner', 'priya');
    hello(step, 'sleepy', 'maya');
    // epoch bumps behind the connection's back (as if another DO instance did it)
    storage.setEpoch('maya', { epoch: 7 });
    const effects = step({ type: 'frame', connId: 'sleepy', frame: { t: 'ping' }, now: 9 });
    expect(frameOf(effects, 'sleepy', 'error')?.code).toBe('EPOCH_CHANGED');
    expect(closesOf(effects, 'sleepy')).toHaveLength(1);
  });
});
