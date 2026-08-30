// Client core vocabulary (ADR-001): explicit inputs, ordered effects, all
// IO and time at the edges. The runtime (browser or harness) owns the
// clock, storage, and socket; the core owns every decision.
import type {
  ClientFrame,
  Cursor,
  Op,
  PushedOp,
  RowState,
  ServerFrame,
} from '@syncline/protocol';

export interface ClientConfig {
  clientId: string;
  workspaceId: string;
  schemaVersion: number;
}

/** What survives restart, exactly (mirrored to storage via effects). */
export interface StoredState {
  rows: RowState[];
  outbox: PushedOp[];
  cursor: Cursor | null;
  nextOpId: number;
  schemaVersion: number;
}

export type ConnectionPhase =
  | 'booting'
  | 'offline'
  | 'connecting'
  | 'ready'
  | 'revoked'
  | 'upgradeRequired';

export interface QuerySpec {
  table: string;
}

export interface ClientState {
  config: ClientConfig;
  // Durable (every change flows out as storageWrite effects):
  base: Map<string, RowState>;
  outbox: PushedOp[];
  cursor: Cursor | null;
  nextOpId: number;
  // Volatile:
  phase: ConnectionPhase;
  online: boolean;
  epoch: number;
  presence: string[];
  lastSentOpId: number;
  reconnectAttempts: number;
  barrierSeq: number;
  queries: Map<string, QuerySpec>;
}

export type ClientInput =
  | { type: 'boot'; stored: StoredState | null; online: boolean; now: number }
  | { type: 'connectivity'; online: boolean; now: number }
  | { type: 'transportOpen'; now: number }
  | { type: 'transportClosed'; now: number }
  | { type: 'serverFrame'; frame: ServerFrame; now: number }
  | { type: 'localMutation'; op: Op; now: number }
  | { type: 'timerFired'; kind: TimerKind; now: number }
  | { type: 'subscribe'; queryId: string; query: QuerySpec; now: number }
  | { type: 'unsubscribe'; queryId: string; now: number };

export type TimerKind = 'reconnect' | 'ping' | 'pingTimeout';

/** Key/value mutations against durable storage. `null` deletes; the
 * whole batch is applied atomically by the adapter (one IDB transaction). */
export type StorageRecord =
  | { key: string; value: string }
  | { key: string; value: null }
  | { clearAll: true };

export type ClientEvent =
  | { kind: 'membershipRemoved'; workspaceId: string }
  | { kind: 'opRejected'; opId: number; reason: 'forbidden' | 'version' }
  | { kind: 'upgradeRequired' }
  | { kind: 'protocolError'; code: string }
  | { kind: 'phase'; phase: ConnectionPhase };

export type ClientEffect =
  | { type: 'storageWrite'; records: StorageRecord[] }
  | { type: 'storageBarrier'; id: number }
  | { type: 'connect' }
  | { type: 'disconnect' }
  | { type: 'send'; frame: ClientFrame }
  | { type: 'setTimer'; kind: TimerKind; afterMs: number }
  | { type: 'clearTimer'; kind: TimerKind }
  | { type: 'notifyQueries'; ids: string[] }
  | { type: 'emitEvent'; event: ClientEvent };

export const rowKey = (table: string, rowId: string): string => `${table}/${rowId}`;
