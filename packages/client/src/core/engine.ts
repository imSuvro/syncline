// The client sync engine (ADR-001/002/004/005/006): durable outbox with
// write-barrier-before-send, optimistic base+overlay, cursor catch-up,
// transactional forget, reconnect with backoff. Pure: mutates caller-owned
// state, returns ordered effects.
import {
  applyEntry,
  type Op,
  type PushedOp,
  type RowState,
  type ServerFrame,
} from '@syncline/protocol';
import {
  rowKey,
  type ClientConfig,
  type ClientEffect,
  type ClientInput,
  type ClientState,
  type StorageRecord,
  type StoredState,
} from './types.js';

const PING_EVERY_MS = 15_000;
const PING_TIMEOUT_MS = 10_000;
const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 30_000;

export const createClient = (config: ClientConfig): ClientState => ({
  config,
  base: new Map(),
  outbox: [],
  cursor: null,
  nextOpId: 1,
  phase: 'booting',
  online: true,
  epoch: 0,
  presence: [],
  lastSentOpId: 0,
  reconnectAttempts: 0,
  barrierSeq: 0,
  queries: new Map(),
});

export const clientStep = (state: ClientState, input: ClientInput): ClientEffect[] => {
  switch (input.type) {
    case 'boot':
      return handleBoot(state, input);
    case 'connectivity': {
      state.online = input.online;
      if (!input.online) {
        setPhase(state, 'offline');
        return [
          { type: 'disconnect' },
          { type: 'clearTimer', kind: 'ping' },
          { type: 'clearTimer', kind: 'pingTimeout' },
          { type: 'clearTimer', kind: 'reconnect' },
          ...phaseEffects(state),
        ];
      }
      state.reconnectAttempts = 0;
      setPhase(state, 'connecting');
      return [{ type: 'connect' }, ...phaseEffects(state)];
    }
    case 'transportOpen': {
      state.lastSentOpId = 0; // everything unacked re-sends; server dedups
      return [
        {
          type: 'send',
          frame: {
            t: 'hello',
            token: '', // runtime substitutes the real token at the edge
            clientId: state.config.clientId,
            schemaVersion: state.config.schemaVersion,
            ...(state.cursor !== null ? { cursor: state.cursor } : {}),
          },
        },
      ];
    }
    case 'transportClosed': {
      if (state.phase === 'revoked' || state.phase === 'upgradeRequired' || !state.online) {
        return [{ type: 'clearTimer', kind: 'ping' }, { type: 'clearTimer', kind: 'pingTimeout' }];
      }
      setPhase(state, 'connecting');
      const delay = Math.min(RECONNECT_BASE_MS * 2 ** state.reconnectAttempts, RECONNECT_MAX_MS);
      state.reconnectAttempts += 1;
      return [
        { type: 'clearTimer', kind: 'ping' },
        { type: 'clearTimer', kind: 'pingTimeout' },
        { type: 'setTimer', kind: 'reconnect', afterMs: delay },
        ...phaseEffects(state),
      ];
    }
    case 'timerFired':
      switch (input.kind) {
        case 'reconnect':
          return state.online ? [{ type: 'connect' }] : [];
        case 'ping':
          return state.phase === 'ready'
            ? [
                { type: 'send', frame: { t: 'ping' } },
                { type: 'setTimer', kind: 'pingTimeout', afterMs: PING_TIMEOUT_MS },
              ]
            : [];
        case 'pingTimeout':
          return [{ type: 'disconnect' }, { type: 'setTimer', kind: 'reconnect', afterMs: 0 }];
      }
      break;
    case 'serverFrame':
      return handleFrame(state, input.frame);
    case 'localMutation':
      return handleMutation(state, input.op);
    case 'subscribe':
      state.queries.set(input.queryId, input.query);
      return [{ type: 'notifyQueries', ids: [input.queryId] }];
    case 'unsubscribe':
      state.queries.delete(input.queryId);
      return [];
  }
  return [];
};

// --- helpers ---------------------------------------------------------------

const setPhase = (state: ClientState, phase: ClientState['phase']): void => {
  state.phase = phase;
};

const phaseEffects = (state: ClientState): ClientEffect[] => [
  { type: 'emitEvent', event: { kind: 'phase', phase: state.phase } },
  { type: 'notifyQueries', ids: [...state.queries.keys()] },
];

const metaRecord = (state: ClientState): StorageRecord => ({
  key: 'meta',
  value: JSON.stringify({
    cursor: state.cursor,
    nextOpId: state.nextOpId,
    schemaVersion: state.config.schemaVersion,
  }),
});

const queriesTouching = (state: ClientState, tables: Set<string>): string[] =>
  [...state.queries.entries()].filter(([, q]) => tables.has(q.table)).map(([id]) => id);

// --- boot ------------------------------------------------------------------

const handleBoot = (
  state: ClientState,
  input: Extract<ClientInput, { type: 'boot' }>,
): ClientEffect[] => {
  if (input.stored !== null) {
    state.base = new Map(input.stored.rows.map((r) => [rowKey(r.table, r.rowId), r]));
    state.outbox = [...input.stored.outbox];
    state.cursor = input.stored.cursor;
    state.nextOpId = input.stored.nextOpId;
  }
  state.online = input.online;
  setPhase(state, input.online ? 'connecting' : 'offline');
  return [...(input.online ? [{ type: 'connect' } as ClientEffect] : []), ...phaseEffects(state)];
};

// --- server frames ---------------------------------------------------------

const handleFrame = (state: ClientState, frame: ServerFrame): ClientEffect[] => {
  switch (frame.t) {
    case 'helloAck': {
      state.epoch = frame.epoch;
      state.presence = frame.presence;
      state.reconnectAttempts = 0;
      // A fresh session knows nothing was sent: everything unacked replays,
      // and the server's dedup marks absorb the duplicates (ADR-002).
      state.lastSentOpId = 0;
      setPhase(state, 'ready');
      // In snapshot mode the outbox flush waits for the snapshot frame so
      // replayed ops land on the fresh base (ADR-002 ordering).
      const flush = frame.mode === 'incremental' ? flushOutbox(state) : [];
      return [
        ...flush,
        { type: 'setTimer', kind: 'ping', afterMs: PING_EVERY_MS },
        ...phaseEffects(state),
      ];
    }
    case 'snapshot': {
      state.base = new Map(frame.rows.map((r) => [rowKey(r.table, r.rowId), structuredClone(r)]));
      state.cursor = { seq: frame.atSeq, epoch: frame.epoch };
      const records: StorageRecord[] = [
        { clearAll: true },
        ...outboxRecords(state.outbox), // outbox survives snapshot (ADR-002)
        ...[...state.base.values()].map((r) => rowRecord(r)),
        metaRecord(state),
      ];
      return [
        { type: 'storageWrite', records },
        ...flushOutbox(state),
        { type: 'notifyQueries', ids: [...state.queries.keys()] },
      ];
    }
    case 'ops': {
      const touched = new Set<string>();
      const records: StorageRecord[] = [];
      for (const entry of frame.ops) {
        const key = rowKey(entry.op.table, entry.op.rowId);
        const next = applyEntry(state.base.get(key), entry);
        if (next !== undefined) {
          state.base.set(key, next);
          records.push(rowRecord(next));
        }
        touched.add(entry.op.table);
      }
      state.cursor = { seq: frame.advanceTo, epoch: frame.epoch };
      records.push(metaRecord(state));
      return [
        { type: 'storageWrite', records },
        { type: 'notifyQueries', ids: queriesTouching(state, touched) },
      ];
    }
    case 'pushAck': {
      const done = new Map<number, 'ok' | 'forbidden' | 'version' | 'duplicate'>();
      for (const r of frame.results) {
        done.set(r.opId, 'seq' in r ? 'ok' : 'duplicate' in r ? 'duplicate' : r.rejected);
      }
      const rejectedEvents: ClientEffect[] = [];
      const touched = new Set<string>();
      state.outbox = state.outbox.filter((p) => {
        const verdict = done.get(p.opId);
        if (verdict === undefined) return true;
        if (verdict === 'forbidden' || verdict === 'version') {
          rejectedEvents.push({
            type: 'emitEvent',
            event: { kind: 'opRejected', opId: p.opId, reason: verdict },
          });
          touched.add(p.op.table); // overlay reverts; affected queries refresh
        }
        return false;
      });
      const records: StorageRecord[] = [
        ...[...done.keys()].map((opId): StorageRecord => ({ key: `outbox/${String(opId)}`, value: null })),
        metaRecord(state),
      ];
      return [
        { type: 'storageWrite', records },
        ...rejectedEvents,
        { type: 'notifyQueries', ids: queriesTouching(state, touched) },
      ];
    }
    case 'forget': {
      // Transactional purge (ADR-004): store, outbox, cursor, counter — one
      // barrier — then the UX event.
      state.base.clear();
      state.outbox = [];
      state.cursor = null;
      state.nextOpId = 1;
      state.lastSentOpId = 0;
      setPhase(state, 'revoked');
      return [
        { type: 'storageWrite', records: [{ clearAll: true }, metaRecord(state)] },
        { type: 'storageBarrier', id: ++state.barrierSeq },
        { type: 'emitEvent', event: { kind: 'membershipRemoved', workspaceId: state.config.workspaceId } },
        ...phaseEffects(state),
      ];
    }
    case 'presence':
      state.presence = frame.connected;
      return [{ type: 'notifyQueries', ids: [...state.queries.keys()] }];
    case 'pong':
      return [{ type: 'clearTimer', kind: 'pingTimeout' }];
    case 'error':
      return handleError(state, frame.code);
  }
};

const handleError = (state: ClientState, code: string): ClientEffect[] => {
  switch (code) {
    case 'EPOCH_CHANGED':
      // Slice changed: drop the cursor so the next hello takes the snapshot
      // path; the outbox is preserved and replays (ADR-002 ruling).
      state.cursor = null;
      return [{ type: 'storageWrite', records: [metaRecord(state)] }];
    case 'REVOKED':
      return []; // the forget frame already did the work
    case 'VERSION_TOO_NEW':
      setPhase(state, 'upgradeRequired');
      return [{ type: 'emitEvent', event: { kind: 'upgradeRequired' } }, ...phaseEffects(state)];
    default:
      return [{ type: 'emitEvent', event: { kind: 'protocolError', code } }];
  }
};

// --- local writes ----------------------------------------------------------

const rowRecord = (row: RowState): StorageRecord => ({
  key: `row/${rowKey(row.table, row.rowId)}`,
  value: JSON.stringify(row),
});

const outboxRecords = (outbox: PushedOp[]): StorageRecord[] =>
  outbox.map((p) => ({ key: `outbox/${String(p.opId)}`, value: JSON.stringify(p) }));

const handleMutation = (state: ClientState, op: Op): ClientEffect[] => {
  const pushed: PushedOp = {
    opId: state.nextOpId,
    baseSchemaVersion: state.config.schemaVersion,
    op,
  };
  state.nextOpId += 1;
  state.outbox.push(pushed);
  const effects: ClientEffect[] = [
    // Durable-before-send: the op is barriered into storage before any
    // push can carry it (ADR-001; the crash fault tests exactly this).
    { type: 'storageWrite', records: [...outboxRecords([pushed]), metaRecord(state)] },
    { type: 'storageBarrier', id: ++state.barrierSeq },
  ];
  if (state.phase === 'ready') effects.push(...flushOutbox(state));
  effects.push({ type: 'notifyQueries', ids: queriesTouching(state, new Set([op.table])) });
  return effects;
};

const flushOutbox = (state: ClientState): ClientEffect[] => {
  const unsent = state.outbox.filter((p) => p.opId > state.lastSentOpId);
  if (unsent.length === 0) return [];
  state.lastSentOpId = (unsent[unsent.length - 1] as PushedOp).opId;
  return [{ type: 'send', frame: { t: 'push', ops: unsent } }];
};

// --- persistence loading helper (runtime side) ------------------------------

/** Reconstruct StoredState from raw storage records (adapter-agnostic). */
export const decodeStored = (records: Map<string, string>): StoredState | null => {
  const metaRaw = records.get('meta');
  if (metaRaw === undefined) return null;
  const meta = JSON.parse(metaRaw) as { cursor: StoredState['cursor']; nextOpId: number; schemaVersion: number };
  const rows: RowState[] = [];
  const outbox: PushedOp[] = [];
  for (const [key, value] of records) {
    if (key.startsWith('row/')) rows.push(JSON.parse(value) as RowState);
    else if (key.startsWith('outbox/')) outbox.push(JSON.parse(value) as PushedOp);
  }
  outbox.sort((a, b) => a.opId - b.opId);
  return { rows, outbox, cursor: meta.cursor, nextOpId: meta.nextOpId, schemaVersion: meta.schemaVersion };
};
