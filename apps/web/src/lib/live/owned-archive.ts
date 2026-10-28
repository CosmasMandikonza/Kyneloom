import { createHash } from 'node:crypto';
import { isRestError, type ContainerClient } from '@azure/storage-blob';
import { canonicalJsonStringify } from '@kyneloom/contracts';
import type { StreamEnvelope } from '@kyneloom/match-core';
import type { AzureLiveConfig } from './azure-adapters';
import { createArchiveContainer, uploadImmutableBatch, type DurableArchive } from './blob-archive';

// One bounded commit document, NOT a second projection. Its array index is
// canonical receipt order. Only this leased + ETag-conditioned blob commits
// uploads; listing the batch prefix can NEVER make an orphan authoritative.
interface CommitRecord {
  version: 1;
  streamKey: string;
  generation: string;
  batches: string[];
}
const MAX_RECORD_BYTES = 4 * 1024 * 1024;
const LEASE_SECONDS = 60;
const LOCAL_VALID_MS = 45_000; // conservative, measured from request START

export interface OwnedArchiveOptions {
  signal?: AbortSignal;
  createContainer?: (config: AzureLiveConfig) => Promise<ContainerClient>;
  now?: () => number;
}

function parseRecord(bytes: Buffer, streamKey: string): CommitRecord {
  if (bytes.length > MAX_RECORD_BYTES) throw new Error('match commit record exceeds slice limit');
  const raw: unknown = JSON.parse(bytes.toString('utf-8'));
  if (typeof raw !== 'object' || raw === null) throw new Error('invalid match commit record');
  const value = raw as Record<string, unknown>;
  if (
    value.version !== 1 ||
    value.streamKey !== streamKey ||
    typeof value.generation !== 'string' ||
    !/^(0|[1-9][0-9]*)$/.test(value.generation) ||
    !Array.isArray(value.batches) ||
    !value.batches.every(
      (digest: unknown) => typeof digest === 'string' && /^[a-f0-9]{64}$/.test(digest),
    ) ||
    new Set(value.batches).size !== value.batches.length
  ) {
    throw new Error('invalid or mismatched match commit record');
  }
  return { version: 1, streamKey, generation: value.generation, batches: value.batches };
}

function waitForLease(signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const finish = (): void => {
      signal?.removeEventListener('abort', abort);
      resolve();
    };
    const timer = setTimeout(finish, 1000);
    const abort = (): void => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
  });
}

/** Production archive: acquire → recover committed prefix → upload → fenced commit. */
export async function acquireOwnedArchive(
  config: AzureLiveConfig,
  options: OwnedArchiveOptions = {},
): Promise<DurableArchive & { ownership: NonNullable<DurableArchive['ownership']> }> {
  const container = await (options.createContainer ?? createArchiveContainer)(config);
  const prefix = `${config.matchId}/`;
  const contentPrefix = `${prefix}batches-v2/`;
  const blob = container.getBlockBlobClient(`${prefix}commit-v1`);
  const streamKey = createHash('sha256')
    .update(
      canonicalJsonStringify({
        matchId: config.matchId,
        namespace: config.eventHubsNamespace,
        hub: config.eventHubName,
        group: config.consumerGroup,
        checkpoints: config.checkpointStorageContainerUrl,
      }),
    )
    .digest('hex');
  options.signal?.throwIfAborted();
  if (!(await blob.exists())) {
    // An absent record alongside history is not a fresh environment. Do not
    // silently treat a deleted commit record (or legacy history) as empty.
    for await (const item of container.listBlobsFlat({ prefix })) {
      if (item.name.endsWith('.json'))
        throw new Error('archive exists without commit record; offline migration/restore required');
    }
    const data = Buffer.from(
      canonicalJsonStringify({ version: 1, streamKey, generation: '0', batches: [] }),
    );
    try {
      await blob.upload(data, data.byteLength, { conditions: { ifNoneMatch: '*' } });
    } catch (error) {
      // Another startup may have created AND leased the record in between.
      if (!isRestError(error) || error.statusCode !== 412) throw error;
    }
  }
  const lease = blob.getBlobLeaseClient();
  const now = options.now ?? (() => performance.now());
  let validUntil = 0;
  for (;;) {
    options.signal?.throwIfAborted();
    const started = now();
    try {
      await lease.acquireLease(LEASE_SECONDS);
      validUntil = started + LOCAL_VALID_MS;
      break;
    } catch (error) {
      if (!isRestError(error) || error.statusCode !== 409 || error.code !== 'LeaseAlreadyPresent')
        throw error;
      await waitForLease(options.signal);
    }
  }

  const lost = new AbortController();
  let closing = false;
  let renewTimer: ReturnType<typeof setTimeout> | undefined;
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  let renewal: Promise<void> = Promise.resolve();
  let tail: Promise<void> = Promise.resolve();
  let record: CommitRecord;
  let etag: string;
  const lose = (reason: unknown): void => {
    clearTimeout(renewTimer);
    clearTimeout(deadlineTimer);
    if (!lost.signal.aborted) lost.abort(reason);
  };
  function assertLease(): void {
    if (closing || now() >= validUntil) lose(new Error('match ownership deadline expired'));
    lost.signal.throwIfAborted();
  }
  function assertOwned(): void {
    assertLease();
    options.signal?.throwIfAborted();
  }
  function armDeadline(): void {
    clearTimeout(deadlineTimer);
    deadlineTimer = setTimeout(
      () => lose(new Error('match ownership deadline expired')),
      Math.max(0, validUntil - now()),
    );
    deadlineTimer.unref();
  }
  function scheduleRenewal(): void {
    renewTimer = setTimeout(() => {
      renewal = (async () => {
        assertLease();
        const started = now();
        await lease.renewLease();
        assertLease(); // a late response must never resurrect a retired owner
        validUntil = started + LOCAL_VALID_MS;
        assertLease();
        armDeadline();
        scheduleRenewal();
      })().catch(lose);
    }, 10_000);
    renewTimer.unref();
  }
  async function close(): Promise<void> {
    // Caller stops and drains ingestion/broadcasts BEFORE relinquishing. Keep
    // renewals alive during tail drain. Never break somebody else's lease.
    await tail.catch(() => undefined);
    closing = true;
    clearTimeout(renewTimer);
    clearTimeout(deadlineTimer);
    await renewal;
    try {
      await lease.releaseLease();
    } catch (error) {
      if (!isRestError(error) || ![409, 412].includes(error.statusCode ?? 0)) throw error;
    } finally {
      lose(new Error('match ownership closed'));
    }
  }
  async function commit(next: CommitRecord): Promise<void> {
    assertOwned();
    const data = Buffer.from(canonicalJsonStringify(next));
    if (data.length > MAX_RECORD_BYTES) throw new Error('match commit record exceeds slice limit');
    // The lease fences THIS write at Storage. ETag also rejects a delayed
    // same-generation request after another commit. Never retry an uncertain
    // commit using a refreshed ETag: retire and recover from Storage instead.
    try {
      const response = await blob.upload(data, data.byteLength, {
        conditions: { leaseId: lease.leaseId, ifMatch: etag },
        blobHTTPHeaders: { blobContentType: 'application/json' },
      });
      if (!response.etag) throw new Error('commit response has no ETag');
      record = next;
      etag = response.etag;
      assertOwned();
    } catch (error) {
      lose(error);
      throw error;
    }
  }
  try {
    assertOwned();
    armDeadline();
    scheduleRenewal();
    const properties = await blob.getProperties({ conditions: { leaseId: lease.leaseId } });
    if (!properties.etag) throw new Error('commit record has no ETag');
    etag = properties.etag;
    record = parseRecord(
      await blob.downloadToBuffer(0, undefined, {
        conditions: { ifMatch: etag, leaseId: lease.leaseId },
      }),
      streamKey,
    );
    if (record.generation === '0') {
      // Never guess which pre-fencing objects were canonical. Existing legacy
      // readers remain available, but cutover requires a reviewed offline import.
      for await (const item of container.listBlobsFlat({ prefix })) {
        if (item.name.endsWith('.json') && !item.name.startsWith(contentPrefix)) {
          throw new Error('legacy archive requires offline migration before fenced ingestion');
        }
      }
    }
    await commit({ ...record, generation: String(BigInt(record.generation) + 1n) });
  } catch (error) {
    await close();
    throw error;
  }

  const generation = record.generation;
  async function readBatches(): Promise<StreamEnvelope[][]> {
    assertOwned();
    const batches: StreamEnvelope[][] = [];
    for (const digest of record.batches) {
      const bytes = await container
        .getBlobClient(`${contentPrefix}${digest}.json`)
        .downloadToBuffer();
      assertOwned();
      if (createHash('sha256').update(bytes).digest('hex') !== digest)
        throw new Error('committed archive hash mismatch');
      const batch: unknown = JSON.parse(bytes.toString('utf-8'));
      if (!Array.isArray(batch)) throw new Error('committed archive batch is not an array');
      batches.push(batch as StreamEnvelope[]);
    }
    return batches;
  }
  return {
    ownership: { generation, signal: lost.signal, assertOwned, close },
    appendEnvelopes(batch) {
      const operation = tail.then(async () => {
        assertOwned();
        if (batch.length === 0) return;
        const data = Buffer.from(canonicalJsonStringify(batch));
        const digest = createHash('sha256').update(data).digest('hex');
        if (record.batches.includes(digest)) return;
        await uploadImmutableBatch(container, `${contentPrefix}${digest}.json`, data);
        assertOwned();
        await commit({ ...record, batches: [...record.batches, digest] });
      });
      // A failed operation retires this owner; queued callbacks cannot resume it.
      tail = operation.catch((error: unknown) => {
        lose(error);
      });
      return operation;
    },
    readBatches,
    async readAllEnvelopes() {
      return (await readBatches()).flat();
    },
  };
}
