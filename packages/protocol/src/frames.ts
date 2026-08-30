// Wire frames per ADR-002, with strict hand-rolled decoding: every frame
// off the wire is validated structurally before the cores see it. Zero
// dependencies by design — this file IS the protocol surface a stranger
// implements against (docs/protocol.md mirrors it).
import type { LogEntry, Op, PushedOp, RowState } from './types.js';

export type ErrorCode =
  | 'AUTH_FAILED'
  | 'BAD_FRAME'
  | 'OP_GAP'
  | 'BAD_CURSOR'
  | 'VERSION_TOO_NEW'
  | 'EPOCH_CHANGED'
  | 'REVOKED';

export interface Cursor {
  seq: number;
  epoch: number;
}

export type ClientFrame =
  | { t: 'hello'; token: string; clientId: string; schemaVersion: number; cursor?: Cursor }
  | { t: 'push'; ops: PushedOp[] }
  | { t: 'ping' };

export type PushResult =
  | { opId: number; seq: number }
  | { opId: number; rejected: 'forbidden' | 'version' }
  | { opId: number; duplicate: true };

export type ServerFrame =
  | {
      t: 'helloAck';
      serverSchemaVersion: number;
      minWritableVersion: number;
      mode: 'incremental' | 'snapshot';
      epoch: number;
      presence: string[];
    }
  | { t: 'snapshot'; epoch: number; atSeq: number; rows: RowState[] }
  | { t: 'ops'; epoch: number; ops: LogEntry[]; advanceTo: number }
  | { t: 'pushAck'; results: PushResult[] }
  | { t: 'forget'; epoch: number; upToSeq: number }
  | { t: 'presence'; connected: string[] }
  | { t: 'pong' }
  | { t: 'error'; code: ErrorCode; message: string };

export const encodeFrame = (frame: ClientFrame | ServerFrame): string => JSON.stringify(frame);

// ---------------------------------------------------------------------------
// Strict decoding. Returns null on anything malformed; callers answer
// BAD_FRAME. Validators are written out longhand so the protocol has no
// runtime dependency and the checks read like the spec.

type Json = unknown;

const isObj = (x: Json): x is Record<string, unknown> =>
  typeof x === 'object' && x !== null && !Array.isArray(x);
const isStr = (x: Json): x is string => typeof x === 'string';
const isNum = (x: Json): x is number => typeof x === 'number' && Number.isFinite(x);
const isInt = (x: Json): x is number => isNum(x) && Number.isInteger(x) && x >= 0;
const isFieldValue = (x: Json): boolean =>
  x === null || typeof x === 'string' || typeof x === 'number' || typeof x === 'boolean';

const decodeOp = (x: Json): Op | null => {
  if (!isObj(x) || !isStr(x['table']) || !isStr(x['rowId'])) return null;
  const table = x['table'];
  const rowId = x['rowId'];
  switch (x['kind']) {
    case 'create': {
      const fields = x['fields'];
      if (!isObj(fields)) return null;
      for (const v of Object.values(fields)) if (!isFieldValue(v)) return null;
      return { kind: 'create', table, rowId, fields: fields as Record<string, never> };
    }
    case 'update': {
      if (!isStr(x['field']) || !isFieldValue(x['value'])) return null;
      return { kind: 'update', table, rowId, field: x['field'], value: x['value'] as never };
    }
    case 'delete':
      return { kind: 'delete', table, rowId };
    default:
      return null;
  }
};

const decodeCursor = (x: Json): Cursor | null =>
  isObj(x) && isInt(x['seq']) && isInt(x['epoch']) ? { seq: x['seq'], epoch: x['epoch'] } : null;

export const decodeClientFrame = (text: string): ClientFrame | null => {
  let x: Json;
  try {
    x = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isObj(x)) return null;
  switch (x['t']) {
    case 'hello': {
      if (!isStr(x['token']) || !isStr(x['clientId']) || !isInt(x['schemaVersion'])) return null;
      const frame: ClientFrame = {
        t: 'hello',
        token: x['token'],
        clientId: x['clientId'],
        schemaVersion: x['schemaVersion'],
      };
      if (x['cursor'] !== undefined) {
        const cursor = decodeCursor(x['cursor']);
        if (cursor === null) return null;
        return { ...frame, cursor };
      }
      return frame;
    }
    case 'push': {
      const raw = x['ops'];
      if (!Array.isArray(raw) || raw.length === 0) return null;
      const ops: PushedOp[] = [];
      for (const entry of raw) {
        if (!isObj(entry) || !isInt(entry['opId']) || !isInt(entry['baseSchemaVersion'])) return null;
        const op = decodeOp(entry['op']);
        if (op === null) return null;
        ops.push({ opId: entry['opId'], baseSchemaVersion: entry['baseSchemaVersion'], op });
      }
      return { t: 'push', ops };
    }
    case 'ping':
      return { t: 'ping' };
    default:
      return null;
  }
};

const decodeRowState = (x: Json): RowState | null => {
  if (!isObj(x) || !isStr(x['table']) || !isStr(x['rowId']) || !isObj(x['fields'])) return null;
  const fields: RowState['fields'] = {};
  for (const [name, stamp] of Object.entries(x['fields'])) {
    if (!isObj(stamp) || !isFieldValue(stamp['v']) || !isInt(stamp['seq'])) return null;
    fields[name] = { v: stamp['v'] as never, seq: stamp['seq'] };
  }
  const row: RowState = { table: x['table'], rowId: x['rowId'], fields };
  if (x['deleted'] !== undefined) {
    if (!isObj(x['deleted']) || !isInt(x['deleted']['seq'])) return null;
    return { ...row, deleted: { seq: x['deleted']['seq'] } };
  }
  return row;
};

const ERROR_CODES: readonly ErrorCode[] = [
  'AUTH_FAILED',
  'BAD_FRAME',
  'OP_GAP',
  'BAD_CURSOR',
  'VERSION_TOO_NEW',
  'EPOCH_CHANGED',
  'REVOKED',
];

export const decodeServerFrame = (text: string): ServerFrame | null => {
  let x: Json;
  try {
    x = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isObj(x)) return null;
  switch (x['t']) {
    case 'helloAck': {
      const mode = x['mode'];
      if (
        !isInt(x['serverSchemaVersion']) ||
        !isInt(x['minWritableVersion']) ||
        (mode !== 'incremental' && mode !== 'snapshot') ||
        !isInt(x['epoch']) ||
        !Array.isArray(x['presence']) ||
        !x['presence'].every(isStr)
      )
        return null;
      return {
        t: 'helloAck',
        serverSchemaVersion: x['serverSchemaVersion'],
        minWritableVersion: x['minWritableVersion'],
        mode,
        epoch: x['epoch'],
        presence: x['presence'],
      };
    }
    case 'snapshot': {
      if (!isInt(x['epoch']) || !isInt(x['atSeq']) || !Array.isArray(x['rows'])) return null;
      const rows: RowState[] = [];
      for (const raw of x['rows']) {
        const row = decodeRowState(raw);
        if (row === null) return null;
        rows.push(row);
      }
      return { t: 'snapshot', epoch: x['epoch'], atSeq: x['atSeq'], rows };
    }
    case 'ops': {
      if (!isInt(x['epoch']) || !isInt(x['advanceTo']) || !Array.isArray(x['ops'])) return null;
      const ops: LogEntry[] = [];
      for (const raw of x['ops']) {
        if (!isObj(raw) || !isInt(raw['seq']) || !isStr(raw['clientId']) || !isInt(raw['opId'])) return null;
        const op = decodeOp(raw['op']);
        if (op === null) return null;
        ops.push({ seq: raw['seq'], clientId: raw['clientId'], opId: raw['opId'], op });
      }
      return { t: 'ops', epoch: x['epoch'], ops, advanceTo: x['advanceTo'] };
    }
    case 'pushAck': {
      if (!Array.isArray(x['results'])) return null;
      const results: PushResult[] = [];
      for (const raw of x['results']) {
        if (!isObj(raw) || !isInt(raw['opId'])) return null;
        if (isInt(raw['seq'])) results.push({ opId: raw['opId'], seq: raw['seq'] });
        else if (raw['rejected'] === 'forbidden' || raw['rejected'] === 'version')
          results.push({ opId: raw['opId'], rejected: raw['rejected'] });
        else if (raw['duplicate'] === true) results.push({ opId: raw['opId'], duplicate: true });
        else return null;
      }
      return { t: 'pushAck', results };
    }
    case 'forget':
      return isInt(x['epoch']) && isInt(x['upToSeq'])
        ? { t: 'forget', epoch: x['epoch'], upToSeq: x['upToSeq'] }
        : null;
    case 'presence':
      return Array.isArray(x['connected']) && x['connected'].every(isStr)
        ? { t: 'presence', connected: x['connected'] }
        : null;
    case 'pong':
      return { t: 'pong' };
    case 'error': {
      const code = x['code'];
      return ERROR_CODES.includes(code as ErrorCode) && isStr(x['message'])
        ? { t: 'error', code: code as ErrorCode, message: x['message'] }
        : null;
    }
    default:
      return null;
  }
};
