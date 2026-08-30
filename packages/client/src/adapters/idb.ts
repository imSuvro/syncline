// IndexedDB adapter: a single 'kv' object store per (workspace, client).
// applyBatch is one IDB transaction — atomic; its completion event is the
// durability point the core's barriers order sends against (ADR-001).
import type { StorageRecord } from '../core/types.js';

export interface ClientStorage {
  loadAll(): Promise<Map<string, string>>;
  /** Atomic batch; resolves at transaction completion (durable). */
  applyBatch(records: StorageRecord[]): Promise<void>;
}

export const createIdbStorage = (dbName: string): ClientStorage => {
  const open = (): Promise<IDBDatabase> =>
    new Promise((resolve, reject) => {
      const req = indexedDB.open(dbName, 1);
      req.onupgradeneeded = () => {
        req.result.createObjectStore('kv');
      };
      req.onsuccess = () => {
        resolve(req.result);
      };
      req.onerror = () => {
        reject(req.error as Error);
      };
    });
  const dbPromise = open();

  return {
    async loadAll(): Promise<Map<string, string>> {
      const db = await dbPromise;
      return new Promise((resolve, reject) => {
        const tx = db.transaction('kv', 'readonly');
        const store = tx.objectStore('kv');
        const out = new Map<string, string>();
        const cursorReq = store.openCursor();
        cursorReq.onsuccess = () => {
          const cursor = cursorReq.result;
          if (cursor !== null) {
            out.set(String(cursor.key), String(cursor.value));
            cursor.continue();
          } else {
            resolve(out);
          }
        };
        cursorReq.onerror = () => {
          reject(cursorReq.error as Error);
        };
      });
    },

    async applyBatch(records: StorageRecord[]): Promise<void> {
      const db = await dbPromise;
      return new Promise((resolve, reject) => {
        const tx = db.transaction('kv', 'readwrite');
        const store = tx.objectStore('kv');
        for (const record of records) {
          if ('clearAll' in record) store.clear();
          else if (record.value === null) store.delete(record.key);
          else store.put(record.value, record.key);
        }
        tx.oncomplete = () => {
          resolve();
        };
        tx.onerror = () => {
          reject(tx.error as Error);
        };
        tx.onabort = () => {
          reject(tx.error ?? new Error('idb transaction aborted'));
        };
      });
    },
  };
};

/** In-memory ClientStorage — SSR fallback and unit tests in the browser
 * package itself (the harness has its own crash-simulating fake). */
export const createMemoryClientStorage = (): ClientStorage => {
  const map = new Map<string, string>();
  return {
    loadAll: () => Promise.resolve(new Map(map)),
    applyBatch: (records) => {
      for (const record of records) {
        if ('clearAll' in record) map.clear();
        else if (record.value === null) map.delete(record.key);
        else map.set(record.key, record.value);
      }
      return Promise.resolve();
    },
  };
};
