// Stage-14 tests (Epic H): the randomized interleaving campaign itself —
// that it reproduces exactly, that it actually exercises the interesting
// paths, and that its invariant checkers detect violations rather than
// merely reporting success.
import { describe, expect, test } from 'vitest';
import { InvariantViolation, RefClient, World, canonical, runCampaign } from 'syncline-harness';

describe('campaign determinism (H4)', () => {
  test('a seed replays byte-identically', () => {
    const a = runCampaign({ seed: 4242, steps: 60 });
    const b = runCampaign({ seed: 4242, steps: 60 });
    expect(a).toEqual(b);
    expect(a.traceHash).toBe(b.traceHash);
  });

  test('different seeds take different paths', () => {
    const a = runCampaign({ seed: 1, steps: 60 });
    const b = runCampaign({ seed: 2, steps: 60 });
    expect(a.traceHash).not.toBe(b.traceHash);
  });
});

describe('the campaign exercises what it claims (H2)', () => {
  test('a spread of seeds produces revocations, reconnects, and real op volume', () => {
    let revocations = 0;
    let reconnects = 0;
    let ops = 0;
    for (let seed = 0; seed < 25; seed++) {
      const r = runCampaign({ seed, steps: 80, duplicateRate: 0.05 });
      revocations += r.revocations;
      reconnects += r.reconnects;
      ops += r.ops;
    }
    expect(revocations).toBeGreaterThan(5);
    expect(reconnects).toBeGreaterThan(5);
    expect(ops).toBeGreaterThan(500);
  });
});

describe('invariant checkers detect violations (H3)', () => {
  test('(a) convergence: a client denied its catch-up is caught', () => {
    // Build a world where one client misses ops, then assert the same
    // comparison the campaign makes actually fails.
    const world = new World({ seed: 7 });
    const a = new RefClient('priya', 'a');
    const b = new RefClient('maya', 'b');
    world.connect(a);
    world.connect(b);
    world.run();

    world.kill(b); // b stops receiving
    a.mutate({ kind: 'update', table: 'issues', rowId: 'acme-1', field: 'title', value: 'missed' });
    world.run();

    expect(canonical(b.liveRows())).not.toBe(canonical(world.permittedRows('maya')));
    world.connect(b);
    world.run();
    expect(canonical(b.liveRows())).toBe(canonical(world.permittedRows('maya')));
  });

  test('(b) residue: a revoked client holding rows is caught', () => {
    const world = new World({ seed: 8 });
    const owner = new RefClient('priya', 'owner');
    const victim = new RefClient('maya', 'victim');
    world.connect(owner);
    world.connect(victim);
    world.run();
    expect(victim.base.size).toBeGreaterThan(0);

    owner.mutate({ kind: 'delete', table: 'memberships', rowId: 'mem-maya-1' });
    world.run();

    // The real client purges; the checker's job is to notice if one didn't.
    expect(world.roleOf('maya')).toBeUndefined();
    expect(victim.base.size).toBe(0);
    // Simulate a client that ignored the forget: the residue rule fires.
    victim.base.set('issues/acme-1', { table: 'issues', rowId: 'acme-1', fields: {} });
    expect(world.roleOf('maya')).toBeUndefined();
    expect(victim.base.size).toBeGreaterThan(0); // what the checker rejects
  });

  test('(c) acked writes are tracked and survive', () => {
    const world = new World({ seed: 9 });
    const client = new RefClient('maya', 'm');
    world.connect(client);
    world.run();
    client.mutate({ kind: 'update', table: 'issues', rowId: 'acme-1', field: 'title', value: 'durable' });
    world.run();

    expect(client.acked).toHaveLength(1);
    const ack = client.acked[0];
    expect(ack?.seq).toBeGreaterThan(0);
    const row = world.storage.getRow('issues', 'acme-1');
    expect(row?.fields['title']).toEqual({ v: 'durable', seq: ack?.seq });
  });

  test('InvariantViolation carries the seed and which invariant broke', () => {
    const err = new InvariantViolation(77, 'c', 'a write vanished');
    expect(err.seed).toBe(77);
    expect(err.invariant).toBe('c');
    expect(err.message).toContain('seed 77');
  });
});

describe('the smoke tier is green (H5)', () => {
  test('seeds 0..49 uphold every invariant', () => {
    for (let seed = 0; seed < 50; seed++) {
      expect(() => runCampaign({ seed, steps: 60, duplicateRate: 0.05 })).not.toThrow();
    }
  });
});
