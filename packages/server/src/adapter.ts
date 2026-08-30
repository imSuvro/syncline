// The ONE adapter boundary (ADR-007). Everything platform-specific —
// Durable Object SQLite, node:sqlite, the harness's Maps — implements these
// interfaces; @syncline/server contains no platform code. Contract
// obligations on every adapter: (1) storage writes of a core step are
// durable before that step's sends are released (DO output gate / SQLite
// transaction committed before flush); (2) tx is atomic — a crash mid-step
// loses the whole step, never half.
import type { EpochState, LogEntry, Op, RowState } from '@syncline/protocol';

export interface ServerStorage {
  /** Append one op to the log, assigning and returning the next seq. */
  appendOp(clientId: string, opId: number, op: Op): number;
  getOpsSince(seq: number, limit: number): LogEntry[];
  headSeq(): number;

  getRow(table: string, rowId: string): RowState | undefined;
  putRow(row: RowState): void;
  /** Live + tombstoned rows; snapshot building filters tombstones itself. */
  scanRows(): RowState[];

  /** Push-dedup high-water mark per clientId (0 when unseen). */
  getClientMark(clientId: string): number;
  setClientMark(clientId: string, opId: number): void;
  /** Records which user a clientId belongs to (for revoke-time mark clears). */
  setClientOwner(clientId: string, userId: string): void;
  /** Clears marks of every clientId owned by userId (ADR-004 step 2). */
  clearMarksForUser(userId: string): void;

  getEpoch(userId: string): EpochState;
  setEpoch(userId: string, state: EpochState): void;

  getMeta(key: string): string | undefined;
  setMeta(key: string, value: string): void;

  /** Directory propagation outbox (ADR-007): at-least-once via alarm retry. */
  enqueueDirectory(change: string): void;
  peekDirectory(limit: number): { id: number; change: string }[];
  ackDirectory(id: number): void;

  /** Atomic scope for one core step. */
  tx<T>(fn: () => T): T;
}

export interface Env {
  /** Fresh unique id (edges only — cores never mint ids ambiently). */
  newId(): string;
}

export interface ServerDeps {
  storage: ServerStorage;
  env: Env;
}
