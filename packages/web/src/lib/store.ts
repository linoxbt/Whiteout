/** A small IndexedDB key-value store: ciphertext cache and decrypted tiles (local only). */

const DB = 'whiteout';
const STORE = 'kv';
let dbp: Promise<IDBDatabase> | null = null;

function db(): Promise<IDBDatabase> {
  if (typeof indexedDB === 'undefined') return Promise.reject(new Error('no IndexedDB'));
  dbp ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}

/** Recent values only: IndexedDB holds everything, this just saves a read. */
const MEMORY_MAX = 2000;
const memory = new Map<string, unknown>();
function remember(key: string, value: unknown) {
  memory.delete(key);
  memory.set(key, value);
  if (memory.size > MEMORY_MAX) memory.delete(memory.keys().next().value!);
}

export async function kvGet<T>(key: string): Promise<T | undefined> {
  if (memory.has(key)) return memory.get(key) as T;
  try {
    const d = await db();
    return await new Promise<T | undefined>((resolve, reject) => {
      const r = d.transaction(STORE).objectStore(STORE).get(key);
      r.onsuccess = () => resolve(r.result as T | undefined);
      r.onerror = () => reject(r.error);
    });
  } catch {
    return undefined;
  }
}

export async function kvSet(key: string, value: unknown): Promise<void> {
  remember(key, value);
  try {
    const d = await db();
    await new Promise<void>((resolve, reject) => {
      const t = d.transaction(STORE, 'readwrite');
      t.objectStore(STORE).put(value, key);
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error);
    });
  } catch {
    /* memory only */
  }
}
