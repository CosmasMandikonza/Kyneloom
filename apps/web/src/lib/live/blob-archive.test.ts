import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
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
