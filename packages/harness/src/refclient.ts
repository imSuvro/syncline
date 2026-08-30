// A minimal reference client: just enough protocol to test the server from
// the outside (stage 9). The real engine (@syncline/client, stage 10)
// replaces it in the full campaign; this one stays as the protocol's
// second, independent implementation — useful against docs/protocol.md too.
import {
  applyEntry,
  type ClientFrame,
  type Cursor,
  type Op,
  type PushedOp,
  type RowState,
  type ServerFrame,
} from '@syncline/protocol';

export interface RefClientIo {
  send(frame: ClientFrame): void;
}

export class RefClient {
  readonly clientId: string;
  readonly userId: string;
  base = new Map<string, RowState>();
  cursor: Cursor | undefined;
  outbox: PushedOp[] = [];
  private nextOpId = 1;
  epoch = 0;
  lastError: string | undefined;
  forgotten = false;
  rejected: number[] = [];
  connected = false;
  /** The schema version this client's *code* speaks (ADR-006). */
  schemaVersion: number;
  /** Set when the server announced a newer schema than this client speaks. */
  serverSchemaVersion: number | undefined;
  /** Every op the server acknowledged with a seq — invariant (c)'s ledger.
   * A write in here MUST be reflected in the final server state. */
  readonly acked: { opId: number; seq: number; op: Op }[] = [];
  private io: RefClientIo | undefined;

  constructor(userId: string, clientId: string, schemaVersion = 2) {
    this.userId = userId;
    this.clientId = clientId;
    this.schemaVersion = schemaVersion;
  }

  /**
   * The upgrade barrier (ADR-006): migrate local rows AND every queued op,
   * then resume. Identities are preserved, so replayed ops dedup normally
   * against the server's marks. Runs before any push at the new version.
   */
  upgrade(
    toVersion: number,
    migrateRows: (rows: RowState[], from: number) => RowState[],
    migrateOp: (op: Op, from: number) => Op,
  ): void {
    const from = this.schemaVersion;
    const migrated = migrateRows([...this.base.values()], from);
    this.base = new Map(migrated.map((r) => [`${r.table}/${r.rowId}`, r]));
    this.outbox = this.outbox.map((p) => ({
      opId: p.opId, // identity never changes
      baseSchemaVersion: toVersion,
      op: migrateOp(p.op, from),
    }));
    this.schemaVersion = toVersion;
  }

  /** Wire up a live connection and say hello (with the cursor if any). */
  attach(io: RefClientIo): void {
    this.io = io;
    this.connected = true;
    io.send({
      t: 'hello',
      token: this.userId, // world edge treats token as userId (auth tested at adapters)
      clientId: this.clientId,
      schemaVersion: this.schemaVersion,
      ...(this.cursor !== undefined ? { cursor: this.cursor } : {}),
    });
  }

  detach(): void {
    this.connected = false;
    this.io = undefined;
  }

  mutate(op: Op): void {
    this.outbox.push({ opId: this.nextOpId++, baseSchemaVersion: this.schemaVersion, op });
    this.flush();
  }

  flush(): void {
    if (this.io !== undefined && this.outbox.length > 0) {
      this.io.send({ t: 'push', ops: [...this.outbox] });
    }
  }

  onFrame(frame: ServerFrame): void {
    switch (frame.t) {
      case 'helloAck':
        this.epoch = frame.epoch;
        this.serverSchemaVersion = frame.serverSchemaVersion;
        if (frame.mode === 'snapshot') this.base.clear();
        this.flush(); // replay pending ops once the session is up
        break;
      case 'snapshot': {
        this.base.clear();
        for (const row of frame.rows) this.base.set(`${row.table}/${row.rowId}`, structuredClone(row));
        this.cursor = { seq: frame.atSeq, epoch: frame.epoch };
        break;
      }
      case 'ops': {
        for (const entry of frame.ops) {
          const key = `${entry.op.table}/${entry.op.rowId}`;
          const next = applyEntry(this.base.get(key), entry);
          if (next !== undefined) this.base.set(key, next);
        }
        // Monotonic within an epoch: a late frame from a previous socket
        // must not rewind the cursor (see engine.ts for the same rule).
        this.cursor = {
          seq:
            this.cursor !== undefined && this.cursor.epoch === frame.epoch
              ? Math.max(this.cursor.seq, frame.advanceTo)
              : frame.advanceTo,
          epoch: frame.epoch,
        };
        break;
      }
      case 'pushAck': {
        const done = new Set<number>();
        for (const result of frame.results) {
          done.add(result.opId);
          if ('rejected' in result) this.rejected.push(result.opId);
          if ('seq' in result) {
            const sent = this.outbox.find((p) => p.opId === result.opId);
            if (sent !== undefined) this.acked.push({ opId: result.opId, seq: result.seq, op: sent.op });
          }
        }
        this.outbox = this.outbox.filter((p) => !done.has(p.opId));
        break;
      }
      case 'forget':
        this.base.clear();
        this.outbox = [];
        this.cursor = undefined;
        this.nextOpId = 1; // counter reset pairs with the server's mark clear (ADR-004)
        this.forgotten = true;
        break;
      case 'error':
        this.lastError = frame.code;
        break;
      case 'presence':
      case 'pong':
        break;
    }
  }

  /** Live (non-tombstoned) rows, for convergence comparison. */
  liveRows(): RowState[] {
    return [...this.base.values()].filter((r) => r.deleted === undefined);
  }
}
