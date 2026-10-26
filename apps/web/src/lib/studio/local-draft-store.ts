import {
  buildRecord,
  recordToDraft,
  resolveReset,
  resolveSave,
  type LoadOutcome,
  type ResetOutcome,
  type SaveOutcome,
  type StudioDraftRepository,
  type StoredDraftRecord,
} from './draft-store';

/**
 * KYN-17 — local backends for the draft repository.
 *
 * IndexedDB backend: one database (`kyneloom-studio`), one object store
 * keyed by draftId. The compare-and-save runs inside a SINGLE `readwrite`
 * transaction — IndexedDB serializes readwrite transactions per store across
 * connections, so two tabs over the same database cannot interleave a
 * read-modify-write: the revision check and the write commit atomically.
 *
 * Memory backend: the same law over a shared map — also the test double for
 * two concurrent "tabs" (two repository facades over one backend) and the
 * honest fallback where IndexedDB is unavailable.
 */

const DB_NAME = 'kyneloom-studio';
const DB_VERSION = 1;
const STORE = 'drafts';

/** Shared in-memory backend — inject one instance to simulate concurrent tabs. */
export interface MemoryDraftBackend {
  get(draftId: string): StoredDraftRecord | null;
  put(record: StoredDraftRecord): void;
  delete(draftId: string): void;
  clear(): void;
}

export function createMemoryDraftBackend(): MemoryDraftBackend {
  const records = new Map<string, StoredDraftRecord>();
  return {
    get: (draftId) => records.get(draftId) ?? null,
    put: (record) => {
      records.set(record.draftId, record);
    },
    delete: (draftId) => {
      records.delete(draftId);
    },
    clear: () => {
      records.clear();
    },
  };
}

export function createMemoryDraftRepository(
  backend: MemoryDraftBackend = createMemoryDraftBackend(),
): StudioDraftRepository {
  return {
    async load(draftId) {
      const record = backend.get(draftId);
      if (record === null) return null;
      return recordToDraft(record);
    },
    async save(draft, expectedRevision) {
      const stored = backend.get(draft.draftId);
      const outcome = resolveSave(stored, expectedRevision);
      if (!outcome.proceed) {
        return { ok: false, kind: 'conflict', currentRevision: outcome.currentRevision };
      }
      backend.put(buildRecord(draft, expectedRevision + 1));
      return { ok: true, revision: expectedRevision + 1 };
    },
    async reset(draftId, expectedRevision) {
      const outcome = resolveReset(backend.get(draftId), expectedRevision);
      if (!outcome.proceed) {
        return { ok: false, kind: 'conflict', currentRevision: outcome.currentRevision };
      }
      backend.delete(draftId);
      return { ok: true };
    },
  };
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('indexeddb request failed'));
  });
}

/** Open (and migrate — currently v1 only) the Studio draft database. */
function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'draftId' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('indexeddb open failed'));
  });
}

export function createIndexedDbDraftRepository(): StudioDraftRepository {
  let dbPromise: Promise<IDBDatabase> | null = null;
  const db = (): Promise<IDBDatabase> => {
    if (dbPromise === null) dbPromise = openDatabase();
    return dbPromise;
  };
  return {
    async load(draftId) {
      const database = await db();
      const transaction = database.transaction(STORE, 'readonly');
      const record = await requestToPromise(
        transaction.objectStore(STORE).get(draftId) as IDBRequest<unknown>,
      );
      if (record === undefined || record === null) return null;
      return recordToDraft(record);
    },
    async save(draft, expectedRevision) {
      const database = await db();
      // ONE readwrite transaction: get + check + put commit or abort together,
      // and IndexedDB serializes it against every other tab's transaction.
      const transaction = database.transaction(STORE, 'readwrite');
      const store = transaction.objectStore(STORE);
      const stored = (await requestToPromise(store.get(draft.draftId) as IDBRequest<unknown>)) as
        { revision: unknown } | null | undefined;
      const outcome = resolveSave(
        stored === undefined || stored === null
          ? null
          : typeof stored.revision === 'number'
            ? { revision: stored.revision }
            : null,
        expectedRevision,
      );
      if (!outcome.proceed) {
        transaction.abort();
        return { ok: false, kind: 'conflict', currentRevision: outcome.currentRevision };
      }
      await new Promise<void>((resolve, reject) => {
        transaction.oncomplete = () => resolve();
        transaction.onabort = () =>
          reject(transaction.error ?? new Error('indexeddb save aborted'));
        transaction.onerror = () => reject(transaction.error ?? new Error('indexeddb save failed'));
        store.put(buildRecord(draft, expectedRevision + 1));
      });
      return { ok: true, revision: expectedRevision + 1 };
    },
    async reset(draftId, expectedRevision) {
      const database = await db();
      // ONE readwrite transaction: get + revision check + delete commit (or
      // abort) together — serialized against every other tab's transaction,
      // exactly like save. The delete only commits when the stored revision
      // still equals the one the user confirmed discarding.
      const transaction = database.transaction(STORE, 'readwrite');
      const store = transaction.objectStore(STORE);
      const stored = (await requestToPromise(store.get(draftId) as IDBRequest<unknown>)) as
        { revision: unknown } | null | undefined;
      const outcome = resolveReset(
        stored === undefined || stored === null
          ? null
          : typeof stored.revision === 'number'
            ? { revision: stored.revision }
            : null,
        expectedRevision,
      );
      if (!outcome.proceed) {
        transaction.abort();
        return { ok: false, kind: 'conflict', currentRevision: outcome.currentRevision };
      }
      await new Promise<void>((resolve, reject) => {
        transaction.oncomplete = () => resolve();
        transaction.onabort = () =>
          reject(transaction.error ?? new Error('indexeddb reset aborted'));
        transaction.onerror = () =>
          reject(transaction.error ?? new Error('indexeddb reset failed'));
        store.delete(draftId);
      });
      return { ok: true };
    },
  };
}

/**
 * The session-fallback backend where IndexedDB is unavailable: ONE shared
 * map per page session (two component instances over one store — the same
 * shape as two tabs over one database).
 */
const memoryFallbackBackend = createMemoryDraftBackend();

/** Test seam: wipe the session fallback between tests. */
export function resetMemoryDraftBackendForTests(): void {
  memoryFallbackBackend.clear();
}

/**
 * The local demonstration backend used by /studio: IndexedDB where the
 * browser provides it (durable across sessions in THIS browser), the shared
 * session-memory fallback where it does not.
 */
export function createLocalDraftRepository(): StudioDraftRepository & {
  readonly backend: 'indexeddb' | 'memory';
} {
  const hasIndexedDb = typeof indexedDB !== 'undefined';
  const repository = hasIndexedDb
    ? createIndexedDbDraftRepository()
    : createMemoryDraftRepository(memoryFallbackBackend);
  return Object.assign(repository, {
    backend: hasIndexedDb ? ('indexeddb' as const) : ('memory' as const),
  });
}

export type { LoadOutcome, ResetOutcome, SaveOutcome, StudioDraftRepository };
