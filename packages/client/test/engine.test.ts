// Client core tests (backlog D1-D2, D5): the sans-IO engine driven by
// scripted server frames — no IO, no clock, fully deterministic.
import { describe, expect, test } from 'vitest';
import type { Op, ServerFrame } from '@syncline/protocol';
import {
  clientStep,
  createClient,
  decodeStored,
  pendingCount,
  queryTable,
  type ClientEffect,
  type ClientState,
  type StorageRecord,
} from '@syncline/client';

const config = { clientId: 'dev-1', workspaceId: 'acme', schemaVersion: 1 };

/** A fake durable store that replays storage effects, so we can assert
 * exactly what would survive a crash at any barrier. */
class FakeStore {
  readonly committed = new Map<string, string>();
  private staged: StorageRecord[] = [];

  apply(effects: ClientEffect[]): void {
    for (const effect of effects) {
      if (effect.type === 'storageWrite') this.staged.push(...effect.records);
      else if (effect.type === 'storageBarrier') this.commit();
    }
  }

  /** Everything written so far becomes durable. */
  commit(): void {
    for (const record of this.staged) {
      if ('clearAll' in record) this.committed.clear();
      else if (record.value === null) this.committed.delete(record.key);
      else this.committed.set(record.key, record.value);
    }
    this.staged = [];
  }

  /** Crash: writes since the last barrier are lost. */
  crash(): void {
    this.staged = [];
  }
}

const boot = (store: FakeStore, online = true): ClientState => {
  const state = createClient(config);
  const stored = store.committed.size > 0 ? decodeStored(store.committed) : null;
  store.apply(clientStep(state, { type: 'boot', stored, online, now: 0 }));
  return state;
};

const drive = (state: ClientState, store: FakeStore, frame: ServerFrame): ClientEffect[] => {
  const effects = clientStep(state, { type: 'serverFrame', frame, now: 1 });
  store.apply(effects);
  return effects;
};

const helloAck = (mode: 'incremental' | 'snapshot', epoch = 0): ServerFrame => ({
  t: 'helloAck',
  serverSchemaVersion: 1,
  minWritableVersion: 1,
  mode,
  epoch,
  presence: [],
});

const edit = (rowId: string, field: string, value: string): Op => ({
  kind: 'update',
  table: 'issues',
  rowId,
  field,
  value,
});

const sends = (effects: ClientEffect[]): Extract<ClientEffect, { type: 'send' }>[] =>
  effects.filter((e): e is Extract<ClientEffect, { type: 'send' }> => e.type === 'send');

describe('optimistic overlay (ADR-005)', () => {
  test('local edits show immediately and retire on ack', () => {
    const store = new FakeStore();
    const state = boot(store);
    drive(state, store, helloAck('snapshot'));
    drive(state, store, {
      t: 'snapshot',
      epoch: 0,
      atSeq: 5,
      rows: [{ table: 'issues', rowId: 'a', fields: { title: { v: 'original', seq: 5 } } }],
    });

    store.apply(clientStep(state, { type: 'localMutation', op: edit('a', 'title', 'mine'), now: 2 }));
    expect(queryTable(state, 'issues')[0]?.values['title']).toBe('mine');
    expect(queryTable(state, 'issues')[0]?.pending).toBe(true);
    expect(pendingCount(state)).toBe(1);

    drive(state, store, { t: 'pushAck', results: [{ opId: 1, seq: 6 }] });
    drive(state, store, {
      t: 'ops',
      epoch: 0,
      ops: [{ seq: 6, clientId: 'dev-1', opId: 1, op: edit('a', 'title', 'mine') }],
      advanceTo: 6,
    });
    expect(pendingCount(state)).toBe(0);
    expect(queryTable(state, 'issues')[0]?.values['title']).toBe('mine');
    expect(queryTable(state, 'issues')[0]?.pending).toBe(false);
  });

  test('a rejected op leaves the outbox, reverts the overlay, and reports why', () => {
    const store = new FakeStore();
    const state = boot(store);
    drive(state, store, helloAck('snapshot'));
    drive(state, store, {
      t: 'snapshot',
      epoch: 0,
      atSeq: 1,
      rows: [{ table: 'issues', rowId: 'a', fields: { title: { v: 'server', seq: 1 } } }],
    });
    store.apply(clientStep(state, { type: 'localMutation', op: edit('a', 'title', 'nope'), now: 2 }));
    expect(queryTable(state, 'issues')[0]?.values['title']).toBe('nope');

    const effects = drive(state, store, {
      t: 'pushAck',
      results: [{ opId: 1, rejected: 'forbidden' }],
    });
    expect(pendingCount(state)).toBe(0);
    expect(queryTable(state, 'issues')[0]?.values['title']).toBe('server');
    expect(effects).toContainEqual({
      type: 'emitEvent',
      event: { kind: 'opRejected', opId: 1, reason: 'forbidden' },
    });
  });
});

describe('durable outbox (D2, ADR-001 barrier contract)', () => {
  test('an op is durable before it is ever sent', () => {
    const store = new FakeStore();
    const state = boot(store);
    drive(state, store, helloAck('incremental'));
    const effects = clientStep(state, { type: 'localMutation', op: edit('a', 'title', 'x'), now: 2 });
    const barrierIdx = effects.findIndex((e) => e.type === 'storageBarrier');
    const sendIdx = effects.findIndex((e) => e.type === 'send');
    expect(barrierIdx).toBeGreaterThanOrEqual(0);
    expect(sendIdx).toBeGreaterThan(barrierIdx); // durable, then sent
  });

  test('crash after the barrier replays the op exactly once on reboot', () => {
    const store = new FakeStore();
    const state = boot(store);
    drive(state, store, helloAck('incremental'));
    store.apply(clientStep(state, { type: 'localMutation', op: edit('a', 'title', 'survives'), now: 2 }));

    // Crash before any ack; storage holds what the barrier committed.
    store.crash();
    const rebooted = boot(store);
    expect(pendingCount(rebooted)).toBe(1);
    expect(queryTable(rebooted, 'issues')[0]?.values['title']).toBe('survives');

    const effects = clientStep(rebooted, { type: 'serverFrame', frame: helloAck('incremental'), now: 3 });
    const push = sends(effects)[0];
    expect(push?.frame.t).toBe('push');
    expect(push?.frame.t === 'push' ? push.frame.ops.map((o) => o.opId) : []).toEqual([1]);
  });

  test('opIds stay gapless across reboots', () => {
    const store = new FakeStore();
    const state = boot(store);
    drive(state, store, helloAck('incremental'));
    store.apply(clientStep(state, { type: 'localMutation', op: edit('a', 'title', 'one'), now: 2 }));
    store.apply(clientStep(state, { type: 'localMutation', op: edit('b', 'title', 'two'), now: 3 }));

    const rebooted = boot(store);
    store.apply(clientStep(rebooted, { type: 'localMutation', op: edit('c', 'title', 'three'), now: 4 }));
    expect(rebooted.outbox.map((p) => p.opId)).toEqual([1, 2, 3]);
  });
});

describe('snapshot and forget (ADR-002/004)', () => {
  test('a snapshot replaces base but preserves and replays the outbox', () => {
    const store = new FakeStore();
    const state = boot(store);
    drive(state, store, helloAck('incremental'));
    store.apply(clientStep(state, { type: 'localMutation', op: edit('a', 'title', 'pending'), now: 2 }));
    expect(pendingCount(state)).toBe(1);

    // Slice changed → reconnect → snapshot mode.
    drive(state, store, helloAck('snapshot', 1));
    const effects = drive(state, store, {
      t: 'snapshot',
      epoch: 1,
      atSeq: 9,
      rows: [{ table: 'issues', rowId: 'z', fields: { title: { v: 'fresh', seq: 9 } } }],
    });
    expect(pendingCount(state)).toBe(1); // outbox survived
    const push = sends(effects)[0];
    expect(push?.frame.t === 'push' ? push.frame.ops[0]?.opId : undefined).toBe(1); // replayed
    expect(state.cursor).toEqual({ seq: 9, epoch: 1 });
  });

  test('forget purges rows, outbox, cursor and counter in one barrier', () => {
    const store = new FakeStore();
    const state = boot(store);
    drive(state, store, helloAck('snapshot'));
    drive(state, store, {
      t: 'snapshot',
      epoch: 0,
      atSeq: 3,
      rows: [{ table: 'issues', rowId: 'a', fields: { title: { v: 'secret', seq: 3 } } }],
    });
    store.apply(clientStep(state, { type: 'localMutation', op: edit('a', 'title', 'unsent'), now: 2 }));

    const effects = drive(state, store, { t: 'forget', epoch: 1, upToSeq: 4 });
    expect(state.base.size).toBe(0);
    expect(pendingCount(state)).toBe(0);
    expect(state.cursor).toBeNull();
    expect(state.nextOpId).toBe(1); // counter reset pairs with server mark clear
    expect(state.phase).toBe('revoked');
    expect(effects).toContainEqual({
      type: 'emitEvent',
      event: { kind: 'membershipRemoved', workspaceId: 'acme' },
    });

    // Nothing of the workspace survives a reboot after forget.
    const rebooted = boot(store);
    expect(queryTable(rebooted, 'issues')).toHaveLength(0);
    expect(pendingCount(rebooted)).toBe(0);
  });

  test('EPOCH_CHANGED drops the cursor so the next hello takes the snapshot path', () => {
    const store = new FakeStore();
    const state = boot(store);
    drive(state, store, helloAck('incremental'));
    drive(state, store, { t: 'ops', epoch: 0, ops: [], advanceTo: 7 });
    expect(state.cursor).toEqual({ seq: 7, epoch: 0 });
    drive(state, store, { t: 'error', code: 'EPOCH_CHANGED', message: 'role changed' });
    expect(state.cursor).toBeNull();
  });
});

describe('offline behavior (D5)', () => {
  test('offline mutations queue durably and flush on reconnect', () => {
    const store = new FakeStore();
    const state = boot(store, false);
    expect(state.phase).toBe('offline');

    for (const [i, row] of ['a', 'b', 'c'].entries()) {
      const effects = clientStep(state, { type: 'localMutation', op: edit(row, 'title', `v${String(i)}`), now: 2 });
      store.apply(effects);
      expect(sends(effects)).toHaveLength(0); // nothing leaves while offline
    }
    expect(pendingCount(state)).toBe(3);

    store.apply(clientStep(state, { type: 'connectivity', online: true, now: 5 }));
    const effects = clientStep(state, { type: 'serverFrame', frame: helloAck('incremental'), now: 6 });
    const push = sends(effects)[0];
    expect(push?.frame.t === 'push' ? push.frame.ops.map((o) => o.opId) : []).toEqual([1, 2, 3]);
  });
});
