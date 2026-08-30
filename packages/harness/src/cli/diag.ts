// Divergence diagnostic: replay one seed and print exactly which rows and
// fields differ between a client's view and its permitted slice. Used to
// triage a failing fuzz seed; kept because triage recurs.
import process from 'node:process';
import type { RowState } from '@syncline/protocol';
import { DEMO_WORKSPACES } from 'syncline-demo-schema';
import { RefClient } from '../refclient.js';
import { World, canonical } from '../world.js';

const seed = Number(process.argv[2] ?? 66);
const steps = Number(process.argv[3] ?? 60);

// Mirror of runCampaign's workload, instrumented.
const ACME = DEMO_WORKSPACES[0] as (typeof DEMO_WORKSPACES)[number];
const EDITABLE = ['title', 'status', 'severity'] as const;
const STATUSES = ['todo', 'in_progress', 'in_review', 'done'];

const world = new World({ seed, duplicateRate: 0.05 });
const rng = world.stream('workload');
const faults = world.stream('faults');

interface Sim { client: RefClient; userId: string; online: boolean; memberRow: string | null }
const owner: Sim = { client: new RefClient('priya', 'priya-dev'), userId: 'priya', online: true, memberRow: 'mem-priya-1' };
const others = ACME.members.filter((m) => m.userId !== 'priya').slice(0, 2).map((m, i): Sim => ({
  client: new RefClient(m.userId, `${m.userId}-dev-${String(i)}`), userId: m.userId, online: true, memberRow: `mem-${m.userId}-1`,
}));
const sims = [owner, ...others];
for (const s of sims) world.connect(s.client);
world.run();

const log: string[] = [];
let reinviteSeq = 2;
for (let step = 0; step < steps; step++) {
  const sim = rng.pick(sims);
  const roll = rng.next();
  if (roll < 0.55) {
    const rowId = `acme-${String(1 + rng.int(12))}`;
    const field = rng.pick(EDITABLE);
    const value = field === 'status' ? rng.pick(STATUSES) : `v${String(step)}-${sim.userId}`;
    sim.client.mutate({ kind: 'update', table: 'issues', rowId, field, value });
    log.push(`${String(step)} edit ${sim.userId} ${rowId}.${field}`);
  } else if (roll < 0.7) {
    if (sim.online) { world.kill(sim.client); sim.online = false; log.push(`${String(step)} kill ${sim.userId}`); }
    else { world.connect(sim.client); sim.online = true; log.push(`${String(step)} reconnect ${sim.userId}`); }
  } else if (roll < 0.8) {
    sim.client.mutate({ kind: 'create', table: 'issues', rowId: `acme-new-${String(step)}`, fields: { title: `made at ${String(step)}`, status: 'todo', severity: 'medium', assignee: sim.userId } });
    log.push(`${String(step)} create ${sim.userId}`);
  } else if (roll < 0.9 && sims.length > 1) {
    const victim = others.find((s) => s.memberRow !== null);
    if (victim !== undefined && faults.chance(0.6)) {
      owner.client.mutate({ kind: 'delete', table: 'memberships', rowId: victim.memberRow as string });
      log.push(`${String(step)} REVOKE ${victim.userId} (online=${String(victim.online)})`);
      victim.memberRow = null;
    }
  } else {
    const outsider = others.find((s) => s.memberRow === null);
    if (outsider !== undefined) {
      const rowId = `mem-${outsider.userId}-${String(reinviteSeq++)}`;
      owner.client.mutate({ kind: 'create', table: 'memberships', rowId, fields: { userId: outsider.userId, role: 'editor' } });
      outsider.memberRow = rowId;
      log.push(`${String(step)} REINVITE ${outsider.userId} (online=${String(outsider.online)})`);
      world.connect(outsider.client);
      outsider.online = true;
    }
  }
  world.run();
}
for (const s of sims) { if (!s.online) { world.connect(s.client); s.online = true; } }
world.run();
for (const s of sims) world.connect(s.client);
world.run();

console.log(log.slice(-25).join('\n'));
for (const sim of sims) {
  const role = world.roleOf(sim.userId);
  if (role === undefined) { console.log(`\n${sim.userId}: not a member; holds ${String(sim.client.base.size)} rows`); continue; }
  const mine = canonical(sim.client.liveRows());
  const want = canonical(world.permittedRows(sim.userId));
  if (mine === want) { console.log(`\n${sim.userId}: converged (${String(sim.client.liveRows().length)} rows)`); continue; }
  console.log(`\n${sim.userId}: DIVERGED  cursor=${JSON.stringify(sim.client.cursor)} head=${String(world.storage.headSeq())}`);
  const byKey = (rows: RowState[]) => new Map(rows.map((r) => [`${r.table}/${r.rowId}`, r]));
  const a = byKey(sim.client.liveRows());
  const b = byKey(world.permittedRows(sim.userId));
  for (const key of new Set([...a.keys(), ...b.keys()])) {
    const mineRow = a.get(key); const wantRow = b.get(key);
    if (mineRow === undefined) { console.log(`  MISSING ${key} ${JSON.stringify(wantRow?.fields)}`); continue; }
    if (wantRow === undefined) { console.log(`  EXTRA   ${key}`); continue; }
    for (const f of new Set([...Object.keys(mineRow.fields), ...Object.keys(wantRow.fields)])) {
      const m = mineRow.fields[f]; const w = wantRow.fields[f];
      if (JSON.stringify(m) !== JSON.stringify(w)) console.log(`  FIELD   ${key}.${f} mine=${JSON.stringify(m)} want=${JSON.stringify(w)}`);
    }
  }
}
