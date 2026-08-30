import { describe, expect, test } from 'vitest';
import { applyEntry, mergeField, type LogEntry, type RowState } from '@syncline/protocol';

const entry = (seq: number, op: LogEntry['op']): LogEntry => ({ seq, clientId: 'c', opId: seq, op });

describe('mergeField (ADR-005)', () => {
  test('higher seq wins, lower/equal loses', () => {
    expect(mergeField({ v: 'a', seq: 5 }, { v: 'b', seq: 6 })).toEqual({ v: 'b', seq: 6 });
    expect(mergeField({ v: 'a', seq: 5 }, { v: 'b', seq: 5 })).toEqual({ v: 'a', seq: 5 });
    expect(mergeField({ v: 'a', seq: 5 }, { v: 'b', seq: 4 })).toEqual({ v: 'a', seq: 5 });
    expect(mergeField(undefined, { v: 'b', seq: 1 })).toEqual({ v: 'b', seq: 1 });
  });
});

describe('applyEntry (ADR-005)', () => {
  test('create then update materializes stamped fields', () => {
    let row = applyEntry(undefined, entry(1, { kind: 'create', table: 't', rowId: 'r', fields: { a: 'x', b: 1 } }));
    row = applyEntry(row, entry(2, { kind: 'update', table: 't', rowId: 'r', field: 'a', value: 'y' }));
    expect(row).toEqual({
      table: 't',
      rowId: 'r',
      fields: { a: { v: 'y', seq: 2 }, b: { v: 1, seq: 1 } },
    });
  });

  test('stale update does not regress a field (cross-path guard)', () => {
    let row: RowState | undefined = { table: 't', rowId: 'r', fields: { a: { v: 'new', seq: 9 } } };
    row = applyEntry(row, entry(3, { kind: 'update', table: 't', rowId: 'r', field: 'a', value: 'old' }));
    expect(row?.fields['a']).toEqual({ v: 'new', seq: 9 });
  });

  test('delete tombstones win over everything after', () => {
    let row = applyEntry(undefined, entry(1, { kind: 'create', table: 't', rowId: 'r', fields: { a: 'x' } }));
    row = applyEntry(row, entry(2, { kind: 'delete', table: 't', rowId: 'r' }));
    const afterUpdate = applyEntry(row, entry(3, { kind: 'update', table: 't', rowId: 'r', field: 'a', value: 'y' }));
    const afterCreate = applyEntry(afterUpdate, entry(4, { kind: 'create', table: 't', rowId: 'r', fields: { a: 'z' } }));
    expect(afterCreate).toEqual({ table: 't', rowId: 'r', fields: {}, deleted: { seq: 2 } });
  });

  test('re-applying the same entry is idempotent', () => {
    const create = entry(1, { kind: 'create', table: 't', rowId: 'r', fields: { a: 'x' } } as const);
    const once = applyEntry(undefined, create);
    const twice = applyEntry(structuredClone(once), create);
    expect(twice).toEqual(once);
  });
});
