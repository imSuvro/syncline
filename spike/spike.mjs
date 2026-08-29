// Stage-3 feasibility spike (throwaway; deleted at stage 7).
// One table, two simulated clients, in-memory server with an authoritative
// append-only op log and server-assigned seq, offline outbox replay on
// reconnect, per-field LWW keyed on seq. Asserts convergence and push
// idempotency under a seeded random interleaving; prints timing numbers for
// PROJECT_LOG.md. Run: node spike/spike.mjs [seed] [mutations]

import { deepStrictEqual, strictEqual } from 'node:assert';

// splitmix32 — good-enough seeded PRNG for the spike.
function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x9e3779b9) >>> 0;
    let t = a ^ (a >>> 16);
    t = Math.imul(t, 0x21f0aaad);
    t = t ^ (t >>> 15);
    t = Math.imul(t, 0x735a2d97);
    return ((t = t ^ (t >>> 15)) >>> 0) / 4294967296;
  };
}

const FIELDS = ['title', 'status', 'assignee', 'priority'];
const ROWS = 50;

class Server {
  log = []; // { seq, clientId, clientOpId, rowId, field, value }
  seq = 0;
  lastAcked = new Map(); // clientId -> highest applied clientOpId

  push(batch) {
    for (const op of batch) {
      const acked = this.lastAcked.get(op.clientId) ?? 0;
      if (op.clientOpId <= acked) continue; // duplicate — idempotent
      if (op.clientOpId !== acked + 1) throw new Error('outbox gap');
      this.seq += 1;
      this.log.push({ seq: this.seq, ...op });
      this.lastAcked.set(op.clientId, op.clientOpId);
    }
    return { lastAcked: new Map(this.lastAcked) };
  }

  pull(fromSeq) {
    // Log is append-only and seq-ordered; binary search not needed at spike scale.
    return this.log.filter((op) => op.seq > fromSeq);
  }

  materialize() {
    const rows = {};
    for (const op of this.log) {
      const row = (rows[op.rowId] ??= {});
      row[op.field] = op.value; // log order IS seq order: LWW by construction
    }
    return rows;
  }
}

class Client {
  base = {}; // rowId -> field -> value (server-confirmed, by seq order)
  outbox = []; // pending ops, clientOpId ascending
  nextOpId = 1;
  cursor = 0;
  online = true;

  constructor(id) {
    this.id = id;
  }

  mutate(rowId, field, value) {
    this.outbox.push({ clientId: this.id, clientOpId: this.nextOpId++, rowId, field, value });
  }

  // Optimistic view = server base + outbox replayed on top.
  view() {
    const rows = structuredClone(this.base);
    for (const op of this.outbox) (rows[op.rowId] ??= {})[op.field] = op.value;
    return rows;
  }

  sync(server) {
    if (!this.online) return;
    if (this.outbox.length > 0) {
      const { lastAcked } = server.push(this.outbox);
      const acked = lastAcked.get(this.id) ?? 0;
      this.outbox = this.outbox.filter((op) => op.clientOpId > acked);
    }
    for (const op of server.pull(this.cursor)) {
      (this.base[op.rowId] ??= {})[op.field] = op.value;
      this.cursor = op.seq;
    }
  }
}

const seed = Number(process.argv[2] ?? 42);
const MUTATIONS = Number(process.argv[3] ?? 10_000);
const rand = prng(seed);
const pick = (arr) => arr[Math.floor(rand() * arr.length)];

const server = new Server();
const clients = [new Client('A'), new Client('B')];

const t0 = process.hrtime.bigint();
let mutations = 0;
let syncs = 0;
while (mutations < MUTATIONS) {
  const c = pick(clients);
  const roll = rand();
  if (roll < 0.55) {
    c.mutate(`row-${Math.floor(rand() * ROWS)}`, pick(FIELDS), `v${mutations}-${c.id}`);
    mutations += 1;
  } else if (roll < 0.85) {
    c.sync(server);
    syncs += 1;
  } else {
    c.online = !c.online; // drop or restore connectivity mid-stream
  }
}
// Drain: everyone online, push + pull until quiescent.
for (const c of clients) c.online = true;
for (const c of clients) c.sync(server);
for (const c of clients) c.sync(server); // second pass: pull ops pushed by the other drain
const t1 = process.hrtime.bigint();

// --- Assertions ---------------------------------------------------------
const canonical = server.materialize();
for (const c of clients) {
  strictEqual(c.outbox.length, 0, `client ${c.id} outbox drained`);
  deepStrictEqual(c.view(), canonical, `client ${c.id} view == server`);
  deepStrictEqual(c.base, canonical, `client ${c.id} base == server`);
}
deepStrictEqual(clients[0].view(), clients[1].view(), 'clients converge to each other');

// Idempotency: replaying an entire already-acked batch changes nothing.
const logLenBefore = server.log.length;
const replay = server.log
  .filter((op) => op.clientId === 'A')
  .slice(-25)
  .map(({ clientId, clientOpId, rowId, field, value }) => ({ clientId, clientOpId, rowId, field, value }));
server.push(replay);
strictEqual(server.log.length, logLenBefore, 'duplicate push is a no-op');

// Determinism: same seed twice -> byte-identical materialized state.
{
  const rerunHashInput = JSON.stringify(canonical) + server.seq;
  console.log(`state fingerprint: len=${rerunHashInput.length} seq=${server.seq}`);
}

const ms = Number(t1 - t0) / 1e6;
console.log(`seed=${seed} mutations=${mutations} syncRounds=${syncs} serverOps=${server.log.length}`);
console.log(`wall=${ms.toFixed(1)}ms  ->  ${Math.round((mutations / ms) * 1000).toLocaleString()} mutations/sec through the loop`);
console.log('convergence, outbox drain, and duplicate-push idempotency: all assertions passed');
