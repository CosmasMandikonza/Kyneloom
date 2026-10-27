import { Readable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AnonymousCredential,
  BlockBlobClient,
  ContainerClient,
  newPipeline,
  type IHttpClient,
} from '@azure/storage-blob';
import { canonicalJsonStringify, type MatchEvent } from '@kyneloom/contracts';
import {
  LiveProjectionWorker,
  STREAM_CONTRACT_VERSION,
  type StreamEnvelope,
} from '@kyneloom/match-core';
import type { AzureLiveConfig } from './azure-adapters';
import { createBlobArchive } from './blob-archive';

const config: AzureLiveConfig = {
  eventHubsNamespace: 'test',
  eventHubName: 'test',
  consumerGroup: 'reducer',
  checkpointStorageContainerUrl: 'https://test.blob.core.windows.net/checkpoints',
  archiveStorageContainerUrl: 'https://test.blob.core.windows.net/archive',
  webPubSubConnectionString: 'unused',
  hubName: 'live',
  matchId: 'synthetic-derby-01',
  identityClientId: '00000000-0000-0000-0000-000000000000',
};

function envelope(id: string, xM = 1): StreamEnvelope {
  return {
    contractVersion: STREAM_CONTRACT_VERSION,
    envelopeId: id,
    matchId: config.matchId,
    kind: 'tracking',
    emittedAt: 1000,
    traceId: 'trace-é',
    tracking: {
      schemaVersion: '1.0',
      matchId: config.matchId,
      sampleTimeMs: 1000,
      entityId: 'home-01',
      xM,
      yM: 2,
      zM: 0,
      origin: 'synthetic_ground_truth',
      confidence: 1,
      visibility: 'tracked',
      sourceFrameId: 'frame-10',
    },
  };
}

/** Real pinned SDK and serialization pipeline, fake HTTP only. No sockets/Azure. */
function storage() {
  const objects = new Map<string, { body: Buffer; order?: string }>();
  const requests: { method: string; name: string; condition?: string; length?: string }[] = [];
  let loseResponse = false;
  let forbidden = false;
  const httpClient: IHttpClient = {
    async sendRequest(request) {
      const url = new URL(request.url);
      const name = decodeURIComponent(url.pathname.slice('/archive/'.length));
      requests.push({
        method: request.method,
        name,
        condition: request.headers.get('if-none-match'),
        length: request.headers.get('content-length'),
      });
      const headers = request.headers.clone();
      headers.set('content-type', 'application/xml');
      headers.set('etag', '"test-etag"');
      const reply = (status: number, body: string | Buffer) => {
        const bytes = Buffer.from(body);
        headers.set('content-length', String(bytes.byteLength));
        return {
          request,
          status,
          headers,
          bodyAsText: bytes.toString('utf-8'),
          readableStreamBody: Readable.from([bytes]),
        };
      };
      const error = (status: number, code: string) => {
        headers.set('x-ms-error-code', code);
        return reply(status, `<Error><Code>${code}</Code><Message>injected</Message></Error>`);
      };
      if (forbidden) return error(403, 'AuthorizationFailure');
      if (url.searchParams.get('comp') === 'list') {
        const prefix = url.searchParams.get('prefix') ?? '';
        const blobs = [...objects]
          .filter(([key]) => key.startsWith(prefix))
          .sort(([a], [b]) => a.localeCompare(b))
          .map(
            ([key, value]) =>
              `<Blob><Name>${key}</Name><Properties><Content-Length>${value.body.byteLength}</Content-Length><BlobType>BlockBlob</BlobType></Properties><Metadata>${value.order === undefined ? '' : `<archive_order>${value.order}</archive_order>`}</Metadata></Blob>`,
          )
          .join('');
        return reply(
          200,
          `<EnumerationResults ServiceEndpoint="https://test.blob.core.windows.net/" ContainerName="archive"><Blobs>${blobs}</Blobs><NextMarker /></EnumerationResults>`,
        );
      }
      if (request.method === 'PUT') {
        if (objects.has(name) && request.headers.get('if-none-match') === '*') {
          return error(412, 'ConditionNotMet');
        }
        if (!Buffer.isBuffer(request.body)) throw new Error('expected SDK buffer body');
        objects.set(name, {
          body: Buffer.from(request.body),
          order: request.headers.get('x-ms-meta-archive_order'),
        });
        if (loseResponse) {
          loseResponse = false;
          throw new Error('lost response after committed write');
        }
        return reply(201, '');
      }
      const object = objects.get(name);
      if (!object) return error(404, 'BlobNotFound');
      headers.set('content-type', 'application/octet-stream');
      return { ...reply(200, object.body), bodyAsText: undefined };
    },
  };
  const client = new ContainerClient(
    config.archiveStorageContainerUrl,
    newPipeline(new AnonymousCredential(), { httpClient, retryOptions: { maxTries: 1 } }),
  );
  return {
    objects,
    requests,
    create: () => createBlobArchive(config, async () => client),
    loseResponse: () => {
      loseResponse = true;
    },
    forbid: () => {
      forbidden = true;
    },
    allow: () => {
      forbidden = false;
    },
  };
}

describe('Blob archive through the real SDK (controlled HTTP)', () => {
  it('creates its first object using the real upload signature, byte length, JSON headers and create-only condition', async () => {
    const store = storage();
    const archive = await store.create();
    expect(await archive.readAllEnvelopes()).toEqual([]);
    const upload = vi.spyOn(BlockBlobClient.prototype, 'upload');
    try {
      const batch = [envelope('env-1')];
      await archive.appendEnvelopes(batch);
      const data = Buffer.from(canonicalJsonStringify(batch));
      expect(upload).toHaveBeenCalledWith(data, data.byteLength, {
        blobHTTPHeaders: { blobContentType: 'application/json' },
        conditions: { ifNoneMatch: '*' },
        metadata: { archive_order: '0' },
      });
      expect(data.byteLength).toBeGreaterThan(data.toString().length);
      expect(store.requests.find((r) => r.method === 'PUT')).toMatchObject({
        condition: '*',
        length: String(data.byteLength),
      });
      expect(store.objects.size).toBe(1);
      expect(await archive.readAllEnvelopes()).toEqual(batch);
    } finally {
      upload.mockRestore();
    }
  });

  it('an identical retry (also with reordered object keys) reuses one immutable source object', async () => {
    const store = storage();
    const archive = await store.create();
    const original = envelope('env-1');
    await archive.appendEnvelopes([original]);
    const { traceId, ...rest } = original;
    await archive.appendEnvelopes([{ traceId, ...rest }]);
    expect(store.objects.size).toBe(1);
    expect([...store.objects.values()][0]!.order).toBe('0');
    expect(await archive.readAllEnvelopes()).toEqual([original]);
  });

  it('two worker sessions recover receipt order, dedupe redelivery and preserve changed payloads', async () => {
    const store = storage();
    const first = await store.create();
    const original = envelope('env-original');
    await first.appendEnvelopes([original]);
    const second = await store.create();
    expect(await second.readAllEnvelopes()).toEqual([original]);
    await second.appendEnvelopes([original]); // old checkpoint redelivery
    const changed = envelope('env-correction', 9);
    await second.appendEnvelopes([changed]);
    expect(store.objects.size).toBe(2);
    expect(await second.readAllEnvelopes()).toEqual([original, changed]);
    // The same authoritative worker handles the preserved conflicting tracking
    // correction both live and on replay (no archive-side projection).
    const live = new LiveProjectionWorker({ matchId: config.matchId, sessionId: 'live' });
    live.admit([original]);
    live.admit([changed]);
    const replay = new LiveProjectionWorker({ matchId: config.matchId, sessionId: 'restarted' });
    replay.admit(await second.readAllEnvelopes());
    expect(replay.currentVersion).toBe(live.currentVersion);
  });

  it('keeps source revisions/corrections as distinct objects and replays them through the same reducer', async () => {
    const store = storage();
    const archive = await store.create();
    const event: MatchEvent = {
      schemaVersion: '1.0',
      eventId: 'evt-pass',
      providerId: 'kyneloom-simulator',
      tenantId: 'demo-org',
      matchId: config.matchId,
      fixtureSeed: 24017,
      sourceRevision: 1,
      kind: 'pass_completed',
      occurredAtMs: 1000,
      ingestedAt: '2026-10-12T14:30:05Z',
      sequence: 1,
      actorId: 'home-08',
      teamId: 'home',
      position: { xM: 1, yM: 2 },
      attributes: {},
      provenance: {
        origin: 'synthetic_ground_truth',
        generatorVersion: 'fixture-engine-v1',
        confidence: 1,
      },
      correctionOf: null,
    };
    const base: StreamEnvelope = {
      ...envelope('env-pass-r1'),
      kind: 'event',
      tracking: undefined,
      event,
    };
    const correction: StreamEnvelope = {
      ...base,
      envelopeId: 'env-pass-r2',
      event: {
        ...event,
        sourceRevision: 2,
        correctionOf: event.eventId,
        position: { xM: 3, yM: 2 },
      },
    };
    await archive.appendEnvelopes([base]);
    await archive.appendEnvelopes([correction]);
    const restarted = await store.create();
    const replay = await restarted.readAllEnvelopes();
    expect(replay.map((e) => e.event?.sourceRevision)).toEqual([1, 2]);
    expect(store.objects.size).toBe(2);
    const live = new LiveProjectionWorker({ matchId: config.matchId, sessionId: 'live' });
    live.admit([base]);
    live.admit([correction]);
    const recovered = new LiveProjectionWorker({ matchId: config.matchId, sessionId: 'recovered' });
    recovered.admit(replay);
    expect(recovered.currentVersion).toBe(live.currentVersion);
    expect(recovered.view().projection.acceptedEvents[0]?.position?.xM).toBe(3);
  });

  it('a lost acknowledgement can be retried after restart without overwriting', async () => {
    const store = storage();
    const first = await store.create();
    store.loseResponse();
    await expect(first.appendEnvelopes([envelope('env-1')])).rejects.toThrow('lost response');
    const committed = [...store.objects.values()][0]!.body;
    const restarted = await store.create();
    await restarted.appendEnvelopes([envelope('env-1')]);
    expect(store.objects.size).toBe(1);
    expect([...store.objects.values()][0]!.body).toEqual(committed);
  });

  it('rejects attempted overwrite/corruption instead of treating every precondition failure as success', async () => {
    const store = storage();
    const archive = await store.create();
    await archive.appendEnvelopes([envelope('env-1')]);
    const object = [...store.objects.values()][0]!;
    object.body = Buffer.from('existing bytes that must not be overwritten');
    await expect(archive.appendEnvelopes([envelope('env-1')])).rejects.toThrow(
      'archive content conflict',
    );
    expect(object.body.toString()).toBe('existing bytes that must not be overwritten');
    await expect(archive.readAllEnvelopes()).rejects.toThrow('archive content hash mismatch');
  });

  it('does not hide authorization failures as retries', async () => {
    const store = storage();
    const archive = await store.create();
    store.forbid();
    await expect(archive.appendEnvelopes([envelope('env-1')])).rejects.toThrow();
    expect(store.objects.size).toBe(0);
  });

  it('retains legacy batches before new receipts without rewriting old objects', async () => {
    const store = storage();
    const original = envelope('env-old');
    const legacy = { body: Buffer.from(JSON.stringify([original])) };
    store.objects.set(`${config.matchId}/${config.matchId}/batch-000000.json`, legacy);
    const archive = await store.create();
    const fresh = envelope('env-new');
    await archive.appendEnvelopes([fresh]);
    expect(await archive.readAllEnvelopes()).toEqual([original, fresh]);
    expect(await archive.readBatches()).toEqual([[original], [fresh]]);
    expect(store.objects.get(`${config.matchId}/${config.matchId}/batch-000000.json`)).toBe(legacy);
  });

  it('fails replay closed when receipt ordering metadata is missing or collides', async () => {
    const store = storage();
    const archive = await store.create();
    await archive.appendEnvelopes([envelope('env-1')]);
    await archive.appendEnvelopes([envelope('env-2')]);
    const records = [...store.objects.values()];
    records[1]!.order = records[0]!.order;
    await expect(archive.readAllEnvelopes()).rejects.toThrow('receipt order collision');
    records[1]!.order = undefined;
    await expect(store.create()).rejects.toThrow('receipt order missing or invalid');
  });
});

/** KYN-14 recovery: real archive + SDK pipeline + runtime + ingestion + reducer.
 * Only external HTTP/Event Hubs delivery and process death are controlled doubles.
 */
describe('crash recovery against the authoritative worker', () => {
  const runtimes: (typeof import('./azure-runtime'))[] = [];

  afterEach(async () => {
    for (const runtime of runtimes.splice(0)) await runtime.stopAzureLiveWorker();
    vi.restoreAllMocks();
  });

  const env = {
    KYN_EVENTHUBS_NAMESPACE: config.eventHubsNamespace,
    KYN_EVENTHUB_NAME: config.eventHubName,
    KYN_EVENTHUBS_CONSUMER_GROUP: config.consumerGroup,
    KYN_CHECKPOINT_CONTAINER_URL: config.checkpointStorageContainerUrl,
    KYN_ARCHIVE_CONTAINER_URL: config.archiveStorageContainerUrl,
    KYN_WEBPUBSUB_CONNECTION_STRING: config.webPubSubConnectionString,
    KYN_WEBPUBSUB_HUB: config.hubName,
    KYN_AZURE_CLIENT_ID: config.identityClientId,
    KYN_LIVE_MATCH_ID: config.matchId,
  };

  function eventEnvelope(id: string, override: Partial<MatchEvent> = {}): StreamEnvelope {
    return {
      contractVersion: STREAM_CONTRACT_VERSION,
      envelopeId: `env-${id}`,
      matchId: config.matchId,
      kind: 'event',
      emittedAt: 1000,
      traceId: `trace-${id}`,
      event: {
        schemaVersion: '1.0',
        eventId: id,
        providerId: 'kyneloom-simulator',
        tenantId: 'demo-org',
        matchId: config.matchId,
        fixtureSeed: 24017,
        sourceRevision: 1,
        kind: 'pass_completed',
        occurredAtMs: 1000,
        ingestedAt: '2026-10-12T14:30:05Z',
        sequence: 1,
        actorId: 'home-08',
        teamId: 'home',
        position: { xM: 1, yM: 2 },
        attributes: {},
        provenance: {
          origin: 'synthetic_ground_truth',
          generatorVersion: 'fixture-engine-v1',
          confidence: 1,
        },
        correctionOf: null,
        ...override,
      },
    };
  }

  function batches(): StreamEnvelope[][] {
    const base = eventEnvelope('evt-pass', { kind: 'goal' });
    const corrected = eventEnvelope('evt-pass-r2', {
      eventId: 'evt-pass',
      sourceRevision: 2,
      correctionOf: 'evt-pass',
      position: { xM: 8, yM: 2 },
    });
    const tracking = envelope('env-tracking');
    const laterTracking: StreamEnvelope = {
      ...tracking,
      envelopeId: 'env-tracking-later',
      tracking: { ...tracking.tracking!, sampleTimeMs: 1100, xM: 3, sourceFrameId: 'frame-11' },
    };
    return [
      [base, tracking],
      [corrected],
      [eventEnvelope('evt-later', { sequence: 2, occurredAtMs: 1100 }), laterTracking],
    ];
  }

  function reference(input: readonly StreamEnvelope[][]) {
    const worker = new LiveProjectionWorker({ matchId: config.matchId, sessionId: 'reference' });
    const quarantine = input.flatMap((batch) => worker.admit(batch).quarantined);
    return { worker, quarantine };
  }

  function state(worker: LiveProjectionWorker) {
    const { projection, acceptedEvents, acceptedTracking } = worker.view();
    const times = [0, 1000, 1050, 1100, 1200];
    return {
      fingerprint: worker.currentVersion,
      seq: worker.currentSeq,
      matchTimeMs: worker.currentMatchTimeMs,
      acceptedEvents,
      acceptedTracking,
      history: projection.eventHistory(),
      revision: projection.revisionCount,
      timeline: times.map((time) => projection.timeline.sampleAt(time)),
      projections: times.map((time) => projection.matchStateAt(time)),
      revisions: Array.from({ length: projection.revisionCount + 1 }, (_, revision) =>
        projection.matchStateAt(1100, revision),
      ),
    };
  }

  async function boot(
    store: ReturnType<typeof storage>,
    options: {
      archive?: import('./blob-archive').DurableArchive;
      beforeIngest?: (batch: readonly StreamEnvelope[]) => void;
      waitForStart?: boolean;
    } = {},
  ) {
    vi.resetModules(); // Simulated fresh process: new singleton guard and worker.
    const runtime = await import('./azure-runtime');
    const { startEventHubsIngestion } = await import('./azure-adapters');
    runtimes.push(runtime);
    const worker = new LiveProjectionWorker({ matchId: config.matchId, sessionId: 'recovered' });
    const quarantine: import('@kyneloom/match-core').QuarantineRecord[] = [];
    const admitted: (readonly StreamEnvelope[])[] = [];
    let active = false;
    let hook: ((frame: import('@kyneloom/match-core').LiveFrame) => void) | null = null;
    let handlers:
      | {
          processEvents: (
            events: { body: unknown; sequenceNumber: number }[],
            context: { updateCheckpoint: (event: { sequenceNumber: number }) => Promise<void> },
          ) => Promise<void>;
          processError: (error: Error) => Promise<void>;
        }
      | undefined;
    let subscriptionOptions: unknown;
    const client = {
      subscribe(value: NonNullable<typeof handlers>, options?: unknown) {
        handlers = value;
        subscriptionOptions = options;
        return { close: async () => undefined };
      },
      close: async () => undefined,
    };
    const checkpoints: number[] = [];
    const broadcast = vi.fn(async () => undefined);
    const started = await runtime.maybeStartAzureLiveWorker(env, {
      createArchive: async () => options.archive ?? (await store.create()),
      startIngestion: (config, batch, signal, _factories, health) =>
        startEventHubsIngestion(
          config,
          batch,
          signal,
          {
            createCredential: async () => ({}),
            createCheckpointStore: async () => ({}),
            createConsumerClient: async () => client,
          },
          health,
        ),
      broadcast,
      getService: () => ({
        beginExternalSession: () => {
          active = true;
        },
        endExternalSession: () => {
          active = false;
        },
        setPublishHook: (value) => {
          hook = value;
        },
        ingest: (batch) => {
          options.beforeIngest?.(batch);
          admitted.push(batch);
          quarantine.push(...worker.admit(batch).quarantined);
          const delta = worker.takePendingDelta();
          if (delta) hook?.(delta);
        },
        get status() {
          return { running: active };
        },
      }),
    });
    expect(started.started).toBe(true);
    if (options.waitForStart !== false)
      await vi.waitFor(() =>
        expect(
          handlers !== undefined || runtime.azureRuntimeStatus().detail.includes('failed'),
        ).toBe(true),
      );
    return {
      runtime,
      worker,
      quarantine,
      admitted,
      checkpoints,
      broadcast,
      get options() {
        return subscriptionOptions;
      },
      get active() {
        return active;
      },
      get subscribed() {
        return handlers !== undefined;
      },
      async deliver(
        batch: readonly StreamEnvelope[],
        firstSequence: number,
        failCheckpoint: boolean | number = false,
      ) {
        if (!handlers) throw new Error('consumer not subscribed');
        try {
          await handlers.processEvents(
            batch.map((body, index) => ({ body, sequenceNumber: firstSequence + index })),
            {
              updateCheckpoint: async (event) => {
                if (
                  failCheckpoint === true ||
                  (typeof failCheckpoint === 'number' && event.sequenceNumber === failCheckpoint)
                )
                  throw new Error('crash before checkpoint');
                checkpoints.push(event.sequenceNumber);
              },
            },
          );
        } catch (error) {
          // The real SDK forwards callback errors to processError; emulate that boundary.
          await handlers.processError(error instanceof Error ? error : new Error(String(error)));
          throw error;
        }
      },
      stop: () => runtime.stopAzureLiveWorker(),
    };
  }

  it('normal ordered multi-batch processing matches the existing worker', async () => {
    const input = batches();
    const running = await boot(storage());
    for (const [index, batch] of input.entries()) await running.deliver(batch, index * 10);
    expect(state(running.worker)).toEqual(state(reference(input).worker));
    expect(running.runtime.azureRuntimeStatus().active).toBe(true);
  });

  it('restart after archival and checkpoint preserves batch boundaries, history and projections', async () => {
    const store = storage();
    const input = batches();
    const first = await boot(store);
    for (const [index, batch] of input.entries()) await first.deliver(batch, index * 10);
    expect(first.checkpoints).toEqual([0, 1, 10, 20, 21]);
    await first.stop();
    const restarted = await boot(store);
    expect(restarted.admitted).toEqual(input);
    expect(state(restarted.worker)).toEqual(state(reference(input).worker));
    expect(restarted.runtime.azureRuntimeStatus().replayedEnvelopes).toBe(5);
    expect(restarted.checkpoints).toEqual([]); // Replay must never checkpoint the transport.
    expect(restarted.broadcast).not.toHaveBeenCalled();
  });

  it('crash after archive/admission but before checkpoint recovers and duplicate delivery is a state no-op', async () => {
    const store = storage();
    const input = batches();
    const first = await boot(store);
    await first.deliver(input[0]!, 0);
    await expect(first.deliver(input[1]!, 10, true)).rejects.toThrow('crash before checkpoint');
    expect(first.checkpoints).toEqual([0, 1]);
    expect(store.objects.size).toBe(2);
    await first.stop();
    const restarted = await boot(store);
    expect(state(restarted.worker)).toEqual(state(reference(input.slice(0, 2)).worker));
    const recovered = state(restarted.worker);
    await restarted.deliver(input[1]!, 10); // checkpoint did not advance, source is redelivered
    expect(state(restarted.worker)).toEqual(recovered);
    expect(restarted.checkpoints).toEqual([10]);
    expect(store.objects.size).toBe(2);
    await restarted.deliver(input[2]!, 20);
    expect(state(restarted.worker)).toEqual(state(reference(input).worker));
  });

  it('crash after the Blob commit but before reducer admission recovers the archived batch', async () => {
    const store = storage();
    const input = batches();
    const first = await boot(store, {
      beforeIngest: () => {
        throw new Error('crash before admission');
      },
    });
    await expect(first.deliver(input[0]!, 0)).rejects.toThrow('crash before admission');
    expect(first.checkpoints).toEqual([]);
    expect(first.admitted).toEqual([]);
    expect(store.objects.size).toBe(1);
    await first.stop();
    const restarted = await boot(store);
    expect(state(restarted.worker)).toEqual(state(reference(input.slice(0, 1)).worker));
    await restarted.deliver(input[0]!, 0);
    expect(state(restarted.worker)).toEqual(state(reference(input.slice(0, 1)).worker));
  });

  it('does not retroactively accept a previously quarantined correction when its target arrives later', async () => {
    const store = storage();
    const rejected = eventEnvelope('evt-early-correction', {
      eventId: 'evt-pass',
      sourceRevision: 2,
      correctionOf: 'evt-target',
      position: { xM: 50, yM: 2 },
    });
    const base = eventEnvelope('evt-target');
    const input = [[rejected], [base]];
    const first = await boot(store);
    await first.deliver(input[0]!, 0);
    await first.deliver(input[1]!, 1);
    expect(first.quarantine.map((record) => record.reason)).toContain('unknown-correction-target');
    await first.stop();
    const restarted = await boot(store);
    expect(state(restarted.worker)).toEqual(state(reference(input).worker));
    expect(restarted.quarantine).toEqual(reference(input).quarantine);
  });

  it('conflicts, invalid events and revised source data replay with identical quarantine and accepted state', async () => {
    const store = storage();
    const base = eventEnvelope('evt-pass');
    const conflict = eventEnvelope('evt-conflict', {
      eventId: 'evt-pass',
      position: { xM: 20, yM: 2 },
    });
    const invalid = { ...eventEnvelope('evt-invalid'), event: undefined };
    const trackingConflict = envelope('env-tracking-conflict', 9);
    const input = [
      [base, envelope('env-tracking')],
      [conflict, invalid, trackingConflict],
      [eventEnvelope('evt-after', { sequence: 2 })],
    ];
    const first = await boot(store);
    for (const [index, batch] of input.entries()) await first.deliver(batch, index * 10);
    expect(first.quarantine.map((record) => record.reason)).toContain('malformed');
    expect(first.quarantine.map((record) => record.reason)).toContain('duplicate-conflict');
    await first.stop();
    const restarted = await boot(store);
    expect(state(restarted.worker)).toEqual(state(reference(input).worker));
    expect(restarted.quarantine).toEqual(reference(input).quarantine);
  });

  it('starts from the earliest retained event if a checkpoint is absent', async () => {
    const running = await boot(storage());
    expect(running.options).toMatchObject({ startPosition: { offset: '-1' } });
  });

  it('a checkpoint partially advanced within an archived batch cannot lose its remaining source', async () => {
    const store = storage();
    const batch = batches()[0]!;
    const first = await boot(store);
    await expect(first.deliver(batch, 0, 1)).rejects.toThrow('crash before checkpoint');
    expect(first.checkpoints).toEqual([0]);
    expect(store.objects.size).toBe(1);
    await first.stop();
    const restarted = await boot(store);
    expect(state(restarted.worker)).toEqual(state(reference([batch]).worker));
    await restarted.deliver(batch.slice(1), 1); // SDK may redeliver only the uncheckpointed suffix.
    expect(restarted.checkpoints).toEqual([1]);
    expect(state(restarted.worker)).toEqual(state(reference([batch]).worker));
  });

  it('an archive write failure prevents admission/checkpoint, and restart plus retry converges', async () => {
    const store = storage();
    const input = batches();
    const first = await boot(store);
    await first.deliver(input[0]!, 0);
    const prefix = state(first.worker);
    store.forbid();
    await expect(first.deliver(input[1]!, 10)).rejects.toThrow();
    expect(state(first.worker)).toEqual(prefix);
    expect(first.checkpoints).toEqual([0, 1]);
    expect(store.objects.size).toBe(1);
    await first.stop();
    store.allow();
    const restarted = await boot(store);
    await restarted.deliver(input[1]!, 10);
    expect(state(restarted.worker)).toEqual(state(reference(input.slice(0, 2)).worker));
  });

  it('an archive read failure cannot start a consumer or checkpoint past unread recovery data', async () => {
    const store = storage();
    const archive = await store.create();
    const input = batches();
    for (const batch of input) await archive.appendEnvelopes(batch);
    const object = [...store.objects.values()][1]!;
    const intact = object.body;
    object.body = Buffer.from('corrupt');
    const failed = await boot(store);
    expect(failed.subscribed).toBe(false);
    expect(failed.active).toBe(false);
    expect(failed.admitted).toEqual([]);
    expect(failed.checkpoints).toEqual([]);
    expect(failed.runtime.azureRuntimeStatus().active).toBe(false);
    expect(failed.runtime.azureRuntimeStatus().detail).toContain('hash mismatch');
    await failed.stop();
    object.body = intact;
    const restarted = await boot(store);
    expect(state(restarted.worker)).toEqual(state(reference(input).worker));
  });

  it('cancellation after archive read cannot activate late; a fresh process recovers normally', async () => {
    const store = storage();
    const archive = await store.create();
    const input = batches();
    for (const batch of input) await archive.appendEnvelopes(batch);
    let release: () => void = () => undefined;
    let readFinished = false;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const partial = await boot(store, {
      waitForStart: false,
      archive: {
        ...archive,
        readBatches: async () => {
          const batches = await archive.readBatches();
          readFinished = true;
          await gate;
          return batches;
        },
      },
    });
    await vi.waitFor(() => expect(readFinished).toBe(true));
    await partial.stop();
    release();
    await Promise.resolve();
    expect(partial.active).toBe(false);
    expect(partial.subscribed).toBe(false);
    expect(partial.admitted).toEqual([]);
    const restarted = await boot(store);
    expect(state(restarted.worker)).toEqual(state(reference(input).worker));
  });

  it('a failed partial replay never consumes live data, and a fresh process replays the entire prefix', async () => {
    const store = storage();
    const archive = await store.create();
    const input = batches();
    for (const batch of input) await archive.appendEnvelopes(batch);
    let calls = 0;
    const partial = await boot(store, {
      beforeIngest: () => {
        if (++calls === 2) throw new Error('partial replay failed');
      },
    });
    expect(partial.admitted).toEqual(input.slice(0, 1));
    expect(partial.runtime.azureRuntimeStatus().replayedEnvelopes).toBe(input[0]!.length);
    expect(partial.subscribed).toBe(false);
    expect(partial.active).toBe(false);
    expect(partial.runtime.azureRuntimeStatus().active).toBe(false);
    expect(partial.checkpoints).toEqual([]);
    await partial.stop();
    const restarted = await boot(store);
    expect(restarted.admitted).toEqual(input);
    expect(state(restarted.worker)).toEqual(state(reference(input).worker));
  });
});
