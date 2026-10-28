import { forgetTestProcess } from './test-support/process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { STREAM_CONTRACT_VERSION, type StreamEnvelope } from '@kyneloom/match-core';

const temporaryRoots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('external ingestion local archive initialization', () => {
  it('a fresh external session can archive, quarantine and checkpoint without a local fixture start', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'kyn14-external-'));
    temporaryRoots.push(root);
    vi.spyOn(process, 'cwd').mockReturnValue(root);
    forgetTestProcess();
    vi.resetModules(); // ARCHIVE_ROOT and the singleton must belong to this fresh container.
    const { LiveMatchService } = await import('./service');
    const service = LiveMatchService.get();
    const directory = path.join(root, '.live-archive', service.matchId);
    expect(existsSync(directory)).toBe(false);
    service.beginExternalSession('external-fresh');
    try {
      expect(existsSync(directory)).toBe(true);
      const batch: StreamEnvelope[] = [
        {
          contractVersion: STREAM_CONTRACT_VERSION,
          envelopeId: 'env-quarantined',
          matchId: service.matchId,
          kind: 'tracking',
          emittedAt: 1000,
          traceId: 'trace-fresh',
          // Deliberately absent tracking payload exercises durable quarantine.
        },
      ];
      expect(() => service.ingest(batch)).not.toThrow();
      expect(service.status.running).toBe(true);
      expect(service.status.quarantined).toBe(1);
      expect(readFileSync(path.join(directory, 'envelopes.jsonl'), 'utf-8')).toContain(
        'env-quarantined',
      );
      expect(readFileSync(path.join(directory, 'quarantine.jsonl'), 'utf-8')).toContain(
        'trace-fresh',
      );
      expect(
        JSON.parse(readFileSync(path.join(directory, 'checkpoint.json'), 'utf-8')),
      ).toMatchObject({ checkpointEnvelopeId: 'env-quarantined', sessionId: 'external-fresh' });
      expect(service.isExternalSession).toBe(true);
    } finally {
      service.endExternalSession('test complete');
    }
  });

  it('directory initialization failure cannot claim a running external session', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'kyn14-blocked-'));
    temporaryRoots.push(root);
    // A file in place of the root directory reliably denies mkdir, even as root.
    const { writeFileSync } = await import('node:fs');
    writeFileSync(path.join(root, '.live-archive'), 'not a directory');
    vi.spyOn(process, 'cwd').mockReturnValue(root);
    forgetTestProcess();
    vi.resetModules();
    const { LiveMatchService } = await import('./service');
    const service = LiveMatchService.get();
    expect(() => service.beginExternalSession()).toThrow();
    expect(service.status.running).toBe(false);
    expect(service.isExternalSession).toBe(false);
  });
});

describe('runtime recovery through the real LiveMatchService', () => {
  it('replays separate batches through one external service without a fixture producer or cloud republication', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'kyn14-service-replay-'));
    temporaryRoots.push(root);
    vi.spyOn(process, 'cwd').mockReturnValue(root);
    forgetTestProcess();
    vi.resetModules();
    const { LiveMatchService } = await import('./service');
    const { LiveProjectionWorker } = await import('@kyneloom/match-core');
    const { createMemoryArchive } = await import('./blob-archive');
    const runtime = await import('./azure-runtime');
    const batch = (sampleTimeMs: number): StreamEnvelope[] => [
      {
        contractVersion: STREAM_CONTRACT_VERSION,
        envelopeId: `env-${sampleTimeMs}`,
        matchId: 'synthetic-derby-01',
        kind: 'tracking',
        emittedAt: 1,
        traceId: 'trace-replay',
        tracking: {
          schemaVersion: '1.0',
          matchId: 'synthetic-derby-01',
          sampleTimeMs,
          entityId: 'home-01',
          xM: 1,
          yM: 2,
          zM: 0,
          origin: 'synthetic_ground_truth',
          confidence: 1,
          visibility: 'tracked',
          sourceFrameId: `frame-${sampleTimeMs}`,
        },
      },
    ];
    const input = [batch(1000), batch(1100)];
    const archive = createMemoryArchive();
    archive.stored.push(...input);
    const reference = new LiveProjectionWorker({
      matchId: 'synthetic-derby-01',
      sessionId: 'expected',
    });
    for (const batch of input) reference.admit(batch);
    const broadcast = vi.fn(async () => undefined);
    const consume = vi.fn(
      (_config: unknown, _batch: unknown, signal: AbortSignal) =>
        new Promise<void>((resolve) => {
          signal.addEventListener('abort', () => resolve(), { once: true });
        }),
    );
    try {
      await runtime.maybeStartAzureLiveWorker(
        {
          KYN_EVENTHUBS_NAMESPACE: 'test',
          KYN_EVENTHUB_NAME: 'test',
          KYN_EVENTHUBS_CONSUMER_GROUP: 'reducer',
          KYN_CHECKPOINT_CONTAINER_URL: 'https://test.blob.core.windows.net/checkpoints',
          KYN_ARCHIVE_CONTAINER_URL: 'https://test.blob.core.windows.net/archive',
          KYN_WEBPUBSUB_CONNECTION_STRING: 'unused',
          KYN_WEBPUBSUB_HUB: 'live',
          KYN_AZURE_CLIENT_ID: '00000000-0000-0000-0000-000000000000',
        },
        {
          ...runtime.defaultAzureRuntimeDeps,
          createArchive: async () => archive,
          startIngestion: consume,
          broadcast,
        },
      );
      await vi.waitFor(() => expect(consume).toHaveBeenCalledTimes(1));
      const service = LiveMatchService.get();
      const snapshot = service.snapshotFrame();
      const expected = reference.snapshot();
      expect({ ...snapshot, sessionId: 'expected' }).toEqual(expected);
      expect(service.isExternalSession).toBe(true);
      expect(service.status.seq).toBe(2);
      expect(runtime.azureRuntimeStatus().replayedEnvelopes).toBe(2);
      expect(runtime.azureRuntimeStatus().active).toBe(false); // no successful live receive yet
      expect(archive.stored).toHaveLength(2); // replay never re-appends to cloud archive
      expect(broadcast).not.toHaveBeenCalled();
      const directory = path.join(root, '.live-archive', service.matchId);
      expect(
        readFileSync(path.join(directory, 'envelopes.jsonl'), 'utf-8').trim().split('\n'),
      ).toHaveLength(2);
    } finally {
      await runtime.stopAzureLiveWorker();
    }
  });
});
