import type { StreamEnvelope } from '@kyneloom/match-core';
import { azureClientFactories, type AzureLiveConfig } from './azure-adapters';

/**
 * KYN-14 — the DURABLE cloud source archive. The ephemeral container
 * filesystem is NOT durability: every admitted envelope batch is appended
 * to the private `envelope-archive` Blob container BEFORE the Event Hubs
 * checkpoint advances (the runtime's ordering law), and the archive is
 * REPLAYED on worker start so a restarted container reconstructs the
 * authoritative corpus instead of skipping source its checkpoints already
 * consumed. Event Hubs retention is NOT this archive (docs/09).
 */

export interface DurableArchive {
  /** Append one batch's raw envelope records durably (ordered per session). */
  appendEnvelopes(
    sessionId: string,
    batchIndex: number,
    batch: readonly StreamEnvelope[],
  ): Promise<void>;
  /** All archived envelopes, in append order (restart replay source). */
  readAllEnvelopes(): Promise<StreamEnvelope[]>;
}

interface BlobBlockClient {
  upload(data: string, options: unknown): Promise<unknown>;
}

interface BlobContainerClient {
  getBlockBlobClient(name: string): BlobBlockClient;
  listBlobsFlat(options?: { prefix?: string }): AsyncIterableIterator<{ name: string }>;
  getBlobClient(name: string): { downloadToBuffer(): Promise<Buffer> };
}

/**
 * Build the archive from the deployed env contract. The container client
 * uses the SAME user-assigned managed identity credential as the
 * checkpoint store (Storage Blob Data Contributor on the account).
 */
export async function createBlobArchive(
  config: AzureLiveConfig,
  factories: Pick<typeof azureClientFactories, 'createCredential'> = azureClientFactories,
): Promise<DurableArchive> {
  const credential = await factories.createCredential(config);
  const { ContainerClient } = await import('@azure/storage-blob');
  const container = new ContainerClient(
    config.archiveStorageContainerUrl,
    credential as never,
  ) as unknown as BlobContainerClient;
  const prefix = `${config.matchId}/`;
  return {
    async appendEnvelopes(sessionId, batchIndex, batch): Promise<void> {
      const blob = `${prefix}${sessionId}/batch-${String(batchIndex).padStart(6, '0')}.json`;
      await container.getBlockBlobClient(blob).upload(JSON.stringify(batch), {
        blobHTTPHeaders: { blobContentType: 'application/json' },
      });
    },
    async readAllEnvelopes(): Promise<StreamEnvelope[]> {
      const names: string[] = [];
      for await (const item of container.listBlobsFlat({ prefix })) {
        names.push(item.name);
      }
      names.sort();
      const envelopes: StreamEnvelope[] = [];
      for (const name of names) {
        const buffer = await container.getBlobClient(name).downloadToBuffer();
        for (const envelope of JSON.parse(buffer.toString('utf-8')) as StreamEnvelope[]) {
          envelopes.push(envelope);
        }
      }
      return envelopes;
    },
  };
}

/** In-memory fake for deterministic failure-injection tests (never cloud). */
export function createMemoryArchive(failAppend = false): DurableArchive & {
  stored: StreamEnvelope[][];
} {
  const stored: StreamEnvelope[][] = [];
  return {
    stored,
    async appendEnvelopes(_sessionId, _batchIndex, batch): Promise<void> {
      if (failAppend) throw new Error('archive write failed (injected)');
      stored.push([...batch]);
    },
    async readAllEnvelopes(): Promise<StreamEnvelope[]> {
      return stored.flat().map((envelope) => ({ ...envelope }));
    },
  };
}
