// ServerStorage over node:sqlite (synchronous, like DO SQLite — ADR-007).
// One database per workspace. The tx wrapper is a real SQLite transaction:
// a crash mid-step loses the whole step, never half (adapter contract).
import { DatabaseSync } from 'node:sqlite';
import type { EpochState, LogEntry, Op, RowState } from '@syncline/protocol';
import type { ServerStorage } from '@syncline/server';

export const createSqliteStorage = (path: string): ServerStorage => {
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS ops (seq INTEGER PRIMARY KEY, clientId TEXT NOT NULL, opId INTEGER NOT NULL, op TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS rows (tbl TEXT NOT NULL, rowId TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY (tbl, rowId));
    CREATE TABLE IF NOT EXISTS marks (clientId TEXT PRIMARY KEY, opId INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS owners (clientId TEXT PRIMARY KEY, userId TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS epochs (userId TEXT PRIMARY KEY, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS dir_outbox (id INTEGER PRIMARY KEY AUTOINCREMENT, change TEXT NOT NULL);
  `);

  const stmt = {
    appendOp: db.prepare('INSERT INTO ops (clientId, opId, op) VALUES (?, ?, ?)'),
    opsSince: db.prepare('SELECT seq, clientId, opId, op FROM ops WHERE seq > ? ORDER BY seq LIMIT ?'),
    head: db.prepare('SELECT COALESCE(MAX(seq), 0) AS head FROM ops'),
    getRow: db.prepare('SELECT data FROM rows WHERE tbl = ? AND rowId = ?'),
    putRow: db.prepare('INSERT INTO rows (tbl, rowId, data) VALUES (?, ?, ?) ON CONFLICT (tbl, rowId) DO UPDATE SET data = excluded.data'),
    scanRows: db.prepare('SELECT data FROM rows'),
    getMark: db.prepare('SELECT opId FROM marks WHERE clientId = ?'),
    setMark: db.prepare('INSERT INTO marks (clientId, opId) VALUES (?, ?) ON CONFLICT (clientId) DO UPDATE SET opId = excluded.opId'),
    setOwner: db.prepare('INSERT INTO owners (clientId, userId) VALUES (?, ?) ON CONFLICT (clientId) DO UPDATE SET userId = excluded.userId'),
    clearMarks: db.prepare('DELETE FROM marks WHERE clientId IN (SELECT clientId FROM owners WHERE userId = ?)'),
    getEpoch: db.prepare('SELECT data FROM epochs WHERE userId = ?'),
    setEpoch: db.prepare('INSERT INTO epochs (userId, data) VALUES (?, ?) ON CONFLICT (userId) DO UPDATE SET data = excluded.data'),
    getMeta: db.prepare('SELECT v FROM meta WHERE k = ?'),
    setMeta: db.prepare('INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v'),
    enqueueDir: db.prepare('INSERT INTO dir_outbox (change) VALUES (?)'),
    peekDir: db.prepare('SELECT id, change FROM dir_outbox ORDER BY id LIMIT ?'),
    ackDir: db.prepare('DELETE FROM dir_outbox WHERE id = ?'),
  };

  let inTx = false;

  return {
    appendOp(clientId: string, opId: number, op: Op): number {
      const result = stmt.appendOp.run(clientId, opId, JSON.stringify(op));
      return Number(result.lastInsertRowid);
    },
    getOpsSince(seq: number, limit: number): LogEntry[] {
      return (stmt.opsSince.all(seq, limit) as { seq: number; clientId: string; opId: number; op: string }[]).map(
        (r) => ({ seq: r.seq, clientId: r.clientId, opId: r.opId, op: JSON.parse(r.op) as Op }),
      );
    },
    headSeq(): number {
      return (stmt.head.get() as { head: number }).head;
    },
    getRow(table: string, rowId: string): RowState | undefined {
      const r = stmt.getRow.get(table, rowId) as { data: string } | undefined;
      return r === undefined ? undefined : (JSON.parse(r.data) as RowState);
    },
    putRow(row: RowState): void {
      stmt.putRow.run(row.table, row.rowId, JSON.stringify(row));
    },
    scanRows(): RowState[] {
      return (stmt.scanRows.all() as { data: string }[]).map((r) => JSON.parse(r.data) as RowState);
    },
    getClientMark(clientId: string): number {
      return (stmt.getMark.get(clientId) as { opId: number } | undefined)?.opId ?? 0;
    },
    setClientMark(clientId: string, opId: number): void {
      stmt.setMark.run(clientId, opId);
    },
    setClientOwner(clientId: string, userId: string): void {
      stmt.setOwner.run(clientId, userId);
    },
    clearMarksForUser(userId: string): void {
      stmt.clearMarks.run(userId);
    },
    getEpoch(userId: string): EpochState {
      const r = stmt.getEpoch.get(userId) as { data: string } | undefined;
      return r === undefined ? { epoch: 0 } : (JSON.parse(r.data) as EpochState);
    },
    setEpoch(userId: string, state: EpochState): void {
      stmt.setEpoch.run(userId, JSON.stringify(state));
    },
    getMeta(key: string): string | undefined {
      return (stmt.getMeta.get(key) as { v: string } | undefined)?.v;
    },
    setMeta(key: string, value: string): void {
      stmt.setMeta.run(key, value);
    },
    enqueueDirectory(change: string): void {
      stmt.enqueueDir.run(change);
    },
    peekDirectory(limit: number): { id: number; change: string }[] {
      return stmt.peekDir.all(limit) as { id: number; change: string }[];
    },
    ackDirectory(id: number): void {
      stmt.ackDir.run(id);
    },
    tx<T>(fn: () => T): T {
      if (inTx) return fn(); // nested: already inside the step's transaction
      db.exec('BEGIN IMMEDIATE');
      inTx = true;
      try {
        const out = fn();
        db.exec('COMMIT');
        return out;
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      } finally {
        inTx = false;
      }
    },
  };
};
