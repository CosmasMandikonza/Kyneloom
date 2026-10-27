import { forgetTestProcess } from './test-support/process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { canonicalJsonStringify } from '@kyneloom/contracts';
import {
  LiveProjectionWorker,
  STREAM_CONTRACT_VERSION,
  type LiveFrame,
  type StreamEnvelope,
} from '@kyneloom/match-core';
import { acquireOwnedArchive } from './owned-archive';
import { OWNED_CONFIG as config, ownedStorage, deferred } from './test-support/owned-storage';

const env = {
  KYN_EVENTHUBS_NAMESPACE: config.eventHubsNamespace,
  KYN_EVENTHUB_NAME: config.eventHubName,
  KYN_EVENTHUBS_CONSUMER_GROUP: config.consumerGroup,
  KYN_CHECKPOINT_CONTAINER_URL: config.checkpointStorageContainerUrl,
  KYN_ARCHIVE_CONTAINER_URL: config.archiveStorageContainerUrl,
  KYN_WEBPUBSUB_CONNECTION_STRING: 'unused',
  KYN_WEBPUBSUB_HUB: config.hubName,
  KYN_AZURE_CLIENT_ID: config.identityClientId,
};
function batch(id: string, time = 1000): StreamEnvelope[] {
  return [
    {
      contractVersion: STREAM_CONTRACT_VERSION,
      envelopeId: id,
      matchId: config.matchId,
      kind: 'tracking',
      emittedAt: 1,
      traceId: id,
      tracking: {
        schemaVersion: '1.0',
        matchId: config.matchId,
        sampleTimeMs: time,
        entityId: 'home-01',
        xM: 1,
        yM: 2,
        zM: 0,
        origin: 'synthetic_ground_truth',
        confidence: 1,
        visibility: 'tracked',
        sourceFrameId: id,
      },
    },
  ];
}
type Handlers = {
  processEvents: (
    events: { body: unknown }[],
    context: { updateCheckpoint(event: unknown): Promise<void> },
  ) => Promise<void>;
};
const runtimes: (typeof import('./azure-runtime'))[] = [];
beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.stopAzureLiveWorker();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
async function boot(
  store: ReturnType<typeof ownedStorage>,
  broadcast = vi.fn(async (_config: unknown, _frame: LiveFrame): Promise<void> => undefined),
  wait = true,
  exitProcess?: (code: number) => void,
) {
  forgetTestProcess();
  vi.resetModules();
  const runtime = await import('./azure-runtime');
  const { startEventHubsIngestion } = await import('./azure-adapters');
  runtimes.push(runtime);
  let handlers: Handlers | undefined;
  let hook: ((frame: LiveFrame) => void) | null = null;
  let running = false;
  let worker = new LiveProjectionWorker({ matchId: config.matchId, sessionId: 'idle' });
  const ingest = vi.fn((value: readonly StreamEnvelope[]) => {
    worker.admit(value);
    const frame = worker.takePendingDelta();
    if (frame) hook?.(frame);
  });
  const service = {
    ingest,
    setPublishHook: (value: typeof hook) => {
      hook = value;
    },
    beginExternalSession: (id = 'test') => {
      running = true;
      worker = new LiveProjectionWorker({ matchId: config.matchId, sessionId: id });
    },
    endExternalSession: () => {
      running = false;
    },
    get status() {
      return { running };
    },
  };
  const context = { updateCheckpoint: vi.fn(async (_event: unknown) => undefined) };
  await runtime.maybeStartAzureLiveWorker(
    { ...env, ...(exitProcess ? { NEXT_MANUAL_SIG_HANDLE: '1' } : {}) },
    {
      ...(exitProcess ? { exitProcess } : {}),
      createArchive: (cfg, signal) =>
        acquireOwnedArchive(cfg, { createContainer: store.createContainer, signal, now: Date.now }),
      getService: () => service,
      broadcast,
      startIngestion: (cfg, onBatch, signal, _factories, health) =>
        startEventHubsIngestion(
          cfg,
          onBatch,
          signal,
          {
            createCredential: async () => ({}),
            createCheckpointStore: async () => ({}),
            createConsumerClient: async () => ({
              subscribe(value: Handlers) {
                handlers = value;
                return { close: async () => undefined };
              },
              close: async () => undefined,
            }),
          },
          health,
        ),
    },
  );
  if (wait) await vi.waitFor(() => expect(handlers).toBeDefined());
  return {
    runtime,
    service,
    context,
    broadcast,
    get worker() {
      return worker;
    },
    get hook() {
      return hook;
    },
    get subscribed() {
      return handlers !== undefined;
    },
    receive: (input: readonly StreamEnvelope[]) =>
      handlers!.processEvents(
        input.map((body) => ({ body })),
        context,
      ),
  };
}

describe('owned Azure runtime using real archive SDK and authoritative reducer', () => {
  it('manual cloud SIGTERM waits for drain and lease release before process exit', async () => {
    const registered = vi.spyOn(process, 'once');
    const store = ownedStorage();
    const gate = deferred();
    const exit = vi.fn();
    const a = await boot(
      store,
      vi.fn(async (_c: unknown, _f: LiveFrame): Promise<void> => {
        await gate.promise;
      }),
      true,
      exit,
    );
    await a.receive(batch('one'));
    const handler = registered.mock.calls.find(([event]) => event === 'SIGTERM')?.[1];
    expect(handler).toBeDefined();
    handler!.call(process); // invoke only our registered handler, not the test runner's handlers
    await vi.advanceTimersByTimeAsync(100);
    expect(exit).not.toHaveBeenCalled();
    expect(store.leases.size).toBe(1);
    gate.resolve();
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
    expect(store.leases.size).toBe(0);
    expect(a.runtime.azureRuntimeStatus().active).toBe(false);
  });
  it('shutdown drains issued broadcasts before releasing; late hooks cannot send again', async () => {
    const store = ownedStorage();
    const gate = deferred();
    const broadcast = vi.fn(async (_c: unknown, _f: LiveFrame) => {
      await gate.promise;
    });
    const a = await boot(store, broadcast);
    await a.receive(batch('one'));
    const lateHook = a.hook!;
    expect(broadcast).toHaveBeenCalledTimes(1);
    expect(a.runtime.azureRuntimeStatus().active).toBe(true);
    let stopped = false;
    const stopping = a.runtime.stopAzureLiveWorker().then(() => {
      stopped = true;
    });
    await vi.advanceTimersByTimeAsync(100);
    expect(a.runtime.azureRuntimeStatus().active).toBe(false);
    expect(stopped).toBe(false);
    expect(store.leases.size).toBe(1);
    gate.resolve();
    await stopping;
    expect(store.leases.size).toBe(0);
    lateHook(a.worker.snapshot());
    await Promise.resolve();
    expect(broadcast).toHaveBeenCalledTimes(1);
  });

  it('ownership loss aborts/drains a delayed batch; no admission, checkpoint or broadcast follows it', async () => {
    const store = ownedStorage();
    const a = await boot(store);
    await a.receive(batch('committed'));
    const old = batch('delayed', 1100);
    const digest = createHash('sha256').update(canonicalJsonStringify(old)).digest('hex');
    const delay = store.delayNext(`${config.matchId}/batches-v2/${digest}.json`);
    const receiving = a.receive(old).catch((error) => error as Error);
    await delay.started.promise;
    store.failRenew();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(a.runtime.azureRuntimeStatus().active).toBe(false);
    expect(a.service.status.running).toBe(false);
    vi.setSystemTime(Date.now() + 121_000);
    const b = await acquireOwnedArchive(config, {
      createContainer: store.createContainer,
      now: Date.now,
    });
    try {
      await b.appendEnvelopes(batch('replacement', 1200));
      const committed = store.record();
      delay.finish.resolve();
      expect(await receiving).toBeInstanceOf(Error);
      await a.runtime.stopAzureLiveWorker();
      await a.receive(batch('late-callback', 1300));
      expect(a.service.ingest).toHaveBeenCalledTimes(1);
      expect(a.context.updateCheckpoint).toHaveBeenCalledTimes(1);
      expect(a.broadcast).toHaveBeenCalledTimes(1);
      expect(store.record()).toEqual(committed);
      expect(await b.readBatches()).toEqual([batch('committed'), batch('replacement', 1200)]);
    } finally {
      delay.finish.resolve();
      await b.ownership.close();
    }
  });

  it('revision overlap waits unready; explicit old-revision shutdown allows recovery then readiness', async () => {
    const store = ownedStorage();
    const a = await boot(store);
    const input = batch('one');
    await a.receive(input);
    const version = a.worker.currentVersion;
    const b = await boot(store, undefined, false);
    await vi.advanceTimersByTimeAsync(1000);
    expect(b.subscribed).toBe(false);
    expect(b.service.ingest).not.toHaveBeenCalled();
    expect(b.runtime.azureRuntimeStatus().active).toBe(false);
    // The runbook deactivates A NOW, never waiting for B readiness first.
    await a.runtime.stopAzureLiveWorker();
    await vi.advanceTimersByTimeAsync(1000);
    await vi.waitFor(() => expect(b.subscribed).toBe(true));
    expect(b.runtime.azureRuntimeStatus().active).toBe(false);
    expect(b.runtime.azureRuntimeStatus().ownershipGeneration).toBe('2');
    expect(b.worker.currentVersion).toBe(version);
    expect(b.worker.view().acceptedTracking).toEqual(a.worker.view().acceptedTracking);
    await b.receive(input); // crash-before-checkpoint/redelivery is duplicate-safe
    expect(b.worker.currentVersion).toBe(version);
    expect(b.runtime.azureRuntimeStatus().active).toBe(true);
    expect(store.record().batches).toHaveLength(1);
  });

  it('partial Azure configuration cannot start local fixture processing', async () => {
    vi.stubEnv('KYN_EVENTHUBS_NAMESPACE', 'partial');
    const { LiveMatchService } = await import('./service');
    await expect(LiveMatchService.get().start()).rejects.toThrow('local producer disabled');
  });

  it('a late issued checkpoint remains bounded by committed source across takeover', async () => {
    const store = ownedStorage();
    const a = await boot(store);
    const gate = deferred();
    const entered = deferred();
    a.context.updateCheckpoint.mockImplementation(async () => {
      entered.resolve();
      await gate.promise;
    });
    const input = batch('before-checkpoint');
    const receiving = a.receive(input).catch((error) => error as Error);
    await entered.promise;
    expect(store.record().batches).toHaveLength(1); // already durable before checkpoint call
    vi.setSystemTime(Date.now() + 121_000);
    expect(a.runtime.azureRuntimeStatus().active).toBe(false);
    const b = await acquireOwnedArchive(config, {
      createContainer: store.createContainer,
      now: Date.now,
    });
    try {
      expect(await b.readBatches()).toEqual([input]);
      await b.appendEnvelopes(batch('continuation', 1200));
      gate.resolve(); // remote completion is NOT claimed physically fenced
      expect(await receiving).toBeInstanceOf(Error);
      await a.runtime.stopAzureLiveWorker();
      expect(a.context.updateCheckpoint).toHaveBeenCalledTimes(1);
      expect(await b.readBatches()).toEqual([input, batch('continuation', 1200)]);
    } finally {
      gate.resolve();
      await b.ownership.close();
    }
  });

  it('shutdown while waiting for ownership cannot acquire late or leak a renewable owner', async () => {
    const store = ownedStorage();
    const a = await acquireOwnedArchive(config, {
      createContainer: store.createContainer,
      now: Date.now,
    });
    try {
      const b = await boot(store, undefined, false);
      await vi.advanceTimersByTimeAsync(1000);
      await b.runtime.stopAzureLiveWorker();
      expect(() => a.ownership.assertOwned()).not.toThrow();
      await a.ownership.close();
      await vi.advanceTimersByTimeAsync(2000);
      expect(b.subscribed).toBe(false);
      expect(store.record().generation).toBe('1');
      expect(store.leases.size).toBe(0);
    } finally {
      await a.ownership.close();
    }
  });
});
