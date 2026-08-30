// WorkspaceCore (ADR-001/002/003/004): the deterministic per-workspace sync
// authority. Consumes explicit inputs, reads/writes storage synchronously
// through the injected adapter, returns ordered effects. No platform code,
// no clocks, no ambient ids.
import {
  applyEntry,
  canWrite,
  rowValues,
  type ClientFrame,
  type Cursor,
  type ErrorCode,
  type LogEntry,
  type Op,
  type Principal,
  type PushResult,
  type Role,
  type RowState,
  type Ruleset,
  type ServerFrame,
} from '@syncline/protocol';
import type { ServerStorage } from './adapter.js';
import { permitEntryFor, permitRowFor, type Permitted } from './permit.js';

export interface WorkspaceConfig {
  workspaceId: string;
  schemaVersion: number;
  minWritableVersion: number;
  ruleset: Ruleset;
  /** Migrates an op payload from `fromVersion` up to `schemaVersion`
   * (ADR-006). Total: must return a valid op. v1: identity. */
  migrateOp: (op: Op, fromVersion: number) => Op;
}

export interface Conn {
  userId: string;
  clientId: string;
  epochAtHello: number;
}

/** In-memory connection registry — rebuilt after hibernation via
 * rehydrateConnection; everything durable lives in storage. */
export interface WorkspaceState {
  conns: Map<string, Conn>;
}

export const createWorkspace = (): WorkspaceState => ({ conns: new Map() });

/** Attachment blob (ADR-007): non-authoritative identity cache. The permit
 * path never reads it; epochAtHello exists only for the staleness check. */
export const rehydrateConnection = (
  state: WorkspaceState,
  connId: string,
  blob: string,
): void => {
  const parsed = JSON.parse(blob) as Conn;
  state.conns.set(connId, {
    userId: parsed.userId,
    clientId: parsed.clientId,
    epochAtHello: parsed.epochAtHello,
  });
};

export type ServerInput =
  | { type: 'hello'; connId: string; userId: string; clientId: string; schemaVersion: number; cursor?: Cursor; now: number }
  | { type: 'frame'; connId: string; frame: ClientFrame; now: number }
  | { type: 'disconnect'; connId: string; now: number }
  | { type: 'seed'; clientId: string; ops: Op[]; now: number };

export type ServerEffect =
  | { type: 'send'; connId: string; frame: ServerFrame }
  | { type: 'close'; connId: string; code: ErrorCode | 'NORMAL' }
  | { type: 'setAttachment'; connId: string; blob: string };

const OPS_BATCH = 500;

export const workspaceStep = (
  state: WorkspaceState,
  config: WorkspaceConfig,
  storage: ServerStorage,
  input: ServerInput,
): ServerEffect[] => {
  switch (input.type) {
    case 'hello':
      return handleHello(state, config, storage, input);
    case 'frame':
      return handleFrame(state, config, storage, input);
    case 'disconnect': {
      const conn = state.conns.get(input.connId);
      if (conn === undefined) return [];
      state.conns.delete(input.connId);
      return broadcastPresence(state);
    }
    case 'seed':
      return handleSeed(config, storage, input);
  }
};

// --- helpers ---------------------------------------------------------------

// Memberships are keyed by minted per-episode rowIds (revoke tombstones an
// episode; re-invite mints a new one — ADR-005's never-resurrect rule
// holds). The live role is found by scanning the table for the user's
// non-deleted row; O(rows) is fine at demo scale.
const membershipRoleOf = (storage: ServerStorage, userId: string): Role | undefined => {
  for (const row of storage.scanRows()) {
    if (row.table !== 'memberships' || row.deleted !== undefined) continue;
    if (row.fields['userId']?.v !== userId) continue;
    const role = row.fields['role']?.v;
    return role === 'owner' || role === 'editor' || role === 'viewer' ? role : undefined;
  }
  return undefined;
};

const connectedUserIds = (state: WorkspaceState): string[] =>
  [...new Set([...state.conns.values()].map((c) => c.userId))].sort();

const broadcastPresence = (state: WorkspaceState): ServerEffect[] => {
  const connected = connectedUserIds(state);
  return [...state.conns.keys()].map((connId) => ({
    type: 'send' as const,
    connId,
    frame: { t: 'presence' as const, connected },
  }));
};

const err = (connId: string, code: ErrorCode, message: string): ServerEffect[] => [
  { type: 'send', connId, frame: { t: 'error', code, message } },
  { type: 'close', connId, code },
];

/** Revocation answer for any contact from a revoked principal (ADR-004). */
const revokedAnswer = (
  storage: ServerStorage,
  connId: string,
  userId: string,
): ServerEffect[] => {
  const epochState = storage.getEpoch(userId);
  return [
    {
      type: 'send',
      connId,
      frame: { t: 'forget', epoch: epochState.epoch, upToSeq: epochState.revokedUpToSeq ?? 0 },
    },
    ...err(connId, 'REVOKED', 'membership revoked; workspace data forgotten'),
  ];
};

// --- hello -----------------------------------------------------------------

const handleHello = (
  state: WorkspaceState,
  config: WorkspaceConfig,
  storage: ServerStorage,
  input: Extract<ServerInput, { type: 'hello' }>,
): ServerEffect[] => {
  const { connId, userId, clientId, cursor } = input;
  const role = membershipRoleOf(storage, userId);
  const epochState = storage.getEpoch(userId);

  if (role === undefined) {
    return epochState.revokedUpToSeq !== undefined
      ? revokedAnswer(storage, connId, userId)
      : err(connId, 'AUTH_FAILED', 'not a member of this workspace');
  }
  // A clientId is a device, and a device belongs to exactly one user. The
  // token proves who you are; this stops you from claiming someone else's
  // device id, whose dedup marks you would otherwise advance — silently
  // destroying their pending writes.
  const owner = storage.getClientOwner(clientId);
  if (owner !== undefined && owner !== userId) {
    return err(connId, 'AUTH_FAILED', 'client id belongs to another user');
  }
  if (input.schemaVersion > config.schemaVersion) {
    return err(connId, 'VERSION_TOO_NEW', 'client schema is newer than the server');
  }
  const head = storage.headSeq();
  if (cursor !== undefined && (cursor.epoch > epochState.epoch || cursor.seq > head)) {
    return err(connId, 'BAD_CURSOR', 'cursor is ahead of the server');
  }

  const mode: 'incremental' | 'snapshot' =
    cursor !== undefined && cursor.epoch === epochState.epoch ? 'incremental' : 'snapshot';

  // A new epoch starts a fresh op-id sequence for this client. Revocation
  // clears marks server-side (ADR-004); without this, a device that was
  // offline through a revoke/re-invite would replay op 58 against a mark of
  // 0, trip OP_GAP, and reconnect-loop forever with an undrainable outbox.
  // Both sides apply the same rule on the same signal, so they stay in step.
  if (mode === 'snapshot') storage.setClientMark(clientId, 0);

  const conn: Conn = { userId, clientId, epochAtHello: epochState.epoch };
  state.conns.set(connId, conn);
  storage.setClientOwner(clientId, userId);
  const principal: Principal = { userId, role };

  const effects: ServerEffect[] = [
    { type: 'setAttachment', connId, blob: JSON.stringify(conn) },
    {
      type: 'send',
      connId,
      frame: {
        t: 'helloAck',
        serverSchemaVersion: config.schemaVersion,
        minWritableVersion: config.minWritableVersion,
        mode,
        epoch: epochState.epoch,
        presence: connectedUserIds(state),
      },
    },
  ];

  if (mode === 'snapshot') {
    // Branded element type: only permit.ts can produce these, so a raw row
    // reaching a data frame is a type error, not a code-review question.
    const rows: Permitted<RowState>[] = [];
    for (const row of storage.scanRows()) {
      const permitted = permitRowFor(config.ruleset, principal, row);
      if (permitted !== null) rows.push(permitted);
    }
    effects.push({
      type: 'send',
      connId,
      frame: { t: 'snapshot', epoch: epochState.epoch, atSeq: head, rows },
    });
  } else {
    // Incremental backfill from the cursor to head, batched; always at least
    // one ops frame so an all-filtered stretch still advances the cursor.
    let from = (cursor as Cursor).seq;
    do {
      const batch = storage.getOpsSince(from, OPS_BATCH);
      const last = batch.length > 0 ? (batch[batch.length - 1] as LogEntry).seq : head;
      const visible: Permitted<LogEntry>[] = [];
      for (const entry of batch) {
        const judgeRow = storage.getRow(entry.op.table, entry.op.rowId);
        const permitted = permitEntryFor(config.ruleset, principal, entry, judgeRow);
        if (permitted !== null) visible.push(permitted);
      }
      effects.push({
        type: 'send',
        connId,
        frame: { t: 'ops', epoch: epochState.epoch, ops: visible, advanceTo: last },
      });
      from = last;
    } while (from < head);
  }

  effects.push(...broadcastPresence(state));
  return effects;
};

// --- frames after hello ----------------------------------------------------

const handleFrame = (
  state: WorkspaceState,
  config: WorkspaceConfig,
  storage: ServerStorage,
  input: Extract<ServerInput, { type: 'frame' }>,
): ServerEffect[] => {
  const { connId, frame } = input;
  const conn = state.conns.get(connId);
  if (conn === undefined) return err(connId, 'BAD_FRAME', 'frame before hello');

  // Receive-time staleness check (ADR-004): evicts hibernation-survivors.
  const epochState = storage.getEpoch(conn.userId);
  if (epochState.epoch !== conn.epochAtHello) {
    state.conns.delete(connId);
    return epochState.revokedUpToSeq !== undefined
      ? revokedAnswer(storage, connId, conn.userId)
      : err(connId, 'EPOCH_CHANGED', 'visible slice changed; reconnect');
  }

  switch (frame.t) {
    case 'ping':
      return [{ type: 'send', connId, frame: { t: 'pong' } }];
    case 'hello':
      return err(connId, 'BAD_FRAME', 'duplicate hello');
    case 'push':
      return handlePush(state, config, storage, connId, conn, frame);
  }
};

const handlePush = (
  state: WorkspaceState,
  config: WorkspaceConfig,
  storage: ServerStorage,
  connId: string,
  conn: Conn,
  frame: Extract<ClientFrame, { t: 'push' }>,
): ServerEffect[] => {
  if (membershipRoleOf(storage, conn.userId) === undefined) {
    // Race: revoked between staleness check and here can't happen inside one
    // step, but a missing membership with an unchanged epoch is a bug guard.
    state.conns.delete(connId);
    return revokedAnswer(storage, connId, conn.userId);
  }

  const results: PushResult[] = [];
  const appended: LogEntry[] = [];
  /** Pre-image values for delete broadcasts (judge against what was visible). */
  const judgeRows = new Map<number, RowState | undefined>();
  const lateEffects: ServerEffect[] = [];

  let mark = storage.getClientMark(conn.clientId);
  for (const pushed of frame.ops) {
    if (pushed.opId <= mark) {
      results.push({ opId: pushed.opId, duplicate: true });
      continue;
    }
    if (pushed.opId !== mark + 1) {
      state.conns.delete(connId);
      return err(connId, 'OP_GAP', `expected opId ${String(mark + 1)}, got ${String(pushed.opId)}`);
    }
    if (
      pushed.baseSchemaVersion < config.minWritableVersion ||
      pushed.baseSchemaVersion > config.schemaVersion
    ) {
      results.push({ opId: pushed.opId, rejected: 'version' });
      mark = pushed.opId;
      storage.setClientMark(conn.clientId, mark);
      continue;
    }
    const op =
      pushed.baseSchemaVersion < config.schemaVersion
        ? config.migrateOp(pushed.op, pushed.baseSchemaVersion)
        : pushed.op;

    // Re-read the role for EVERY op: a batch can revoke or demote its own
    // author part-way through (self-removal is allowed), and the remaining
    // ops must be judged by what the author is now, not what they were when
    // the batch arrived.
    const role = membershipRoleOf(storage, conn.userId);
    if (role === undefined) {
      state.conns.delete(connId);
      return [
        { type: 'send', connId, frame: { t: 'pushAck', results } },
        ...revokedAnswer(storage, connId, conn.userId),
      ];
    }
    const principal: Principal = { userId: conn.userId, role };

    const existing = storage.getRow(op.table, op.rowId);
    const existingValues = existing !== undefined && existing.deleted === undefined ? rowValues(existing) : {};
    if (!canWrite(config.ruleset, principal, op, existingValues)) {
      results.push({ opId: pushed.opId, rejected: 'forbidden' });
      mark = pushed.opId;
      storage.setClientMark(conn.clientId, mark);
      continue;
    }
    // One live membership per user. Two would make the effective role depend
    // on storage scan order, which differs per adapter — a demotion applied
    // to the "wrong" episode row would silently do nothing.
    if (op.kind === 'create' && op.table === 'memberships') {
      const target = op.fields['userId'];
      if (typeof target === 'string' && membershipRoleOf(storage, target) !== undefined) {
        results.push({ opId: pushed.opId, rejected: 'forbidden' });
        mark = pushed.opId;
        storage.setClientMark(conn.clientId, mark);
        continue;
      }
    }

    const seq = storage.appendOp(conn.clientId, pushed.opId, op);
    const entry: LogEntry = { seq, clientId: conn.clientId, opId: pushed.opId, op };
    judgeRows.set(seq, existing);
    const next = applyEntry(existing, entry);
    if (next !== undefined) storage.putRow(next);
    mark = pushed.opId;
    storage.setClientMark(conn.clientId, mark);
    results.push({ opId: pushed.opId, seq });
    appended.push(entry);

    if (op.table === 'memberships') {
      const targetUserId =
        op.kind === 'create'
          ? op.fields['userId']
          : existingValues['userId'];
      if (typeof targetUserId === 'string') {
        lateEffects.push(...membershipSideEffects(state, storage, entry, targetUserId));
      }
    }
  }

  const effects: ServerEffect[] = [
    { type: 'send', connId, frame: { t: 'pushAck', results } },
  ];
  // pushAck precedes forget/close even for self-removal (ADR-004 step 3).
  effects.push(...broadcastEntries(state, config, storage, appended, judgeRows));
  effects.push(...lateEffects);
  return effects;
};

/** Epoch bumps, mark clears, forget pushes, directory notifies (ADR-004). */
const membershipSideEffects = (
  state: WorkspaceState,
  storage: ServerStorage,
  entry: LogEntry,
  targetUserId: string,
): ServerEffect[] => {
  const current = storage.getEpoch(targetUserId);
  const effects: ServerEffect[] = [];

  if (entry.op.kind === 'delete') {
    const epoch = current.epoch + 1;
    storage.setEpoch(targetUserId, { epoch, revokedUpToSeq: entry.seq });
    storage.clearMarksForUser(targetUserId);
    for (const [cid, c] of [...state.conns]) {
      if (c.userId !== targetUserId) continue;
      state.conns.delete(cid);
      effects.push({ type: 'send', connId: cid, frame: { t: 'forget', epoch, upToSeq: entry.seq } });
      effects.push({ type: 'close', connId: cid, code: 'REVOKED' });
    }
  } else {
    // invite (create) or role change (update): fresh epoch, no forget.
    storage.setEpoch(targetUserId, { epoch: current.epoch + 1 });
    for (const [cid, c] of [...state.conns]) {
      if (c.userId !== targetUserId) continue;
      state.conns.delete(cid);
      effects.push(...err(cid, 'EPOCH_CHANGED', 'your role in this workspace changed'));
    }
  }
  storage.enqueueDirectory(
    JSON.stringify({ kind: entry.op.kind, userId: targetUserId, seq: entry.seq }),
  );
  effects.push(...broadcastPresence(state));
  return effects;
};

/** Fan out appended entries to every live connection through the permit
 * path — including the pusher (own-op echo, ADR-002). */
const broadcastEntries = (
  state: WorkspaceState,
  config: WorkspaceConfig,
  storage: ServerStorage,
  appended: LogEntry[],
  judgeRows: Map<number, RowState | undefined>,
): ServerEffect[] => {
  if (appended.length === 0) return [];
  const advanceTo = (appended[appended.length - 1] as LogEntry).seq;
  const effects: ServerEffect[] = [];
  for (const [connId, conn] of state.conns) {
    const role = membershipRoleOf(storage, conn.userId);
    if (role === undefined) continue; // just-revoked conns were removed already
    const principal: Principal = { userId: conn.userId, role };
    const visible: Permitted<LogEntry>[] = [];
    for (const entry of appended) {
      const judgeRow =
        entry.op.kind === 'delete'
          ? judgeRows.get(entry.seq)
          : storage.getRow(entry.op.table, entry.op.rowId);
      const permitted = permitEntryFor(config.ruleset, principal, entry, judgeRow);
      if (permitted !== null) visible.push(permitted);
    }
    effects.push({
      type: 'send',
      connId,
      frame: { t: 'ops', epoch: conn.epochAtHello, ops: visible, advanceTo },
    });
  }
  return effects;
};

// --- seeding ---------------------------------------------------------------

/** Seeds flow through the normal append/apply pipeline as a system client,
 * bypassing permission checks (there are no members yet to authorize). */
const handleSeed = (
  config: WorkspaceConfig,
  storage: ServerStorage,
  input: Extract<ServerInput, { type: 'seed' }>,
): ServerEffect[] => {
  let mark = storage.getClientMark(input.clientId);
  for (const op of input.ops) {
    mark += 1;
    const seq = storage.appendOp(input.clientId, mark, op);
    const entry: LogEntry = { seq, clientId: input.clientId, opId: mark, op };
    const next = applyEntry(storage.getRow(op.table, op.rowId), entry);
    if (next !== undefined) storage.putRow(next);
  }
  storage.setClientMark(input.clientId, mark);
  return [];
};
