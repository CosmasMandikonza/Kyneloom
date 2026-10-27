import {
  buildRecord,
  isTombstone,
  recordToDraft,
  resolveReset,
  resolveSave,
  validateEntryShape,
  type DraftConcurrencyToken,
  type DraftTombstoneRecord,
  type LoadOutcome,
  type ResetOutcome,
  type SaveOutcome,
  type StoredDraftEntry,
  type StoredDraftRecord,
  type StudioDraftRepository,
} from './draft-store';

/**
 * KYN-17 — local backends for the draft repository.
 *
 * IndexedDB backend: one database (`kyneloom-studio`), one object store
 * keyed by draftId holding EITHER the live record OR the lineage tombstone.
 * Every compare-and-save / compare-and-discard runs inside a SINGLE
 * `readwrite` transaction — IndexedDB serializes readwrite transactions per
 * store across connections, so two tabs over the same database cannot
 * interleave a read-modify-write: the full-token check and the write (or
 * tombstone) commit atomically.
 *
 * Memory backend: the same law over a shared map — also the test double for
 * concurrent "tabs" (two repository facades over one backend) and the honest
 * fallback where IndexedDB is unavailable.
 */

const DB_NAME = 'kyneloom-studio';
const DB_VERSION = 1;
const STORE = 'drafts';

/** Shared in-memory backend — inject one instance to simulate concurrent tabs. */
export interface MemoryDraftBackend {
  get(draftId: string): StoredDraftEntry | null;
  put(entry: StoredDraftEntry): void;
  clear(): void;
}

export function createMemoryDraftBackend(): MemoryDraftBackend {
  const entries = new Map<string, StoredDraftEntry>();
  return {
    get: (draftId) => entries.get(draftId) ?? null,
    put: (entry) => {
      entries.set(entry.draftId, entry);
    },
    clear: () => {
      entries.clear();
    },
  };
}

export function createMemoryDraftRepository(
  backend: MemoryDraftBackend = createMemoryDraftBackend(),
): StudioDraftRepository {
  return {
    async load(draftId) {
      const entry = backend.get(draftId);
      if (entry === null) {
        return { ok: true, kind: 'empty', token: { generation: 1, revision: 0 } };
      }
      const shape = validateEntryShape(entry, draftId);
      if (!shape.ok) return shape;
      if (isTombstone(entry)) return { ok: true, kind: 'empty', token: shape.token };
      return recordToDraft(entry);
    },
    async save(draft, expected) {
      const entry = backend.get(draft.draftId);
      if (entry !== null) {
        const shape = validateEntryShape(entry, draft.draftId);
        if (!shape.ok) {
          return { ok: false, kind: 'conflict', current: { generation: 1, revision: 0 } };
        }
      }
      const outcome = resolveSave(entry, expected);
      if (!outcome.proceed) {
        return { ok: false, kind: 'conflict', current: outcome.current };
      }
      backend.put(buildRecord(draft, outcome.token));
      return { ok: true, token: outcome.token };
    },
    async reset(draftId, expected) {
      const entry = backend.get(draftId);
      if (entry !== null) {
        const shape = validateEntryShape(entry, draftId);
        if (!shape.ok) {
          return { ok: false, kind: 'conflict', current: { generation: 1, revision: 0 } };
        }
      }
      const outcome = resolveReset(entry, expected);
      if (!outcome.proceed) {
        return { ok: false, kind: 'conflict', current: outcome.current };
      }
      if (outcome.tombstone !== null) backend.put(outcome.tombstone);
      // Derive the follow-up generation from the RESOLVED outcome (the raw
      // entry may be a legacy record without a generation field).
      const nextGeneration =
        entry === null
          ? expected.generation
          : (outcome.tombstone !== null
              ? outcome.tombstone.generation
              : (entry as { generation: number }).generation) + 1;
      return { ok: true, nextToken: { generation: nextGeneration, revision: 0 } };
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
      const entry = (await requestToPromise(
        transaction.objectStore(STORE).get(draftId) as IDBRequest<unknown>,
      )) as StoredDraftEntry | undefined;
      if (entry === undefined || entry === null) {
        return { ok: true, kind: 'empty', token: { generation: 1, revision: 0 } };
      }
      const shape = validateEntryShape(entry, draftId);
      if (!shape.ok) return shape;
      if (isTombstone(entry)) return { ok: true, kind: 'empty', token: shape.token };
      return recordToDraft(entry);
    },
    async save(draft, expected) {
      const database = await db();
      // ONE readwrite transaction: get + full-token check + put commit (or
      // abort) together, serialized against every other tab's transaction.
      const transaction = database.transaction(STORE, 'readwrite');
      const store = transaction.objectStore(STORE);
      const entry = (await requestToPromise(store.get(draft.draftId) as IDBRequest<unknown>)) as
        StoredDraftEntry | undefined;
      const stored = entry === undefined || entry === null ? null : entry;
      if (stored !== null) {
        const shape = validateEntryShape(stored, draft.draftId);
        if (!shape.ok) {
          transaction.abort();
          return { ok: false, kind: 'conflict', current: { generation: 1, revision: 0 } };
        }
      }
      const outcome = resolveSave(stored, expected);
      if (!outcome.proceed) {
        transaction.abort();
        return { ok: false, kind: 'conflict', current: outcome.current };
      }
      await new Promise<void>((resolve, reject) => {
        transaction.oncomplete = () => resolve();
        transaction.onabort = () =>
          reject(transaction.error ?? new Error('indexeddb save aborted'));
        transaction.onerror = () => reject(transaction.error ?? new Error('indexeddb save failed'));
        store.put(buildRecord(draft, outcome.token));
      });
      return { ok: true, token: outcome.token };
    },
    async reset(draftId, expected) {
      const database = await db();
      // ONE readwrite transaction: get + full-token check + tombstone write
      // (or abort) together — the discard never erases the generation record.
      const transaction = database.transaction(STORE, 'readwrite');
      const store = transaction.objectStore(STORE);
      const entry = (await requestToPromise(store.get(draftId) as IDBRequest<unknown>)) as
        StoredDraftEntry | undefined;
      const stored = entry === undefined || entry === null ? null : entry;
      if (stored !== null) {
        const shape = validateEntryShape(stored, draftId);
        if (!shape.ok) {
          transaction.abort();
          return { ok: false, kind: 'conflict', current: { generation: 1, revision: 0 } };
        }
      }
      const outcome = resolveReset(stored, expected);
      if (!outcome.proceed) {
        transaction.abort();
        return { ok: false, kind: 'conflict', current: outcome.current };
      }
      if (outcome.tombstone !== null) {
        await new Promise<void>((resolve, reject) => {
          transaction.oncomplete = () => resolve();
          transaction.onabort = () =>
            reject(transaction.error ?? new Error('indexeddb reset aborted'));
          transaction.onerror = () =>
            reject(transaction.error ?? new Error('indexeddb reset failed'));
          store.put(outcome.tombstone);
        });
      }
      // Nothing to write when the entry was already a tombstone (idempotent
      // no-op for the follow-up lineage's fresh token) — the read-only
      // transaction commits harmlessly.
      const nextGeneration =
        stored === null
          ? expected.generation
          : (outcome.tombstone !== null
              ? outcome.tombstone.generation
              : (stored as { generation: number }).generation) + 1;
      return { ok: true, nextToken: { generation: nextGeneration, revision: 0 } };
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

export type {
  DraftConcurrencyToken,
  DraftTombstoneRecord,
  LoadOutcome,
  ResetOutcome,
  SaveOutcome,
  StoredDraftEntry,
  StoredDraftRecord,
  StudioDraftRepository,
};
