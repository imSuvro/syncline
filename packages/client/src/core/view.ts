// The optimistic view (ADR-005): base (server-confirmed) with the outbox
// replayed on top. Queries are computed on demand — at demo scale the
// materialization cost is negligible, and the honest scale ceiling is
// documented in docs/writeup.md.
import { rowValues, type FieldValue } from '@syncline/protocol';
import { rowKey, type ClientState } from './types.js';

export interface ViewRow {
  table: string;
  rowId: string;
  values: Record<string, FieldValue>;
  /** True while any of this row's fields ride the outbox (pending ack). */
  pending: boolean;
}

/** All live rows of one table, overlay applied, stable rowId order. */
export const queryTable = (state: ClientState, table: string): ViewRow[] => {
  const merged = new Map<string, { values: Record<string, FieldValue>; pending: boolean; deleted: boolean }>();
  for (const [key, row] of state.base) {
    if (row.table !== table) continue;
    merged.set(key, { values: rowValues(row), pending: false, deleted: row.deleted !== undefined });
  }
  for (const p of state.outbox) {
    if (p.op.table !== table) continue;
    const key = rowKey(p.op.table, p.op.rowId);
    switch (p.op.kind) {
      case 'create':
        merged.set(key, { values: { ...p.op.fields }, pending: true, deleted: false });
        break;
      case 'update': {
        // An update to a row the base has not seen yet (offline edit
        // replayed after a purge, or a create still queued behind it) still
        // belongs on screen: the author wrote it, so they must see it.
        const entry = merged.get(key) ?? { values: {}, pending: true, deleted: false };
        if (!entry.deleted) {
          entry.values = { ...entry.values, [p.op.field]: p.op.value };
          entry.pending = true;
          merged.set(key, entry);
        }
        break;
      }
      case 'delete': {
        const entry = merged.get(key);
        if (entry !== undefined) entry.deleted = true;
        break;
      }
    }
  }
  const out: ViewRow[] = [];
  for (const [key, entry] of merged) {
    if (entry.deleted) continue;
    const rowId = key.slice(table.length + 1);
    out.push({ table, rowId, values: entry.values, pending: entry.pending });
  }
  out.sort((a, b) => a.rowId.localeCompare(b.rowId));
  return out;
};

/** Outbox length — the pending-ops badge (docs/ux.md). */
export const pendingCount = (state: ClientState): number => state.outbox.length;
