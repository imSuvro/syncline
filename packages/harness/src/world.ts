// The in-process world (backlog C7): one WorkspaceCore + N reference
// clients wired through a fake transport on virtual time, with a structured
// trace for double-run determinism checks. Fault knobs grow in stage 14
// (H1); v1 covers latency, connection kill, and reconnect.
import {
  decodeClientFrame,
  decodeServerFrame,
  encodeFrame,
  type ClientFrame,
  type RowState,
} from '@syncline/protocol';
import { evaluate, rowValues, type Principal, type Ruleset, type ServerFrame } from '@syncline/protocol';
import {
  createMemoryStorage,
  createWorkspace,
  permitRowFor,
  workspaceStep,
  type ServerEffect,
  type ServerInput,
  type ServerStorage,
  type WorkspaceConfig,
  type WorkspaceState,
} from '@syncline/server';
import {
  DEMO_RULESET,
  DEMO_SCHEMA_VERSION,
  MIN_WRITABLE_VERSION,
  SEED_CLIENT_ID,
  seedOps,
} from 'syncline-demo-schema';
import { createRoot, fnv1a, type Rng } from './prng.js';
import { VirtualClock } from './vtime.js';
import { RefClient } from './refclient.js';

export interface WorldOptions {
  seed: number;
  workspaceId?: string;
  /** Mean one-way latency in virtual ms (uniform 1..2*mean). */
  latencyMs?: number;
  seeded?: boolean;
  /** Override the demo ruleset (field-masking scenarios). */
  ruleset?: Ruleset;
}

interface Link {
  client: RefClient;
  connId: string;
  alive: boolean;
  /** FIFO watermarks: WebSocket delivery is ordered per direction within a
   * connection — random per-frame delays must never reorder frames. */
  toClientAt: number;
  toServerAt: number;
}

export class World {
  readonly clock = new VirtualClock();
  readonly storage: ServerStorage;
  readonly config: WorkspaceConfig;
  readonly serverState: WorkspaceState;
  private readonly root: ReturnType<typeof createRoot>;
  private readonly netRng: Rng;
  private readonly latencyMs: number;
  private readonly links = new Map<string, Link>();
  private readonly trace: string[] = [];
  private connSeq = 0;

  constructor(opts: WorldOptions) {
    this.root = createRoot(opts.seed);
    this.netRng = this.root.stream('network');
    this.latencyMs = opts.latencyMs ?? 5;
    this.storage = createMemoryStorage();
    this.serverState = createWorkspace();
    const workspaceId = opts.workspaceId ?? 'acme';
    this.config = {
      workspaceId,
      schemaVersion: DEMO_SCHEMA_VERSION,
      minWritableVersion: MIN_WRITABLE_VERSION,
      ruleset: opts.ruleset ?? DEMO_RULESET,
      migrateOp: (op) => op,
    };
    if (opts.seeded !== false) {
      this.serverInput({ type: 'seed', clientId: SEED_CLIENT_ID, ops: seedOps(workspaceId), now: 0 });
    }
  }

  /** A derived per-concern stream (workload, faults, …) — stable per seed. */
  stream(label: string): Rng {
    return this.root.stream(label);
  }

  private record(kind: string, detail: string): void {
    this.trace.push(`${String(this.clock.now)} ${kind} ${detail}`);
  }

  traceHash(): number {
    return fnv1a(this.trace);
  }

  private delay(): number {
    return 1 + this.netRng.int(this.latencyMs * 2);
  }

  private serverInput(input: ServerInput): void {
    const effects = this.storage.tx(() =>
      workspaceStep(this.serverState, this.config, this.storage, input),
    );
    this.record('input', input.type);
    for (const effect of effects) this.executeEffect(effect);
  }

  private executeEffect(effect: ServerEffect): void {
    if (effect.type === 'setAttachment') return;
    const link = this.links.get(effect.connId);
    if (link === undefined) return;
    if (effect.type === 'send') {
      this.wiretap(link, effect.frame);
      // Encode/decode round-trip: the wire format is exercised on every hop.
      const text = encodeFrame(effect.frame);
      this.record('s->c', `${link.client.clientId} ${effect.frame.t}`);
      link.toClientAt = Math.max(link.toClientAt, this.clock.now + this.delay());
      this.clock.schedule(link.toClientAt - this.clock.now, () => {
        if (!link.alive) return;
        const frame = decodeServerFrame(text);
        if (frame === null) throw new Error('server sent malformed frame');
        link.client.onFrame(frame);
      });
    } else {
      this.record('close', `${link.client.clientId}`);
      link.toClientAt = Math.max(link.toClientAt, this.clock.now + this.delay());
      this.clock.schedule(link.toClientAt - this.clock.now, () => {
        if (!link.alive) return;
        this.severLink(link, false);
      });
    }
  }

  /**
   * Invariant (b), checked at send time on every outbound frame: no data
   * may leave for a principal the ruleset does not permit it to. This is a
   * deliberately independent re-derivation — it re-reads the live
   * membership and re-runs `evaluate` itself rather than trusting the
   * server's own filtering, so a bypass inside the sync path is caught here
   * even when the server believes it did the right thing.
   *
   * Violations throw rather than accumulate: a leak is never a statistic.
   */
  private wiretap(link: Link, frame: ServerFrame): void {
    if (frame.t !== 'ops' && frame.t !== 'snapshot') return;
    const userId = link.client.userId;
    const role = this.roleOf(userId);
    const fail = (what: string): never => {
      throw new Error(
        `invariant (b) violated at t=${String(this.clock.now)}: ${what} sent to ${userId}` +
          ` (role=${String(role)})`,
      );
    };
    // A principal with no live membership must receive no data at all.
    if (role === undefined) fail(`${frame.t} frame`);
    const principal: Principal = { userId, role: role as NonNullable<typeof role> };

    const check = (table: string, rowId: string, values: Record<string, unknown>, fields: string[]): void => {
      const vis = evaluate(this.config.ruleset, principal, table, values as never);
      if (!vis.read) fail(`row ${table}/${rowId}`);
      if (vis.fieldMask === undefined) return;
      const allowed = new Set(vis.fieldMask);
      for (const field of fields) {
        if (!allowed.has(field)) fail(`field ${table}/${rowId}.${field}`);
      }
    };

    if (frame.t === 'snapshot') {
      for (const row of frame.rows) {
        check(row.table, row.rowId, rowValues(row), Object.keys(row.fields));
      }
      return;
    }
    for (const entry of frame.ops) {
      const op = entry.op;
      // Judge against the row as it stands on the server, which is the
      // state the recipient would reconstruct from this op.
      const current = this.storage.getRow(op.table, op.rowId);
      const values = current === undefined ? {} : rowValues(current);
      const fields =
        op.kind === 'update' ? [op.field] : op.kind === 'create' ? Object.keys(op.fields) : [];
      check(op.table, op.rowId, values, fields);
    }
  }

  /** Open a connection for a client; hello flows immediately. */
  connect(client: RefClient): void {
    const connId = `conn-${String(this.connSeq++)}`;
    const link: Link = { client, connId, alive: true, toClientAt: 0, toServerAt: 0 };
    this.links.set(connId, link);
    client.attach({
      send: (frame: ClientFrame) => {
        if (!link.alive) return;
        const text = encodeFrame(frame);
        this.record('c->s', `${client.clientId} ${frame.t}`);
        link.toServerAt = Math.max(link.toServerAt, this.clock.now + this.delay());
        this.clock.schedule(link.toServerAt - this.clock.now, () => {
          if (!link.alive) return;
          const decoded = decodeClientFrame(text);
          if (decoded === null) throw new Error('client sent malformed frame');
          if (decoded.t === 'hello') {
            this.serverInput({
              type: 'hello',
              connId,
              userId: decoded.token, // world edge: token IS the userId
              clientId: decoded.clientId,
              schemaVersion: decoded.schemaVersion,
              ...(decoded.cursor !== undefined ? { cursor: decoded.cursor } : {}),
              now: this.clock.now,
            });
          } else {
            this.serverInput({ type: 'frame', connId, frame: decoded, now: this.clock.now });
          }
        });
      },
    });
  }

  /** Kill a client's connection abruptly (both directions die now). */
  kill(client: RefClient): void {
    for (const link of this.links.values()) {
      if (link.client === client && link.alive) this.severLink(link, true);
    }
  }

  private severLink(link: Link, notifyServer: boolean): void {
    link.alive = false;
    this.links.delete(link.connId);
    link.client.detach();
    this.record('sever', link.client.clientId);
    if (notifyServer) {
      this.clock.schedule(this.delay(), () => {
        this.serverInput({ type: 'disconnect', connId: link.connId, now: this.clock.now });
      });
    }
  }

  run(): number {
    return this.clock.runUntilQuiescent();
  }

  /** The server's permitted view for a principal — the convergence oracle
   * (invariant a): what a fully caught-up client of that user must hold. */
  permittedRows(userId: string): RowState[] {
    const role = this.roleOf(userId);
    if (role === undefined) return [];
    const out: RowState[] = [];
    for (const row of this.storage.scanRows()) {
      const permitted = permitRowFor(this.config.ruleset, { userId, role }, row);
      if (permitted !== null) out.push(permitted);
    }
    return out;
  }

  roleOf(userId: string): 'owner' | 'editor' | 'viewer' | undefined {
    for (const row of this.storage.scanRows()) {
      if (row.table !== 'memberships' || row.deleted !== undefined) continue;
      if (row.fields['userId']?.v !== userId) continue;
      const role = row.fields['role']?.v;
      return role === 'owner' || role === 'editor' || role === 'viewer' ? role : undefined;
    }
    return undefined;
  }
}

const sortRows = (rows: RowState[]): RowState[] =>
  [...rows].sort((a, b) => `${a.table}/${a.rowId}`.localeCompare(`${b.table}/${b.rowId}`));

/** Canonical serialization for byte-equal convergence comparison. */
export const canonical = (rows: RowState[]): string =>
  JSON.stringify(
    sortRows(rows).map((r) => ({
      table: r.table,
      rowId: r.rowId,
      fields: Object.fromEntries(Object.entries(r.fields).sort(([a], [b]) => a.localeCompare(b))),
    })),
  );
