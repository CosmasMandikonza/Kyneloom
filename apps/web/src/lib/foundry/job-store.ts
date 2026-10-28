/**
 * KYN-15 — the durable job store port.
 *
 * Production: `createBlobJobStore` uses Azure Blob Storage with conditional
 * puts (If-None-Match / If-Match) — a compact, inspectable, resumable job
 * ledger SEPARATE from KYN-14's authoritative match archive. When storage
 * credentials are absent it FAILS CLOSED (`unavailable`): production
 * durability is never simulated. Tests use `createInMemoryJobStore`, which
 * is a TEST DOUBLE — never described as cross-process durability.
 */

import { createHash } from 'node:crypto';
import type { FoundryJobRecord } from './types';

export type JobStoreOutcome =
  | { readonly ok: true; readonly record: FoundryJobRecord }
  | { readonly ok: false; readonly kind: 'conflict'; readonly existing: FoundryJobRecord }
  | { readonly ok: false; readonly kind: 'unavailable'; readonly message: string };

export interface FoundryJobStore {
  /** Create-if-absent keyed by idempotency key (conditional write). */
  createIfAbsent(record: FoundryJobRecord): Promise<JobStoreOutcome>;
  /** Read a job by id. */
  load(jobId: string): Promise<FoundryJobRecord | null>;
  /** Read a job by idempotency key. */
  findByIdempotencyKey(key: string): Promise<FoundryJobRecord | null>;
  /** Optimistic-concurrency update: succeeds only when expectedPhase matches. */
  compareAndSwap(record: FoundryJobRecord, expectedPhase: string): Promise<JobStoreOutcome>;
}

export function idempotencyKeyFor(
  prompt: string,
  sourceHash: string,
  reducerRevision: number,
): string {
  return createHash('sha256')
    .update(`${prompt}\u0000${sourceHash}\u0000${String(reducerRevision)}`)
    .digest('hex')
    .slice(0, 32);
}

export function newJobId(): string {
  return `job-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// ---------------------------------------------------------------------------
// Production durable store: NOT IMPLEMENTED (review 6458967638, honest
// option b). The previously sketched Blob conditional-write store was
// removed: it was untested against real Azure Storage, used a synthetic
// If-Match value instead of a real Blob ETag, and never wrote the
// idempotency pointer it read. Building a real durable store requires
// authorized Azure Storage (owner approval; separate from KYN-14's
// archive). Until then production persistence FAILS CLOSED via this
// factory; durability/resume-after-interruption claims are deferred.
// ---------------------------------------------------------------------------

export function createProductionJobStore(): FoundryJobStore {
  const refuse = (): JobStoreOutcome => ({
    ok: false,
    kind: 'unavailable',
    message:
      'durable job persistence is NOT IMPLEMENTED: no authorized Azure Storage is configured. Production Foundry runs fail closed; wire an authorized conditional-write store to enable them (tracked for the post-KYN-14 hookup).',
  });
  const refuseLoad = (): null => null;
  return {
    createIfAbsent: async () => refuse(),
    load: async () => refuseLoad(),
    findByIdempotencyKey: async () => refuseLoad(),
    compareAndSwap: async () => refuse(),
  };
}

// ---------------------------------------------------------------------------
// TEST DOUBLE — tests only; NOT cross-process durability.
// ---------------------------------------------------------------------------

export function createInMemoryJobStore(): FoundryJobStore & {
  readonly records: Map<string, FoundryJobRecord>;
  readonly keys: Map<string, string>;
} {
  const records = new Map<string, FoundryJobRecord>();
  const keys = new Map<string, string>();
  return {
    records,
    keys,
    async createIfAbsent(record) {
      const existingId = keys.get(record.idempotencyKey);
      if (existingId !== undefined) {
        const existing = records.get(existingId);
        if (existing !== undefined) return { ok: false, kind: 'conflict', existing };
      }
      records.set(record.jobId, record);
      keys.set(record.idempotencyKey, record.jobId);
      return { ok: true, record };
    },
    async load(jobId) {
      return records.get(jobId) ?? null;
    },
    async findByIdempotencyKey(key) {
      const id = keys.get(key);
      return id === undefined ? null : (records.get(id) ?? null);
    },
    async compareAndSwap(record, expectedPhase) {
      const current = records.get(record.jobId);
      if (current === undefined) {
        return { ok: false, kind: 'unavailable', message: 'job not found' };
      }
      if (current.phase !== expectedPhase) {
        return { ok: false, kind: 'conflict', existing: current };
      }
      records.set(record.jobId, record);
      return { ok: true, record };
    },
  };
}
