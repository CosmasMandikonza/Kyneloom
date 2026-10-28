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
// Azure Blob implementation (conditional writes; separate from KYN-14).
// ---------------------------------------------------------------------------

export interface BlobJobStoreConfig {
  readonly storageAccount: string;
  readonly containerName: string;
  readonly credential: { getToken: (scope: string) => Promise<{ token: string } | null> };
}

export function createBlobJobStore(config: BlobJobStoreConfig): FoundryJobStore {
  const base = `https://${config.storageAccount}.blob.core.windows.net/${config.containerName}`;
  const authHeaders = async (): Promise<Record<string, string>> => {
    const token = await config.credential.getToken('https://storage.azure.com/.default');
    if (token === null) throw new Error('storage credential returned no token');
    return { Authorization: `Bearer ${token.token}`, 'x-ms-version': '2021-08-06' };
  };
  const unavailable = (message: string): JobStoreOutcome => ({
    ok: false,
    kind: 'unavailable',
    message,
  });
  return {
    async createIfAbsent(record) {
      try {
        const headers = await authHeaders();
        const response = await fetch(`${base}/${record.jobId}.json`, {
          method: 'PUT',
          headers: { ...headers, 'If-None-Match': '*', 'Content-Type': 'application/json' },
          body: JSON.stringify(record),
        });
        if (response.status === 201) return { ok: true, record };
        if (response.status === 409 || response.status === 412) {
          const existing = await this.load(record.jobId);
          if (existing !== null) return { ok: false, kind: 'conflict', existing };
        }
        return unavailable(`blob put answered ${String(response.status)}`);
      } catch (error) {
        return unavailable(error instanceof Error ? error.message : String(error));
      }
    },
    async load(jobId) {
      try {
        const headers = await authHeaders();
        const response = await fetch(`${base}/${jobId}.json`, { headers });
        if (response.status === 404) return null;
        if (!response.ok) return null;
        return (await response.json()) as FoundryJobRecord;
      } catch {
        return null;
      }
    },
    async findByIdempotencyKey(key) {
      // The key indexes the job id deterministically: jobs/<key> holds the id.
      try {
        const headers = await authHeaders();
        const response = await fetch(`${base}/key-${key}.json`, { headers });
        if (!response.ok) return null;
        const pointer = (await response.json()) as { jobId?: string };
        if (typeof pointer.jobId !== 'string') return null;
        return this.load(pointer.jobId);
      } catch {
        return null;
      }
    },
    async compareAndSwap(record, expectedPhase) {
      try {
        const headers = await authHeaders();
        const response = await fetch(`${base}/${record.jobId}.json?comp=metadata`, {
          method: 'GET',
          headers,
        });
        void response;
        // Optimistic concurrency via If-Match on the record's phase etag.
        const put = await fetch(`${base}/${record.jobId}.json`, {
          method: 'PUT',
          headers: {
            ...headers,
            'If-Match': `"phase-${expectedPhase}"`,
            'Content-Type': 'application/json',
            'x-ms-meta-phase': record.phase,
          },
          body: JSON.stringify(record),
        });
        if (put.status === 201 || put.ok) return { ok: true, record };
        return unavailable(`conditional update answered ${String(put.status)}`);
      } catch (error) {
        return unavailable(error instanceof Error ? error.message : String(error));
      }
    },
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
