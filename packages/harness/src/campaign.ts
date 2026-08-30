// The randomized interleaving campaign (backlog H1–H4): N clients on
// virtual time, seeded RNG, going offline and back, editing concurrently,
// being revoked and re-invited mid-sync, with duplicate delivery — and the
// three invariants checked throughout and at quiescence.
//
//   (a) every permitted client converges to its own permitted slice
//   (b) no client ever holds data it lacks permission for  (send-time
//       wiretap in World, plus a residue scan here)
//   (c) no acknowledged write is ever lost
//
// A failing seed reproduces exactly: same seed, same trace hash, same
// violation.
import type { Op, RowState } from '@syncline/protocol';
import { DEMO_WORKSPACES } from 'syncline-demo-schema';
import { RefClient } from './refclient.js';
import { World, canonical } from './world.js';

export interface CampaignOptions {
  seed: number;
  /** Simulated user sessions (each is one device). */
  clients?: number;
  /** Workload steps to run. */
  steps?: number;
  duplicateRate?: number;
}

export interface CampaignResult {
  seed: number;
  steps: number;
  ops: number;
  revocations: number;
  reconnects: number;
  serverSeq: number;
  traceHash: number;
}

export class InvariantViolation extends Error {
  readonly seed: number;
  readonly invariant: 'a' | 'b' | 'c';
  constructor(seed: number, invariant: 'a' | 'b' | 'c', detail: string) {
    super(`seed ${String(seed)}: invariant (${invariant}) violated — ${detail}`);
    this.name = 'InvariantViolation';
    this.seed = seed;
    this.invariant = invariant;
  }
}

const ACME = DEMO_WORKSPACES[0] as (typeof DEMO_WORKSPACES)[number];
const EDITABLE_FIELDS = ['title', 'status', 'severity'] as const;
const STATUS_VALUES = ['todo', 'in_progress', 'in_review', 'done'];

interface Sim {
  client: RefClient;
  userId: string;
  online: boolean;
  /** Membership row id of the current episode, or null while revoked. */
  memberRow: string | null;
}

export const runCampaign = (opts: CampaignOptions): CampaignResult => {
  const seed = opts.seed;
  const steps = opts.steps ?? 60;
  const world = new World({
    seed,
    ...(opts.duplicateRate !== undefined ? { duplicateRate: opts.duplicateRate } : {}),
  });
  const rng = world.stream('workload');
  const faults = world.stream('faults');

  // The owner is always connected: someone must be able to invite/revoke.
  const owner: Sim = {
    client: new RefClient('priya', 'priya-dev'),
    userId: 'priya',
    online: true,
    memberRow: 'mem-priya-1',
  };
  const others = ACME.members
    .filter((m) => m.userId !== 'priya')
    .slice(0, Math.max(1, (opts.clients ?? 3) - 1))
    .map((m, i): Sim => ({
      client: new RefClient(m.userId, `${m.userId}-dev-${String(i)}`),
      userId: m.userId,
      online: true,
      memberRow: `mem-${m.userId}-1`,
    }));
  const sims = [owner, ...others];

  for (const sim of sims) world.connect(sim.client);
  world.run();

  let ops = 0;
  let revocations = 0;
  let reconnects = 0;
  let reinviteSeq = 2;

  for (let step = 0; step < steps; step++) {
    const sim = rng.pick(sims);
    const roll = rng.next();

    // A client whose socket the server closed (revoke, epoch change) is
    // offline whatever our bookkeeping thinks.
    if (!sim.client.connected) sim.online = false;

    if (roll < 0.55) {
      // Ordinary edit. Revoked or offline clients still queue locally.
      const rowId = `acme-${String(1 + rng.int(12))}`;
      const field = rng.pick(EDITABLE_FIELDS);
      const value = field === 'status' ? rng.pick(STATUS_VALUES) : `v${String(step)}-${sim.userId}`;
      sim.client.mutate({ kind: 'update', table: 'issues', rowId, field, value } satisfies Op);
      ops += 1;
    } else if (roll < 0.7) {
      // Connectivity churn: drop the socket, later reconnect.
      if (sim.online) {
        world.kill(sim.client);
        sim.online = false;
      } else {
        world.connect(sim.client);
        sim.online = true;
        reconnects += 1;
      }
    } else if (roll < 0.8) {
      // Create a fresh issue (exercises create + masking of new rows).
      sim.client.mutate({
        kind: 'create',
        table: 'issues',
        rowId: `acme-new-${String(step)}`,
        fields: { title: `made at ${String(step)}`, status: 'todo', severity: 'medium', assignee: sim.userId },
      });
      ops += 1;
    } else if (roll < 0.9 && sims.length > 1) {
      // Revoke a non-owner mid-sync, if one is currently a member.
      const victim = others.find((s) => s.memberRow !== null);
      if (victim !== undefined && faults.chance(0.6)) {
        owner.client.mutate({ kind: 'delete', table: 'memberships', rowId: victim.memberRow as string });
        victim.memberRow = null;
        revocations += 1;
        ops += 1;
      }
    } else {
      // Re-invite someone previously revoked.
      const outsider = others.find((s) => s.memberRow === null);
      if (outsider !== undefined) {
        const rowId = `mem-${outsider.userId}-${String(reinviteSeq++)}`;
        owner.client.mutate({
          kind: 'create',
          table: 'memberships',
          rowId,
          fields: { userId: outsider.userId, role: 'editor' },
        });
        outsider.memberRow = rowId;
        ops += 1;
        // The revoke closed their socket, so a re-invited client always
        // needs a fresh connection. One socket per client, always: two
        // live sockets for one device is not a thing the protocol models.
        world.run();
        if (!outsider.client.connected) {
          world.connect(outsider.client);
          outsider.online = true;
          reconnects += 1;
        }
      }
    }
    world.run();
  }

  // Quiesce. Reconnect anyone whose socket is down, drain, and repeat
  // until nothing changes: draining can itself push ops (replayed outboxes)
  // and can close sockets (a revoke landing late), so one pass is not
  // enough. Never opens a second socket for a client that already has one.
  for (let pass = 0; pass < 6; pass++) {
    let opened = false;
    for (const sim of sims) {
      if (!sim.client.connected) {
        world.connect(sim.client);
        sim.online = true;
        opened = true;
      }
    }
    world.run();
    if (!opened && pass > 0) break;
  }

  checkInvariants(seed, world, sims);

  return {
    seed,
    steps,
    ops,
    revocations,
    reconnects,
    serverSeq: world.storage.headSeq(),
    traceHash: world.traceHash(),
  };
};

const checkInvariants = (seed: number, world: World, sims: Sim[]): void => {
  for (const sim of sims) {
    const role = world.roleOf(sim.userId);

    // (b), residue half: a revoked principal must hold nothing. (The
    // send-time half runs inside World.wiretap during the whole campaign.)
    if (role === undefined) {
      if (sim.client.base.size > 0) {
        throw new InvariantViolation(
          seed,
          'b',
          `${sim.userId} is not a member but holds ${String(sim.client.base.size)} rows`,
        );
      }
      continue;
    }

    // (a): a permitted client converges to exactly its permitted slice.
    const mine = canonical(sim.client.liveRows());
    const expected = canonical(world.permittedRows(sim.userId));
    if (mine !== expected) {
      throw new InvariantViolation(seed, 'a', `${sim.userId} diverged from its permitted slice`);
    }
  }

  // (c): every acknowledged write is reflected in the server's state —
  // either its value stands, or a higher seq superseded that field. It is
  // never simply absent. Writes acked before a revocation are exempt only
  // in the sense that the *server* keeps them; the client forgetting them
  // is the point of the feature.
  const rows = new Map<string, RowState>();
  for (const row of world.storage.scanRows()) rows.set(`${row.table}/${row.rowId}`, row);

  for (const sim of sims) {
    for (const ack of sim.client.acked) {
      const key = `${ack.op.table}/${ack.op.rowId}`;
      const row = rows.get(key);
      if (row === undefined) {
        throw new InvariantViolation(
          seed,
          'c',
          `acked op ${sim.client.clientId}#${String(ack.opId)} (seq ${String(ack.seq)}) left no row ${key}`,
        );
      }
      if (ack.op.kind === 'update') {
        const stamp = row.fields[ack.op.field];
        const superseded = stamp !== undefined && stamp.seq > ack.seq;
        const stands = stamp !== undefined && stamp.seq === ack.seq && stamp.v === ack.op.value;
        const tombstoned = row.deleted !== undefined && row.deleted.seq > ack.seq;
        if (!superseded && !stands && !tombstoned) {
          throw new InvariantViolation(
            seed,
            'c',
            `acked write ${key}.${ack.op.field} (seq ${String(ack.seq)}) is neither present nor superseded`,
          );
        }
      }
    }
  }
};
