// Per-field LWW keyed on server seq (ADR-005): one implementation shared by
// server apply, client apply, and the harness so they cannot diverge.
import type { FieldStamp, LogEntry, RowState } from './types.js';

/** The LWW rule: higher seq wins; equal/lower is a stale or duplicate write. */
export const mergeField = (
  current: FieldStamp | undefined,
  incoming: FieldStamp,
): FieldStamp => (incoming.seq > (current?.seq ?? 0) ? incoming : current as FieldStamp);

/**
 * Apply one log entry to a materialized row. Pure, idempotent under
 * re-application, and safe under cross-path merges (snapshot + incremental
 * joins): every mutation is guarded by seq comparison, and delete
 * tombstones win regardless of later-arriving lower-seq field writes.
 * Returns the next row state (undefined stays undefined only for updates
 * to never-seen rows of a `delete`).
 */
export const applyEntry = (
  row: RowState | undefined,
  entry: LogEntry,
): RowState | undefined => {
  const { seq, op } = entry;
  switch (op.kind) {
    case 'create': {
      if (row?.deleted !== undefined) return row; // deletes win; ids never recreate
      const next: RowState = row ?? { table: op.table, rowId: op.rowId, fields: {} };
      for (const [name, v] of Object.entries(op.fields)) {
        next.fields[name] = mergeField(next.fields[name], { v, seq });
      }
      return next;
    }
    case 'update': {
      if (row?.deleted !== undefined) return row;
      const next: RowState = row ?? { table: op.table, rowId: op.rowId, fields: {} };
      next.fields[op.field] = mergeField(next.fields[op.field], { v: op.value, seq });
      return next;
    }
    case 'delete': {
      if (row?.deleted !== undefined) return row; // first tombstone stands
      return { table: op.table, rowId: op.rowId, fields: {}, deleted: { seq } };
    }
  }
};

/** Plain values of a row (stamps stripped) — the shape rule predicates see. */
export const rowValues = (row: RowState): Record<string, RowState['fields'][string]['v']> => {
  const out: Record<string, RowState['fields'][string]['v']> = {};
  for (const [name, stamp] of Object.entries(row.fields)) out[name] = stamp.v;
  return out;
};
