// The frozen vocabulary of ADR-002/003/005. Everything that crosses the
// protocol boundary is defined here; server, client, harness, and the demo
// schema compile against these types and nothing else.

/** Workspace membership role, ordered viewer < editor < owner. */
export type Role = 'owner' | 'editor' | 'viewer';

/** Identity as the sync layer sees it. Role is read live per workspace —
 * never carried in tokens or attachments (ADR-003). */
export interface Principal {
  readonly userId: string;
  readonly role: Role;
}

/** Field values are JSON scalars; structure lives in rows, not values. */
export type FieldValue = string | number | boolean | null;

/** A field with its last-writer stamp: the server seq that wrote it (ADR-005). */
export interface FieldStamp {
  v: FieldValue;
  seq: number;
}

/** Materialized row state with per-field stamps. A deleted row keeps only
 * its tombstone: deletes win and rowIds are never recreated (ADR-005). */
export interface RowState {
  table: string;
  rowId: string;
  fields: Record<string, FieldStamp>;
  deleted?: { seq: number };
}

/** The op payload vocabulary (ADR-002): one field per update op. */
export type Op =
  | { kind: 'create'; table: string; rowId: string; fields: Record<string, FieldValue> }
  | { kind: 'update'; table: string; rowId: string; field: string; value: FieldValue }
  | { kind: 'delete'; table: string; rowId: string };

/** An op as pushed: client-scoped identity + the schema version its payload
 * speaks (ADR-006). opId is gapless per (clientId, workspaceId). */
export interface PushedOp {
  opId: number;
  baseSchemaVersion: number;
  op: Op;
}

/** An op as appended: server-assigned total order within the workspace. */
export interface LogEntry {
  seq: number;
  clientId: string;
  opId: number;
  op: Op;
}

/** Per-principal visibility epoch (ADR-002/004): bumped when the visible
 * slice definition changes. Scoped per (userId, workspaceId). */
export interface EpochState {
  epoch: number;
  /** Set while the principal is revoked: the seq the forget covers. */
  revokedUpToSeq?: number;
}

export const PROTOCOL_VERSION = 1;
