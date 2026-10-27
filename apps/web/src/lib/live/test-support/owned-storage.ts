import { Readable } from 'node:stream';
import {
  AnonymousCredential,
  ContainerClient,
  newPipeline,
  type IHttpClient,
} from '@azure/storage-blob';
import type { AzureLiveConfig } from '../azure-adapters';

export const OWNED_CONFIG: AzureLiveConfig = {
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
export function deferred() {
  let resolve = (): void => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** Real SDK serialization; in-memory HTTP contract model, NEVER Azure evidence. */
export function ownedStorage() {
  const objects = new Map<string, { bytes: Buffer; etag: string }>();
  const leases = new Map<string, { id: string; until: number }>();
  const requests: { method: string; name: string; lease?: string; condition?: string }[] = [];
  let version = 0;
  let pause:
    | {
        name: string;
        phase: 'before' | 'after';
        started: ReturnType<typeof deferred>;
        finish: ReturnType<typeof deferred>;
      }
    | undefined;
  let failRenewal = false;
  let failCommit = false;
  const httpClient: IHttpClient = {
    async sendRequest(request) {
      const url = new URL(request.url);
      const name = decodeURIComponent(url.pathname.slice('/archive/'.length));
      const leaseId = request.headers.get('x-ms-lease-id');
      requests.push({
        method: request.method,
        name,
        ...(leaseId ? { lease: leaseId } : {}),
        ...(request.headers.get('if-match') ? { condition: request.headers.get('if-match')! } : {}),
      });
      const headers = request.headers.clone();
      headers.set('content-type', 'application/xml');
      headers.set('last-modified', new Date().toUTCString());
      const reply = (status: number, body: string | Buffer = '') => {
        const bytes = Buffer.from(body);
        headers.set('content-length', String(bytes.length));
        const object = objects.get(name);
        if (object) headers.set('etag', object.etag);
        return {
          request,
          status,
          headers,
          bodyAsText: bytes.toString(),
          readableStreamBody: Readable.from([bytes]),
        };
      };
      const error = (status: number, code: string) => {
        headers.set('x-ms-error-code', code);
        return reply(
          status,
          `<Error><Code>${code}</Code><Message>controlled failure</Message></Error>`,
        );
      };
      const lease = leases.get(name);
      const active = lease !== undefined && lease.until > Date.now();
      if (url.searchParams.get('comp') === 'lease') {
        const action = request.headers.get('x-ms-lease-action');
        if (action === 'acquire') {
          const proposed = request.headers.get('x-ms-proposed-lease-id')!;
          if (active && lease.id !== proposed) return error(409, 'LeaseAlreadyPresent');
          leases.set(name, { id: proposed, until: Date.now() + 60_000 });
          headers.set('x-ms-lease-id', proposed);
          return reply(201);
        }
        if (!lease || lease.id !== leaseId) return error(409, 'LeaseIdMismatchWithLeaseOperation');
        if (action === 'renew') {
          if (failRenewal) return error(403, 'AuthorizationFailure');
          lease.until = Date.now() + 60_000;
          headers.set('x-ms-lease-id', lease.id);
          return reply(200);
        }
        if (action === 'release') {
          leases.delete(name);
          return reply(200);
        }
        throw new Error(`unexpected lease action ${action}`);
      }
      if (url.searchParams.get('comp') === 'list') {
        const prefix = url.searchParams.get('prefix') ?? '';
        const entries = [...objects]
          .filter(([key]) => key.startsWith(prefix))
          .map(
            ([key, value]) =>
              `<Blob><Name>${key}</Name><Properties><Content-Length>${value.bytes.length}</Content-Length><BlobType>BlockBlob</BlobType></Properties></Blob>`,
          )
          .join('');
        return reply(
          200,
          `<EnumerationResults ServiceEndpoint="https://test.blob.core.windows.net/" ContainerName="archive"><Blobs>${entries}</Blobs><NextMarker /></EnumerationResults>`,
        );
      }
      const delayed = request.method === 'PUT' && pause?.name === name ? pause : undefined;
      if (delayed) {
        pause = undefined;
        if (delayed.phase === 'before') {
          delayed.started.resolve();
          await delayed.finish.promise;
        }
      }
      // Re-evaluate at Storage's mutation boundary, after any simulated network delay.
      const currentLease = leases.get(name);
      const currentActive = currentLease !== undefined && currentLease.until > Date.now();
      if (
        (leaseId && (!currentActive || currentLease.id !== leaseId)) ||
        (request.method === 'PUT' && currentActive && !leaseId)
      )
        return error(412, 'LeaseIdMismatchWithBlobOperation');
      const object = objects.get(name);
      if (request.headers.get('if-match') && object?.etag !== request.headers.get('if-match'))
        return error(412, 'ConditionNotMet');
      if (request.method === 'PUT') {
        if (object && request.headers.get('if-none-match') === '*')
          return error(412, 'ConditionNotMet');
        if (name.endsWith('/commit-v1') && failCommit) return error(500, 'InternalError');
        if (!Buffer.isBuffer(request.body)) throw new Error('expected SDK Buffer body');
        objects.set(name, { bytes: Buffer.from(request.body), etag: `"${++version}"` });
        if (delayed?.phase === 'after') {
          delayed.started.resolve();
          await delayed.finish.promise;
          throw new Error('lost response after mutation');
        }
        return reply(201);
      }
      if (!object) return error(404, 'BlobNotFound');
      if (request.method === 'HEAD') {
        const response = reply(200);
        headers.set('content-length', String(object.bytes.length));
        return response;
      }
      headers.set('content-type', 'application/octet-stream');
      return { ...reply(200, object.bytes), bodyAsText: undefined };
    },
  };
  const client = new ContainerClient(
    OWNED_CONFIG.archiveStorageContainerUrl,
    newPipeline(new AnonymousCredential(), { httpClient, retryOptions: { maxTries: 1 } }),
  );
  return {
    client,
    objects,
    leases,
    requests,
    createContainer: async () => client,
    record: () =>
      JSON.parse(objects.get(`${OWNED_CONFIG.matchId}/commit-v1`)!.bytes.toString()) as {
        generation: string;
        batches: string[];
      },
    delayNext(name: string, phase: 'before' | 'after' = 'before') {
      const value = { name, phase, started: deferred(), finish: deferred() };
      pause = value;
      return value;
    },
    failRenew: () => {
      failRenewal = true;
    },
    failCommits: () => {
      failCommit = true;
    },
  };
}
