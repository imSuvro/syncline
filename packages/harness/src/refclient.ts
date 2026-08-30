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
  private io: RefClientIo | undefined;

  constructor(userId: string, clientId: string) {
    this.userId = userId;
    this.clientId = clientId;
  }

  /** Wire up a live connection and say hello (with the cursor if any). */
  attach(io: RefClientIo): void {
    this.io = io;
    this.connected = true;
    io.send({
      t: 'hello',
      token: this.userId, // world edge treats token as userId (auth tested at adapters)
      clientId: this.clientId,
      schemaVersion: 1,
      ...(this.cursor !== undefined ? { cursor: this.cursor } : {}),
    });
  }

  detach(): void {
    this.connected = false;
    this.io = undefined;
  }

  mutate(op: Op): void {
    this.outbox.push({ opId: this.nextOpId++, baseSchemaVersion: 1, op });
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
        this.cursor = { seq: frame.advanceTo, epoch: frame.epoch };
        break;
      }
      case 'pushAck': {
        const done = new Set<number>();
        for (const result of frame.results) {
          done.add(result.opId);
          if ('rejected' in result) this.rejected.push(result.opId);
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
