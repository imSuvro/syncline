// Stage-11 tests (Epic E): the centerpiece — permission enforcement inside
// the sync layer, field masking across snapshot and live ops, live
// narrowing, and the invariant-(b) wiretap proving itself against a
// deliberately planted bypass.
import { describe, expect, test } from 'vitest';
import type { Op, Ruleset } from '@syncline/protocol';
import { RefClient, World, canonical } from 'syncline-harness';

/** Like the demo ruleset, but `estimate` is owner-only — the masking probe. */
const MASKED: Ruleset = {
  version: 1,
  tables: {
    issues: {
      read: { kind: 'member' },
      readFields: { estimate: { kind: 'role', atLeast: 'owner' } },
      write: {
        title: { kind: 'role', atLeast: 'editor' },
        status: { kind: 'role', atLeast: 'editor' },
        severity: { kind: 'role', atLeast: 'editor' },
        assignee: { kind: 'role', atLeast: 'editor' },
        estimate: { kind: 'role', atLeast: 'owner' },
      },
      create: { kind: 'role', atLeast: 'editor' },
      delete: { kind: 'role', atLeast: 'editor' },
    },
    memberships: {
      read: { kind: 'member' },
      write: { kind: 'role', atLeast: 'owner' },
      create: { kind: 'role', atLeast: 'owner' },
      delete: {
        kind: 'any',
        of: [{ kind: 'role', atLeast: 'owner' }, { kind: 'self', field: 'userId' }],
      },
    },
  },
};

const setEstimate = (rowId: string, value: number): Op => ({
  kind: 'update',
  table: 'issues',
  rowId,
  field: 'estimate',
  value,
});

const edit = (rowId: string, field: string, value: string): Op => ({
  kind: 'update',
  table: 'issues',
  rowId,
  field,
  value,
});

const valueOf = (client: RefClient, rowId: string, field: string): unknown =>
  client.base.get(`issues/${rowId}`)?.fields[field]?.v;

describe('field masking (E1)', () => {
  test('an owner-only field never reaches an editor, in snapshot or in live ops', () => {
    const world = new World({ seed: 11, ruleset: MASKED });
    const owner = new RefClient('priya', 'priya-dev');
    world.connect(owner);
    world.run();

    owner.mutate(setEstimate('acme-1', 8));
    world.run();
    expect(valueOf(owner, 'acme-1', 'estimate')).toBe(8);

    // Editor joins after the masked write: the snapshot must omit it.
    const editor = new RefClient('maya', 'maya-dev');
    world.connect(editor);
    world.run();
    expect(valueOf(editor, 'acme-1', 'estimate')).toBeUndefined();
    expect(valueOf(editor, 'acme-1', 'title')).toBeDefined();

    // And a later live write must not reach them either.
    owner.mutate(setEstimate('acme-2', 13));
    world.run();
    expect(valueOf(editor, 'acme-2', 'estimate')).toBeUndefined();
    expect(valueOf(owner, 'acme-2', 'estimate')).toBe(13);
  });

  test('a masked field is not writable by the role that cannot read it', () => {
    const world = new World({ seed: 12, ruleset: MASKED });
    const editor = new RefClient('maya', 'maya-dev');
    world.connect(editor);
    world.run();

    editor.mutate(setEstimate('acme-3', 3));
    world.run();
    expect(editor.rejected).toEqual([1]);
    expect(world.storage.getRow('issues', 'acme-3')?.fields['estimate']).toBeUndefined();
  });

  test('each principal converges to its own permitted slice, not a shared one', () => {
    const world = new World({ seed: 13, ruleset: MASKED });
    const owner = new RefClient('priya', 'priya-dev');
    const editor = new RefClient('maya', 'maya-dev');
    world.connect(owner);
    world.connect(editor);
    world.run();
    owner.mutate(setEstimate('acme-4', 5));
    owner.mutate(edit('acme-4', 'title', 'shared change'));
    world.run();

    expect(canonical(owner.liveRows())).toBe(canonical(world.permittedRows('priya')));
    expect(canonical(editor.liveRows())).toBe(canonical(world.permittedRows('maya')));
    expect(canonical(owner.liveRows())).not.toBe(canonical(editor.liveRows()));
    // The difference is exactly the masked field, nothing else.
    expect(valueOf(owner, 'acme-4', 'title')).toBe('shared change');
    expect(valueOf(editor, 'acme-4', 'title')).toBe('shared change');
  });
});

describe('live narrowing (E2)', () => {
  test('demotion closes the connection; the reconnect re-syncs a narrower slice', () => {
    const world = new World({ seed: 14, ruleset: MASKED });
    const owner = new RefClient('priya', 'priya-dev');
    const target = new RefClient('theo', 'theo-dev'); // seeded as viewer
    world.connect(owner);
    world.connect(target);
    world.run();

    // Promote theo to owner so he can see the masked field, then demote.
    owner.mutate({ kind: 'update', table: 'memberships', rowId: 'mem-theo-1', field: 'role', value: 'owner' });
    world.run();
    expect(target.lastError).toBe('EPOCH_CHANGED');

    world.connect(target); // forced re-hello → snapshot at the new epoch
    world.run();
    owner.mutate(setEstimate('acme-5', 21));
    world.run();
    expect(valueOf(target, 'acme-5', 'estimate')).toBe(21);

    // Demote back to viewer: connection drops, and after reconnect the
    // masked field is gone from the fresh snapshot.
    owner.mutate({ kind: 'update', table: 'memberships', rowId: 'mem-theo-1', field: 'role', value: 'viewer' });
    world.run();
    world.connect(target);
    world.run();
    expect(valueOf(target, 'acme-5', 'estimate')).toBeUndefined();
    expect(canonical(target.liveRows())).toBe(canonical(world.permittedRows('theo')));
  });
});

describe('the wiretap proves itself (E4)', () => {
  test('a planted bypass is caught at send time', () => {
    const world = new World({ seed: 15, ruleset: MASKED });
    const owner = new RefClient('priya', 'priya-dev');
    world.connect(owner);
    world.run();
    owner.mutate(setEstimate('acme-6', 34));
    world.run();

    // Plant the bypass: hand the editor a snapshot built with the OWNER's
    // permissions — precisely the leak class this project exists to prevent.
    const leaky = new World({ seed: 15, ruleset: MASKED });
    const editor = new RefClient('maya', 'maya-dev');
    leaky.connect(editor);
    leaky.run();
    const ownerRows = leaky.permittedRows('priya');
    leaky.storage.putRow({
      table: 'issues',
      rowId: 'acme-7',
      fields: { title: { v: 't', seq: 1 }, estimate: { v: 99, seq: 2 } },
    });

    expect(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (leaky as any).wiretap(
        { client: editor, connId: 'c', alive: true, toClientAt: 0, toServerAt: 0 },
        {
          t: 'snapshot',
          epoch: 0,
          atSeq: 1,
          rows: [
            ...ownerRows.slice(0, 1),
            { table: 'issues', rowId: 'acme-7', fields: { estimate: { v: 99, seq: 2 } } },
          ],
        },
      );
    }).toThrow(/invariant \(b\) violated.*estimate/s);
  });

  test('a revoked principal receiving any data frame trips the wiretap', () => {
    const world = new World({ seed: 16 });
    const owner = new RefClient('priya', 'priya-dev');
    world.connect(owner);
    world.run();
    owner.mutate({ kind: 'delete', table: 'memberships', rowId: 'mem-maya-1' });
    world.run();

    const ghost = new RefClient('maya', 'maya-ghost');
    expect(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (world as any).wiretap(
        { client: ghost, connId: 'g', alive: true, toClientAt: 0, toServerAt: 0 },
        { t: 'ops', epoch: 1, ops: [{ seq: 99, clientId: 'x', opId: 1, op: edit('acme-1', 'title', 'leak') }], advanceTo: 99 },
      );
    }).toThrow(/invariant \(b\) violated/);
  });

  test('the wiretap stays silent through an honest revoke-and-reinvite run', () => {
    const world = new World({ seed: 17, ruleset: MASKED });
    const owner = new RefClient('priya', 'priya-dev');
    const victim = new RefClient('maya', 'maya-dev');
    world.connect(owner);
    world.connect(victim);
    world.run();

    owner.mutate(setEstimate('acme-8', 55));
    victim.mutate(edit('acme-8', 'title', 'in flight'));
    owner.mutate({ kind: 'delete', table: 'memberships', rowId: 'mem-maya-1' });
    world.run(); // no throw = no leak on the revoke path

    expect(victim.forgotten).toBe(true);
    expect(victim.base.size).toBe(0);

    owner.mutate({ kind: 'create', table: 'memberships', rowId: 'mem-maya-2', fields: { userId: 'maya', role: 'editor' } });
    world.run();
    world.connect(victim);
    world.run();
    expect(valueOf(victim, 'acme-8', 'estimate')).toBeUndefined(); // still masked
    expect(canonical(victim.liveRows())).toBe(canonical(world.permittedRows('maya')));
  });
});
