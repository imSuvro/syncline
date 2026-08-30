// ServerStorage over Durable Object SQLite (ADR-007). Synchronous by
// design — ctx.storage.sql.exec is sync, transactionSync gives the tx
// contract, and the DO output gate releases sends only after writes are
// durable.
import type { EpochState, LogEntry, Op, RowState } from '@syncline/protocol';
import type { ServerStorage } from '@syncline/server';

export const initSchema = (sql: SqlStorage): void => {
  sql.exec(`
    CREATE TABLE IF NOT EXISTS ops (seq INTEGER PRIMARY KEY AUTOINCREMENT, clientId TEXT NOT NULL, opId INTEGER NOT NULL, op TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS rows (tbl TEXT NOT NULL, rowId TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY (tbl, rowId));
    CREATE TABLE IF NOT EXISTS marks (clientId TEXT PRIMARY KEY, opId INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS owners (clientId TEXT PRIMARY KEY, userId TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS epochs (userId TEXT PRIMARY KEY, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS dir_outbox (id INTEGER PRIMARY KEY AUTOINCREMENT, change TEXT NOT NULL);
  `);
};

export const createDoStorage = (ctx: DurableObjectState): ServerStorage => {
  const sql = ctx.storage.sql;

  const one = <T>(query: string, ...binds: unknown[]): T | undefined =>
    (sql.exec(query, ...(binds as (string | number)[])).toArray() as T[])[0];
  const all = <T>(query: string, ...binds: unknown[]): T[] =>
    sql.exec(query, ...(binds as (string | number)[])).toArray() as T[];

  return {
    appendOp(clientId: string, opId: number, op: Op): number {
      sql.exec('INSERT INTO ops (clientId, opId, op) VALUES (?, ?, ?)', clientId, opId, JSON.stringify(op));
      return (one<{ seq: number }>('SELECT MAX(seq) AS seq FROM ops') as { seq: number }).seq;
    },
    getOpsSince(seq: number, limit: number): LogEntry[] {
      return all<{ seq: number; clientId: string; opId: number; op: string }>(
        'SELECT seq, clientId, opId, op FROM ops WHERE seq > ? ORDER BY seq LIMIT ?',
        seq,
        limit,
      ).map((r) => ({ seq: r.seq, clientId: r.clientId, opId: r.opId, op: JSON.parse(r.op) as Op }));
    },
    headSeq(): number {
      return (one<{ head: number }>('SELECT COALESCE(MAX(seq), 0) AS head FROM ops') as { head: number }).head;
    },
    getRow(table: string, rowId: string): RowState | undefined {
      const r = one<{ data: string }>('SELECT data FROM rows WHERE tbl = ? AND rowId = ?', table, rowId);
      return r === undefined ? undefined : (JSON.parse(r.data) as RowState);
    },
    putRow(row: RowState): void {
      sql.exec(
        'INSERT INTO rows (tbl, rowId, data) VALUES (?, ?, ?) ON CONFLICT (tbl, rowId) DO UPDATE SET data = excluded.data',
        row.table,
        row.rowId,
        JSON.stringify(row),
      );
    },
    scanRows(): RowState[] {
      return all<{ data: string }>('SELECT data FROM rows').map((r) => JSON.parse(r.data) as RowState);
    },
    getClientMark(clientId: string): number {
      return one<{ opId: number }>('SELECT opId FROM marks WHERE clientId = ?', clientId)?.opId ?? 0;
    },
    setClientMark(clientId: string, opId: number): void {
      sql.exec('INSERT INTO marks (clientId, opId) VALUES (?, ?) ON CONFLICT (clientId) DO UPDATE SET opId = excluded.opId', clientId, opId);
    },
    setClientOwner(clientId: string, userId: string): void {
      sql.exec('INSERT INTO owners (clientId, userId) VALUES (?, ?) ON CONFLICT (clientId) DO UPDATE SET userId = excluded.userId', clientId, userId);
    },
    getClientOwner(clientId: string): string | undefined {
      return one<{ userId: string }>('SELECT userId FROM owners WHERE clientId = ?', clientId)?.userId;
    },
    clearMarksForUser(userId: string): void {
      sql.exec('DELETE FROM marks WHERE clientId IN (SELECT clientId FROM owners WHERE userId = ?)', userId);
    },
    getEpoch(userId: string): EpochState {
      const r = one<{ data: string }>('SELECT data FROM epochs WHERE userId = ?', userId);
      return r === undefined ? { epoch: 0 } : (JSON.parse(r.data) as EpochState);
    },
    setEpoch(userId: string, state: EpochState): void {
      sql.exec('INSERT INTO epochs (userId, data) VALUES (?, ?) ON CONFLICT (userId) DO UPDATE SET data = excluded.data', userId, JSON.stringify(state));
    },
    getMeta(key: string): string | undefined {
      return one<{ v: string }>('SELECT v FROM meta WHERE k = ?', key)?.v;
    },
    setMeta(key: string, value: string): void {
      sql.exec('INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v', key, value);
    },
    enqueueDirectory(change: string): void {
      sql.exec('INSERT INTO dir_outbox (change) VALUES (?)', change);
    },
    peekDirectory(limit: number): { id: number; change: string }[] {
      return all<{ id: number; change: string }>('SELECT id, change FROM dir_outbox ORDER BY id LIMIT ?', limit);
    },
    ackDirectory(id: number): void {
      sql.exec('DELETE FROM dir_outbox WHERE id = ?', id);
    },
    tx<T>(fn: () => T): T {
      return ctx.storage.transactionSync(fn);
    },
  };
};
