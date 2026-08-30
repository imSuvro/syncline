import { describe, expect, test } from 'vitest';
import {
  decodeClientFrame,
  decodeServerFrame,
  encodeFrame,
  type ClientFrame,
  type ServerFrame,
} from '@syncline/protocol';

describe('frame codecs (ADR-002)', () => {
  test('client frames round-trip', () => {
    const frames: ClientFrame[] = [
      { t: 'hello', token: 'tok', clientId: 'c1', schemaVersion: 1 },
      { t: 'hello', token: 'tok', clientId: 'c1', schemaVersion: 1, cursor: { seq: 7, epoch: 2 } },
      {
        t: 'push',
        ops: [
          { opId: 1, baseSchemaVersion: 1, op: { kind: 'create', table: 'issues', rowId: 'r1', fields: { title: 'x', assignee: null } } },
          { opId: 2, baseSchemaVersion: 1, op: { kind: 'update', table: 'issues', rowId: 'r1', field: 'status', value: 'done' } },
          { opId: 3, baseSchemaVersion: 1, op: { kind: 'delete', table: 'issues', rowId: 'r1' } },
        ],
      },
      { t: 'ping' },
    ];
    for (const frame of frames) {
      expect(decodeClientFrame(encodeFrame(frame))).toEqual(frame);
    }
  });

  test('server frames round-trip', () => {
    const frames: ServerFrame[] = [
      { t: 'helloAck', serverSchemaVersion: 2, minWritableVersion: 1, mode: 'snapshot', epoch: 3, presence: ['maya'] },
      { t: 'snapshot', epoch: 3, atSeq: 42, rows: [{ table: 'issues', rowId: 'r1', fields: { title: { v: 'x', seq: 9 } } }] },
      { t: 'ops', epoch: 3, ops: [{ seq: 43, clientId: 'c1', opId: 5, op: { kind: 'delete', table: 'issues', rowId: 'r1' } }], advanceTo: 44 },
      { t: 'pushAck', results: [{ opId: 1, seq: 43 }, { opId: 2, rejected: 'forbidden' }, { opId: 3, duplicate: true }] },
      { t: 'forget', epoch: 4, upToSeq: 43 },
      { t: 'presence', connected: ['maya', 'priya'] },
      { t: 'pong' },
      { t: 'error', code: 'OP_GAP', message: 'expected 4' },
    ];
    for (const frame of frames) {
      expect(decodeServerFrame(encodeFrame(frame))).toEqual(frame);
    }
  });

  test('malformed input decodes to null, never throws', () => {
    const bad = [
      'not json',
      '{}',
      '{"t":"nope"}',
      '{"t":"hello","token":1,"clientId":"c","schemaVersion":1}',
      '{"t":"hello","token":"t","clientId":"c","schemaVersion":1,"cursor":{"seq":-1,"epoch":0}}',
      '{"t":"push","ops":[]}',
      '{"t":"push","ops":[{"opId":1,"baseSchemaVersion":1,"op":{"kind":"update","table":"t","rowId":"r","field":"f","value":{"nested":true}}}]}',
      '{"t":"ops","epoch":0,"ops":[{"seq":1}],"advanceTo":1}',
      '{"t":"error","code":"MADE_UP","message":"x"}',
    ];
    for (const text of bad) {
      expect(decodeClientFrame(text)).toBeNull();
      expect(decodeServerFrame(text)).toBeNull();
    }
  });
});
