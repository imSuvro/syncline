// The single evaluation point (ADR-003): every outbound data payload is
// constructed HERE and only here, from a live-read principal, via
// protocol.evaluate. The branded Permitted type makes a bypass a type
// error; the stage-11 grep-test makes it a CI error too.
import {
  evaluate,
  rowValues,
  type LogEntry,
  type Principal,
  type RowState,
  type Ruleset,
} from '@syncline/protocol';

declare const PERMITTED: unique symbol;
/** A payload that passed the evaluator for a specific principal. */
export type Permitted<T> = T & { readonly [PERMITTED]: true };

const brand = <T>(value: T): Permitted<T> => value as Permitted<T>;

/**
 * Filter + mask one log entry for one principal. Returns null when the
 * principal may not see the row (or, for updates, the field). Deletes are
 * judged against the pre-delete row values (the caller supplies them),
 * because the tombstone itself carries no fields to judge.
 */
export const permitEntryFor = (
  ruleset: Ruleset,
  principal: Principal,
  entry: LogEntry,
  judgeRow: RowState | undefined,
): Permitted<LogEntry> | null => {
  const values = judgeRow === undefined ? {} : rowValues(judgeRow);
  const vis = evaluate(ruleset, principal, entry.op.table, values);
  if (!vis.read) return null;
  if (vis.fieldMask === undefined) return brand(entry);
  const mask = new Set(vis.fieldMask);
  switch (entry.op.kind) {
    case 'update':
      return mask.has(entry.op.field) ? brand(entry) : null;
    case 'create': {
      const fields = Object.fromEntries(
        Object.entries(entry.op.fields).filter(([name]) => mask.has(name)),
      );
      return brand({ ...entry, op: { ...entry.op, fields } });
    }
    case 'delete':
      return brand(entry);
  }
};

/** Filter + mask one materialized row for a snapshot. Tombstones are never
 * included in snapshots (ADR-002). */
export const permitRowFor = (
  ruleset: Ruleset,
  principal: Principal,
  row: RowState,
): Permitted<RowState> | null => {
  if (row.deleted !== undefined) return null;
  const vis = evaluate(ruleset, principal, row.table, rowValues(row));
  if (!vis.read) return null;
  if (vis.fieldMask === undefined) return brand({ ...row, fields: { ...row.fields } });
  const mask = new Set(vis.fieldMask);
  const fields = Object.fromEntries(
    Object.entries(row.fields).filter(([name]) => mask.has(name)),
  );
  return brand({ ...row, fields });
};
