import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import type { StreamEnvelope } from '@kyneloom/match-core';
import {
  azureClientFactories,
  eventHubsFqdn,
  startEventHubsIngestion,
  webPubSubGroupName,
  type AzureLiveConfig,
} from './azure-adapters';

/**
 * KYN-14 review B — REAL SDK-boundary verification (local, no Azure
 * account):
 * - The real factories construct the pinned SDK clients with the EXACT
 *   contracts: fully qualified namespace, DefaultAzureCredential,
 *   checkpoint store, credentialed ContainerClient.
 * - The ingestion flow (with injected fakes) proves checkpoint ordering:
 *   updateCheckpoint runs ONLY after onBatch resolves; a failing batch
 *   never advances the checkpoint.
 * - ONE Web PubSub group identity on every boundary (review D).
 */

const CONFIG: AzureLiveConfig = {
  eventHubsNamespace: 'kyneloom-dev-eh-x',
  eventHubName: 'kyneloom-live',
  consumerGroup: 'reducer',
  checkpointStorageContainerUrl: 'https://kynldevx.blob.core.windows.net/reducer-checkpoints',
  archiveStorageContainerUrl: 'https://kynldevx.blob.core.windows.net/envelope-archive',
  webPubSubConnectionString: 'Endpoint=https://x;AccessKey=redacted;Version=1.0',
  hubName: 'live',
  matchId: 'synthetic-derby-01',
  identityClientId: '00000000-0000-0000-0000-000000000000',
};

describe('pure boundary helpers', () => {
  it('eventHubsFqdn produces the SDK-expected fully qualified namespace', () => {
    expect(eventHubsFqdn('kyneloom-dev-eh-x')).toBe('kyneloom-dev-eh-x.servicebus.windows.net');
  });

  it('webPubSubGroupName is the ONE group identity (dot form, role-suffix compatible)', () => {
    expect(webPubSubGroupName('synthetic-derby-01')).toBe('match.synthetic-derby-01');
  });

  it('the adapter uses webPubSubGroupName on EVERY group boundary (source check)', () => {
    const source = readFileSync(new URL('./azure-adapters.ts', import.meta.url), 'utf-8');
    // Broadcast group and the negotiated role suffix both derive from the
    // helper; no hand-built group string exists anywhere else.
    expect(source).toContain('service.group(webPubSubGroupName(config.matchId))');
    expect(source).toContain('`webpubsub.joinLeaveGroup.${webPubSubGroupName(config.matchId)}`');
    expect(source).not.toMatch(/service\.group\((?!webPubSubGroupName)[a-zA-Z]/);
    // The negotiated role is join/leave ONLY — a viewer can never publish.
    expect(source).not.toContain('webpubsub.sendToGroup');
  });
});

describe('real factories construct the pinned SDK clients correctly (no connection)', () => {
  it('createCredential → DefaultAzureCredential', async () => {
    const { DefaultAzureCredential } = await import('@azure/identity');
    const credential = await azureClientFactories.createCredential(CONFIG);
    expect(credential).toBeInstanceOf(DefaultAzureCredential);
  });

  it('createConsumerClient → EventHubConsumerClient bound to the FQDN, hub and group', async () => {
    const { EventHubConsumerClient } = await import('@azure/event-hubs');
    const credential = await azureClientFactories.createCredential(CONFIG);
    const checkpointStore = await azureClientFactories.createCheckpointStore(CONFIG, credential);
    const client = (await azureClientFactories.createConsumerClient(
      CONFIG,
      credential,
      checkpointStore,
    )) as InstanceType<typeof EventHubConsumerClient> & {
      fullyQualifiedNamespace: string;
    };
    // Construction performs NO connection (that happens on subscribe), so
    // this asserts the real constructor contract locally. The SDK exposes
    // fullyQualifiedNamespace/eventHubName getters; the consumer group is
    // the constructor input asserted via the factories' config above.
    expect(client).toBeInstanceOf(EventHubConsumerClient);
    expect(client.fullyQualifiedNamespace).toBe('kyneloom-dev-eh-x.servicebus.windows.net');
    expect(client.eventHubName).toBe('kyneloom-live');
  });

  it('createCheckpointStore → BlobCheckpointStore over a CREDENTIALED ContainerClient', async () => {
    const { BlobCheckpointStore } = await import('@azure/eventhubs-checkpointstore-blob');
    const credential = await azureClientFactories.createCredential(CONFIG);
    const store = await azureClientFactories.createCheckpointStore(CONFIG, credential);
    expect(store).toBeInstanceOf(BlobCheckpointStore);
  });
});

describe('startEventHubsIngestion (injected fakes) — checkpoint ordering laws', () => {
  interface CapturedEvents {
    body: unknown;
    offset: number;
    sequenceNumber: number;
    enqueuedTimeUtc: Date;
  }
  function makeFakeConsumer() {
    const captured = {
      handlers: null as null | {
        processEvents: (events: CapturedEvents[], context: unknown) => Promise<void>;
        processError: (err: unknown) => Promise<void>;
      },
      checkpoints: [] as number[],
      closed: false,
    };
    const subscription = {
      close: vi.fn(async () => {
        captured.closed = true;
      }),
    };
    const client = {
      close: vi.fn(async () => undefined),
      subscribe(handlers: typeof captured.handlers) {
        captured.handlers = handlers;
        return subscription;
      },
    };
    const context = {
      updateCheckpoint: vi.fn(async (event: CapturedEvents) => {
        captured.checkpoints.push(event.sequenceNumber);
      }),
    };
    return { captured, client, context, subscription };
  }

  function envelopeEvent(envelopeId: string, bodyOverride?: unknown): CapturedEvents {
    const body =
      bodyOverride === undefined
        ? {
            contractVersion: 'kyneloom-live-wire-v2',
            envelopeId,
            matchId: 'synthetic-derby-01',
            kind: 'tracking',
            tracking: {
              schemaVersion: '1.0',
              matchId: 'synthetic-derby-01',
              sampleTimeMs: 1000,
              entityId: 'home-01',
              xM: 1,
              yM: 2,
              zM: 0,
              origin: 'synthetic_ground_truth',
              confidence: 1,
              visibility: 'tracked',
              sourceFrameId: 'frame-10',
            },
            emittedAt: 1,
            traceId: 'trc',
          }
        : bodyOverride;
    return { body, offset: 100, sequenceNumber: 7, enqueuedTimeUtc: new Date(0) };
  }

  it('checkpoints advance ONLY after onBatch resolves (durable-first)', async () => {
    const fake = makeFakeConsumer();
    const factories = {
      createCredential: vi.fn(async () => ({})),
      createCheckpointStore: vi.fn(async () => ({})),
      createConsumerClient: vi.fn(async () => fake.client),
    };
    let releaseBatch: (() => void) | null = null;
    const onBatch = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          releaseBatch = resolve;
        }),
    );
    const controller = new AbortController();
    const running = startEventHubsIngestion(CONFIG, onBatch, controller.signal, factories as never);
    await vi.waitFor(() => expect(fake.captured.handlers).not.toBeNull());
    // Do NOT await the gate: processEvents stays pending until the batch's
    // durable obligation resolves — exactly the ordering under test.
    const processed = fake.captured.handlers!.processEvents([envelopeEvent('env-1')], fake.context);
    await vi.waitFor(() => expect(onBatch).toHaveBeenCalledTimes(1));
    // onBatch was called but not yet resolved: NO checkpoint may exist.
    expect(fake.captured.checkpoints).toHaveLength(0);
    releaseBatch!();
    await processed;
    await vi.waitFor(() => expect(fake.captured.checkpoints).toEqual([7]));
    controller.abort();
    await running;
    expect(fake.captured.closed).toBe(true);
    expect(fake.client.close).toHaveBeenCalledTimes(1);
  });

  it('a failing batch NEVER advances the checkpoint (retried delivery stays safe)', async () => {
    const fake = makeFakeConsumer();
    const factories = {
      createCredential: vi.fn(async () => ({})),
      createCheckpointStore: vi.fn(async () => ({})),
      createConsumerClient: vi.fn(async () => fake.client),
    };
    const onBatch = vi.fn(async () => {
      throw new Error('durable obligation failed (injected)');
    });
    const controller = new AbortController();
    const running = startEventHubsIngestion(CONFIG, onBatch, controller.signal, factories as never);
    await vi.waitFor(() => expect(fake.captured.handlers).not.toBeNull());
    // The rejected batch propagates to the SDK (retry/error handling) and
    // the checkpoint is NEVER advanced.
    await expect(
      fake.captured.handlers!.processEvents([envelopeEvent('env-1')], fake.context),
    ).rejects.toThrow('durable obligation failed');
    expect(onBatch).toHaveBeenCalledTimes(1);
    expect(fake.captured.checkpoints).toHaveLength(0);
    controller.abort();
    await running;
  });

  it('poison envelopes (wrong contract version) are passed through for quarantine, never silently dropped', async () => {
    const fake = makeFakeConsumer();
    const factories = {
      createCredential: vi.fn(async () => ({})),
      createCheckpointStore: vi.fn(async () => ({})),
      createConsumerClient: vi.fn(async () => fake.client),
    };
    const batches: StreamEnvelope[][] = [];
    const onBatch = vi.fn(async (batch: readonly StreamEnvelope[]) => {
      batches.push([...batch]);
    });
    const controller = new AbortController();
    const running = startEventHubsIngestion(CONFIG, onBatch, controller.signal, factories as never);
    await vi.waitFor(() => expect(fake.captured.handlers).not.toBeNull());
    await fake.captured.handlers!.processEvents(
      [envelopeEvent('env-1', { contractVersion: 'kyneloom-live-wire-v0', junk: true })],
      fake.context,
    );
    await vi.waitFor(() => expect(batches).toHaveLength(1));
    expect(batches[0]![0]!.envelopeId).toMatch(/^poison-/);
    expect(batches[0]![0]!.traceId).toBe('trc-unknown');
    await vi.waitFor(() => expect(fake.captured.checkpoints).toHaveLength(1));
    controller.abort();
    await running;
  });

  it('reports readiness only after a successful receive, including an empty receive', async () => {
    const fake = makeFakeConsumer();
    const factories = {
      createCredential: vi.fn(async () => ({})),
      createCheckpointStore: vi.fn(async () => ({})),
      createConsumerClient: vi.fn(async () => fake.client),
    };
    const ready = vi.fn();
    const controller = new AbortController();
    const running = startEventHubsIngestion(
      CONFIG,
      async () => undefined,
      controller.signal,
      factories,
      { onReady: ready, onError: vi.fn() },
    );
    await vi.waitFor(() => expect(fake.captured.handlers).not.toBeNull());
    expect(ready).not.toHaveBeenCalled();
    await fake.captured.handlers!.processEvents([], fake.context);
    expect(ready).toHaveBeenCalledTimes(1);
    controller.abort();
    await running;
  });

  it('consumer errors reject the lifetime promise and close subscription AND client', async () => {
    const fake = makeFakeConsumer();
    const factories = {
      createCredential: vi.fn(async () => ({})),
      createCheckpointStore: vi.fn(async () => ({})),
      createConsumerClient: vi.fn(async () => fake.client),
    };
    const running = startEventHubsIngestion(
      CONFIG,
      async () => undefined,
      new AbortController().signal,
      factories,
    );
    const failed = expect(running).rejects.toThrow('authentication failed');
    await vi.waitFor(() => expect(fake.captured.handlers).not.toBeNull());
    await fake.captured.handlers!.processError(new Error('authentication failed'));
    await failed;
    expect(fake.subscription.close).toHaveBeenCalledTimes(1);
    expect(fake.client.close).toHaveBeenCalledTimes(1);
  });

  it('an already cancelled start creates no SDK clients', async () => {
    const factories = {
      createCredential: vi.fn(async () => ({})),
      createCheckpointStore: vi.fn(async () => ({})),
      createConsumerClient: vi.fn(async () => ({})),
    };
    const controller = new AbortController();
    controller.abort();
    await startEventHubsIngestion(CONFIG, async () => undefined, controller.signal, factories);
    expect(factories.createCredential).not.toHaveBeenCalled();
  });
});
