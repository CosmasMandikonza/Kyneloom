import { createHash } from 'node:crypto';
import { canonicalJsonStringify } from '@kyneloom/contracts';
import type { StreamEnvelope } from '@kyneloom/match-core';
import { isRestError, type ContainerClient } from '@azure/storage-blob';
import type { AzureLiveConfig } from './azure-adapters';

/**
 * KYN-14 — durable raw source batches, written BEFORE admission/checkpoint.
 * Keys hash the complete canonical received batch (including source revisions,
 * envelope ids, trace ids and emission times). Exact retries across restarts
 * reuse an immutable object; changed payloads/corrections remain separate.
 * Rebatching/redelivery with changed transport metadata may create more objects;
 * business deduplication still belongs to the ONE existing projection worker.
 */
export interface DurableArchive {
  /** Present on the production cloud archive; absent on legacy readers/test doubles. */
  readonly ownership?: ArchiveOwnership;
  appendEnvelopes(batch: readonly StreamEnvelope[]): Promise<void>;
  /** Recovery MUST admit each original batch separately in receipt order. */
  readBatches(): Promise<StreamEnvelope[][]>;
  /** Flattened inspection only; never use for authoritative recovery. */
  readAllEnvelopes(): Promise<StreamEnvelope[]>;
}

export interface ArchiveOwnership {
  readonly generation: string;
  readonly signal: AbortSignal;
  assertOwned(): void;
  close(): Promise<void>;
}

export async function createArchiveContainer(config: AzureLiveConfig): Promise<ContainerClient> {
  const [{ ContainerClient }, { DefaultAzureCredential }] = await Promise.all([
    import('@azure/storage-blob'),
    import('@azure/identity'),
  ]);
  return new ContainerClient(
    config.archiveStorageContainerUrl,
    new DefaultAzureCredential({ managedIdentityClientId: config.identityClientId }),
  );
}

/** Content identity and create-only SDK contract shared by both archive formats. */
export async function uploadImmutableBatch(
  container: ContainerClient,
  name: string,
  data: Buffer,
  metadata?: Record<string, string>,
): Promise<void> {
  try {
    await container.getBlockBlobClient(name).upload(data, data.byteLength, {
      blobHTTPHeaders: { blobContentType: 'application/json' },
      conditions: { ifNoneMatch: '*' },
      ...(metadata === undefined ? {} : { metadata }),
    });
  } catch (error) {
    if (
      !isRestError(error) ||
      !(
        (error.statusCode === 412 && error.code === 'ConditionNotMet') ||
        (error.statusCode === 409 && error.code === 'BlobAlreadyExists')
      )
    )
      throw error;
    const previous = await container.getBlobClient(name).downloadToBuffer();
    if (!previous.equals(data))
      throw new Error(`archive content conflict: ${name}`, { cause: error });
  }
}

/**
 * Legacy v1 format for offline inspection and compatibility tests. Production
 * ingestion uses acquireOwnedArchive (owned-archive.ts). Receipt ordinals
 * are metadata on the source objects, not a second archive or reducer. On a
 * restart the next ordinal is recovered from Blob, never from a process counter.
 * This is NOT a distributed writer lease or a checkpoint/publication transaction.
 */
export async function createBlobArchive(
  config: AzureLiveConfig,
  createContainer: typeof createArchiveContainer = createArchiveContainer,
): Promise<DurableArchive> {
  const container = await createContainer(config);
  const prefix = `${config.matchId}/`;
  const contentPrefix = `${prefix}batches-v1/`;

  async function entries() {
    const records: { name: string; order: bigint | null }[] = [];
    const orders = new Set<bigint>();
    for await (const item of container.listBlobsFlat({ prefix, includeMetadata: true })) {
      if (item.name === `${prefix}commit-v1`)
        throw new Error('fenced archive requires the owned reader');
      if (!item.name.endsWith('.json')) continue;
      let order: bigint | null = null;
      if (item.name.startsWith(contentPrefix)) {
        const value = item.metadata?.archive_order;
        if (!value || !/^(0|[1-9][0-9]*)$/.test(value)) {
          throw new Error(`archive receipt order missing or invalid: ${item.name}`);
        }
        order = BigInt(value);
        if (orders.has(order))
          throw new Error('archive receipt order collision: competing writers');
        orders.add(order);
      }
      records.push({ name: item.name, order });
    }
    return records.sort((a, b) => {
      if (a.order !== b.order) {
        if (a.order === null) return -1;
        if (b.order === null) return 1;
        return a.order < b.order ? -1 : 1;
      }
      return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
    });
  }

  async function readBatches(): Promise<StreamEnvelope[][]> {
    const batches: StreamEnvelope[][] = [];
    for (const { name } of await entries()) {
      const buffer = await container.getBlobClient(name).downloadToBuffer();
      if (name.startsWith(contentPrefix)) {
        const digest = createHash('sha256').update(buffer).digest('hex');
        if (name !== `${contentPrefix}${digest}.json`) {
          throw new Error(`archive content hash mismatch: ${name}`);
        }
      }
      const batch: unknown = JSON.parse(buffer.toString('utf-8'));
      if (!Array.isArray(batch)) throw new Error(`archive batch is not an array: ${name}`);
      // Preserve raw records, including invalid source data, for the existing
      // worker's admission/quarantine checks. Do not filter history here.
      batches.push(batch as StreamEnvelope[]);
    }
    return batches;
  }

  const existing = await entries();
  let nextOrder = existing.reduce(
    (next, entry) => (entry.order !== null && entry.order >= next ? entry.order + 1n : next),
    0n,
  );
  return {
    async appendEnvelopes(batch): Promise<void> {
      if (batch.length === 0) return;
      const data = Buffer.from(canonicalJsonStringify(batch), 'utf-8');
      const digest = createHash('sha256').update(data).digest('hex');
      const name = `${contentPrefix}${digest}.json`;
      const order = nextOrder++;
      await uploadImmutableBatch(container, name, data, { archive_order: String(order) });
    },
    readBatches,
    async readAllEnvelopes(): Promise<StreamEnvelope[]> {
      return (await readBatches()).flat();
    },
  };
}

/** In-memory failure-injection fake (never evidence of Azure durability). */
export function createMemoryArchive(failAppend = false): DurableArchive & {
  stored: StreamEnvelope[][];
} {
  const stored: StreamEnvelope[][] = [];
  async function readBatches(): Promise<StreamEnvelope[][]> {
    return stored.map((batch) => batch.map((envelope) => ({ ...envelope })));
  }
  return {
    stored,
    async appendEnvelopes(batch): Promise<void> {
      if (failAppend) throw new Error('archive write failed (injected)');
      stored.push([...batch]);
    },
    readBatches,
    async readAllEnvelopes(): Promise<StreamEnvelope[]> {
      return (await readBatches()).flat();
    },
  };
}
