// Stage-9 integration tests (backlog C2/C5/C7 DoD): the sync server driven
// end-to-end through the fake transport on virtual time.
import { describe, expect, test } from 'vitest';
import type { Op } from '@syncline/protocol';
import { RefClient, World, canonical } from 'syncline-harness';

const edit = (rowId: string, field: string, value: string): Op => ({
  kind: 'update',
  table: 'issues',
  rowId,
  field,
  value,
});

describe('reconnect + backfill (C5)', () => {
  test('a killed client resumes by cursor and converges exactly once', () => {
    const world = new World({ seed: 1 });
    const maya = new RefClient('maya', 'maya-dev');
    const priya = new RefClient('priya', 'priya-dev');
    world.connect(maya);
    world.connect(priya);
    world.run();
    expect(canonical(maya.liveRows())).toBe(canonical(world.permittedRows('maya')));

    world.kill(maya);
    priya.mutate(edit('acme-1', 'status', 'done'));
    priya.mutate(edit('acme-2', 'title', 'renamed while maya was gone'));
    world.run();

    const cursorBefore = maya.cursor;
    world.connect(maya); // re-hello with the stale cursor → incremental
    world.run();
    expect(maya.cursor?.seq).toBeGreaterThan(cursorBefore?.seq ?? 0);
    expect(canonical(maya.liveRows())).toBe(canonical(world.permittedRows('maya')));
    expect(canonical(maya.liveRows())).toBe(canonical(priya.liveRows()));
  });

  test('a push whose ack was lost re-sends as duplicates, server unchanged', () => {
    const world = new World({ seed: 2 });
    const maya = new RefClient('maya', 'maya-dev');
    world.connect(maya);
    world.run();

    maya.mutate(edit('acme-3', 'severity', 'high'));
    world.run();
    const headAfterFirst = world.storage.headSeq();
    // Simulate ack loss: put the op back in the outbox and re-push.
    maya.outbox = [{ opId: 1, baseSchemaVersion: 1, op: edit('acme-3', 'severity', 'high') }];
    maya.flush();
    world.run();
    expect(world.storage.headSeq()).toBe(headAfterFirst);
    expect(maya.outbox).toHaveLength(0); // retired via duplicate ack
    expect(canonical(maya.liveRows())).toBe(canonical(world.permittedRows('maya')));
  });
});

describe('incremental ≡ snapshot (C2 DoD, ADR-002 guarantee)', () => {
  test('catch-up from any cursor equals a fresh snapshot at the same head', () => {
    const world = new World({ seed: 3 });
    const early = new RefClient('maya', 'maya-early');
    world.connect(early);
    world.run();

    const editor = new RefClient('priya', 'priya-dev');
    world.connect(editor);
    world.run();
    for (let i = 1; i <= 8; i++) {
      editor.mutate(edit(`acme-${String(i)}`, 'status', `s${String(i)}`));
    }
    editor.mutate({ kind: 'create', table: 'issues', rowId: 'acme-new', fields: { title: 'fresh', status: 'todo', priority: 'low', assignee: null } });
    editor.mutate({ kind: 'delete', table: 'issues', rowId: 'acme-4' });
    world.run();

    const fresh = new RefClient('maya', 'maya-fresh'); // no cursor → snapshot
    world.connect(fresh);
    world.run();

    expect(canonical(early.liveRows())).toBe(canonical(fresh.liveRows()));
    expect(early.cursor?.seq).toBe(fresh.cursor?.seq);
  });
});

describe('revocation over the wire (ADR-004 end-to-end)', () => {
  test('revoke mid-session: forget arrives, store and outbox purge, re-invite bootstraps fresh', () => {
    const world = new World({ seed: 4 });
    const owner = new RefClient('priya', 'priya-dev');
    const victim = new RefClient('maya', 'maya-dev');
    world.connect(owner);
    world.connect(victim);
    world.run();

    victim.mutate(edit('acme-5', 'title', 'pending edit'));
    owner.mutate({ kind: 'delete', table: 'memberships', rowId: 'mem-maya-1' });
    world.run();

    expect(victim.forgotten).toBe(true);
    expect(victim.base.size).toBe(0);
    expect(victim.outbox).toHaveLength(0);
    expect(world.permittedRows('maya')).toHaveLength(0);

    // Re-invite: fresh episode row, victim reconnects into snapshot mode.
    owner.mutate({ kind: 'create', table: 'memberships', rowId: 'mem-maya-2', fields: { userId: 'maya', role: 'editor' } });
    world.run();
    world.connect(victim);
    world.run();
    expect(victim.forgotten).toBe(true);
    expect(canonical(victim.liveRows())).toBe(canonical(world.permittedRows('maya')));
    expect(victim.liveRows().length).toBeGreaterThan(0);
  });

  test('join mid-history: a new member sees the full permitted slice via snapshot', () => {
    const world = new World({ seed: 5 });
    const owner = new RefClient('priya', 'priya-dev');
    world.connect(owner);
    world.run();
    owner.mutate(edit('acme-6', 'status', 'done'));
    owner.mutate({ kind: 'create', table: 'memberships', rowId: 'mem-sam-1', fields: { userId: 'sam', role: 'viewer' } });
    world.run();

    const sam = new RefClient('sam', 'sam-dev');
    world.connect(sam);
    world.run();
    expect(canonical(sam.liveRows())).toBe(canonical(world.permittedRows('sam')));
    expect(sam.liveRows().length).toBeGreaterThan(0);
  });
});

describe('determinism (C7 DoD)', () => {
  const scenario = (seed: number): number => {
    const world = new World({ seed });
    const a = new RefClient('maya', 'a');
    const b = new RefClient('priya', 'b');
    world.connect(a);
    world.connect(b);
    world.run();
    const rng = world.stream('workload');
    for (let i = 0; i < 30; i++) {
      const who = rng.chance(0.5) ? a : b;
      who.mutate(edit(`acme-${String(1 + rng.int(10))}`, rng.pick(['status', 'title', 'severity']), `v${String(i)}`));
      if (rng.chance(0.2)) {
        world.kill(who);
        world.run();
        world.connect(who);
      }
      world.run();
    }
    world.run();
    expect(canonical(a.liveRows())).toBe(canonical(b.liveRows()));
    return world.traceHash();
  };

  test('same seed → byte-identical trace hash; different seed → different trace', () => {
    const h1 = scenario(42);
    const h2 = scenario(42);
    const h3 = scenario(43);
    expect(h1).toBe(h2);
    expect(h1).not.toBe(h3);
  });
});
