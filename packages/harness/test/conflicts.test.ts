// Stage-12 tests (Epic F): per-field LWW under real interleavings, and the
// mandated migration scenario — a stale client with pending offline writes
// upgrades and replays with zero acknowledged-write loss.
import { describe, expect, test } from 'vitest';
import type { Op } from '@syncline/protocol';
import { RefClient, World, canonical } from 'syncline-harness';
import { DEMO_SCHEMA_VERSION, migrateOp, migrateRows } from 'syncline-demo-schema';

const edit = (rowId: string, field: string, value: string): Op => ({
  kind: 'update',
  table: 'issues',
  rowId,
  field,
  value,
});

const valueOf = (client: RefClient, rowId: string, field: string): unknown =>
  client.base.get(`issues/${rowId}`)?.fields[field]?.v;

describe('per-field LWW (F1, ADR-005)', () => {
  test('concurrent edits to different fields both survive', () => {
    const world = new World({ seed: 20 });
    const a = new RefClient('priya', 'a');
    const b = new RefClient('maya', 'b');
    world.connect(a);
    world.connect(b);
    world.run();

    // Both write the same row, different fields, before either syncs.
    a.mutate(edit('acme-1', 'title', 'from A'));
    b.mutate(edit('acme-1', 'status', 'done'));
    world.run();

    expect(valueOf(a, 'acme-1', 'title')).toBe('from A');
    expect(valueOf(a, 'acme-1', 'status')).toBe('done');
    expect(canonical(a.liveRows())).toBe(canonical(b.liveRows()));
  });

  test('same-field race resolves by server order, identically on both clients', () => {
    const world = new World({ seed: 21 });
    const a = new RefClient('priya', 'a');
    const b = new RefClient('maya', 'b');
    world.connect(a);
    world.connect(b);
    world.run();

    a.mutate(edit('acme-2', 'title', 'A wins or loses'));
    b.mutate(edit('acme-2', 'title', 'B wins or loses'));
    world.run();

    const winner = world.storage.getRow('issues', 'acme-2')?.fields['title']?.v;
    expect(valueOf(a, 'acme-2', 'title')).toBe(winner);
    expect(valueOf(b, 'acme-2', 'title')).toBe(winner);
    expect(canonical(a.liveRows())).toBe(canonical(b.liveRows()));
  });

  test('an offline client\'s stale edit still lands, ordered after the writes it missed', () => {
    const world = new World({ seed: 22 });
    const online = new RefClient('priya', 'online');
    const offline = new RefClient('maya', 'offline');
    world.connect(online);
    world.connect(offline);
    world.run();

    world.kill(offline);
    online.mutate(edit('acme-3', 'title', 'changed while you were out'));
    world.run();

    offline.mutate(edit('acme-3', 'title', 'my offline edit'));
    world.connect(offline);
    world.run();

    // The reconnecting write is ordered last, so it wins — and both agree.
    expect(valueOf(online, 'acme-3', 'title')).toBe('my offline edit');
    expect(canonical(online.liveRows())).toBe(canonical(offline.liveRows()));
  });

  test('convergence holds across a randomized interleaving with drops', () => {
    for (const seed of [30, 31, 32, 33, 34]) {
      const world = new World({ seed });
      const a = new RefClient('priya', 'a');
      const b = new RefClient('maya', 'b');
      world.connect(a);
      world.connect(b);
      world.run();

      const rng = world.stream('workload');
      for (let i = 0; i < 40; i++) {
        const who = rng.chance(0.5) ? a : b;
        who.mutate(
          edit(`acme-${String(1 + rng.int(8))}`, rng.pick(['title', 'status', 'severity']), `v${String(i)}`),
        );
        if (rng.chance(0.15)) {
          world.kill(who);
          world.run();
          world.connect(who);
        }
        world.run();
      }
      world.run();

      expect(canonical(a.liveRows())).toBe(canonical(world.permittedRows('priya')));
      expect(canonical(b.liveRows())).toBe(canonical(world.permittedRows('maya')));
      expect(canonical(a.liveRows())).toBe(canonical(b.liveRows()));
    }
  });
});

describe('schema negotiation (F3, ADR-006)', () => {
  test('a v1 client\'s ops are migrated on arrival, not rejected', () => {
    const world = new World({ seed: 40 });
    const legacy = new RefClient('maya', 'legacy', 1);
    world.connect(legacy);
    world.run();
    expect(legacy.serverSchemaVersion).toBe(DEMO_SCHEMA_VERSION);

    legacy.mutate(edit('acme-1', 'priority', 'med')); // v1 field name + value
    world.run();

    expect(legacy.rejected).toEqual([]);
    const row = world.storage.getRow('issues', 'acme-1');
    expect(row?.fields['severity']?.v).toBe('medium'); // renamed AND normalized
    expect(row?.fields['priority']).toBeUndefined();
  });

  test('an op below minWritableVersion is rejected per-op, never as a bare error', () => {
    const world = new World({ seed: 41 });
    const ancient = new RefClient('maya', 'ancient', 1);
    world.connect(ancient);
    world.run();
    ancient.outbox.push({ opId: 1, baseSchemaVersion: 0, op: edit('acme-1', 'title', 'too old') });
    ancient.flush();
    world.run();

    expect(ancient.rejected).toEqual([1]);
    expect(ancient.lastError).toBeUndefined(); // no fatal error frame
  });

  test('a client newer than the server is a fatal handshake error', () => {
    const world = new World({ seed: 42 });
    const future = new RefClient('maya', 'future', DEMO_SCHEMA_VERSION + 1);
    world.connect(future);
    world.run();
    expect(future.lastError).toBe('VERSION_TOO_NEW');
  });

  // --- THE MANDATED TEST ---------------------------------------------------
  test('a stale client with pending writes upgrades and replays with zero loss', () => {
    const world = new World({ seed: 43 });
    const legacy = new RefClient('maya', 'legacy-dev', 1);
    const witness = new RefClient('priya', 'witness');
    world.connect(legacy);
    world.connect(witness);
    world.run();

    // Go offline, then make several v1-shaped edits that never reach the
    // server — including one to the field that v2 renames.
    world.kill(legacy);
    legacy.mutate(edit('acme-1', 'priority', 'high'));
    legacy.mutate(edit('acme-1', 'title', 'offline title'));
    legacy.mutate(edit('acme-2', 'priority', 'med'));
    legacy.mutate({ kind: 'create', table: 'issues', rowId: 'acme-offline', fields: { title: 'made offline', status: 'todo', priority: 'low', assignee: null } });
    const pendingIds = legacy.outbox.map((p) => p.opId);
    expect(pendingIds).toEqual([1, 2, 3, 4]);

    // Meanwhile the world moves on at v2.
    witness.mutate(edit('acme-1', 'status', 'in_review'));
    world.run();

    // The app updates: migrate local data AND the queued ops, then resume.
    legacy.upgrade(DEMO_SCHEMA_VERSION, migrateRows, migrateOp);
    expect(legacy.outbox.map((p) => p.opId)).toEqual(pendingIds); // identities intact
    expect(legacy.outbox).toHaveLength(4); // nothing dropped by migration

    world.connect(legacy);
    world.run();

    // Every queued write landed, in migrated form, and nothing was rejected.
    expect(legacy.rejected).toEqual([]);
    expect(legacy.outbox).toHaveLength(0);
    expect(world.storage.getRow('issues', 'acme-1')?.fields['severity']?.v).toBe('high');
    expect(world.storage.getRow('issues', 'acme-1')?.fields['title']?.v).toBe('offline title');
    expect(world.storage.getRow('issues', 'acme-2')?.fields['severity']?.v).toBe('medium');
    const created = world.storage.getRow('issues', 'acme-offline');
    expect(created?.fields['title']?.v).toBe('made offline');
    expect(created?.fields['severity']?.v).toBe('low');
    expect(created?.fields['priority']).toBeUndefined();

    // The witness's concurrent write survived too — different field, no loss.
    expect(world.storage.getRow('issues', 'acme-1')?.fields['status']?.v).toBe('in_review');

    // And everyone converges.
    expect(canonical(legacy.liveRows())).toBe(canonical(world.permittedRows('maya')));
    expect(canonical(witness.liveRows())).toBe(canonical(world.permittedRows('priya')));
  });

  test('migrating twice is harmless: replayed ops dedup against server marks', () => {
    const world = new World({ seed: 44 });
    const legacy = new RefClient('maya', 'legacy-dev', 1);
    world.connect(legacy);
    world.run();
    world.kill(legacy);
    legacy.mutate(edit('acme-5', 'priority', 'high'));

    legacy.upgrade(DEMO_SCHEMA_VERSION, migrateRows, migrateOp);
    world.connect(legacy);
    world.run();
    const head = world.storage.headSeq();

    // A crash-and-retry after the ack: same identity, already applied.
    legacy.outbox = [{ opId: 1, baseSchemaVersion: DEMO_SCHEMA_VERSION, op: edit('acme-5', 'severity', 'high') }];
    legacy.flush();
    world.run();
    expect(world.storage.headSeq()).toBe(head);
    expect(legacy.outbox).toHaveLength(0);
  });
});
