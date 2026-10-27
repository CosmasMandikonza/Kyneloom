import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LiveFrame, StreamEnvelope } from '@kyneloom/match-core';
import { azureConfigFromEnv, type IngestionHealth } from './azure-adapters';
import { createMemoryArchive, type DurableArchive } from './blob-archive';

/**
 * KYN-14 — the Azure runtime seam: strict env gating, cloud-session
 * lifecycle (replay → begin → ingest), durable-before-checkpoint batch
 * ordering, truthful failure handling, and one-consumer-per-process. All
 * dependencies are injected fakes — no Azure account, no SDK imports.
 * Module state (startup guard, status) is reset per test via
 * vi.resetModules + dynamic import.
 */

const FULL_ENV: Record<string, string | undefined> = {
  KYN_EVENTHUBS_NAMESPACE: 'kyneloom-dev-eh-x',
  KYN_EVENTHUB_NAME: 'kyneloom-live',
  KYN_EVENTHUBS_CONSUMER_GROUP: 'reducer',
  KYN_CHECKPOINT_CONTAINER_URL: 'https://kynldevx.blob.core.windows.net/reducer-checkpoints',
  KYN_ARCHIVE_CONTAINER_URL: 'https://kynldevx.blob.core.windows.net/envelope-archive',
  KYN_WEBPUBSUB_CONNECTION_STRING: 'Endpoint=https://x;AccessKey=redacted;Version=1.0',
  KYN_WEBPUBSUB_HUB: 'live',
  KYN_AZURE_CLIENT_ID: '00000000-0000-0000-0000-000000000000',
  KYN_LIVE_MATCH_ID: 'synthetic-derby-01',
};

interface FakeService {
  ingest: (batch: readonly StreamEnvelope[]) => void;
  setPublishHook: (hook: ((frame: LiveFrame) => void) | null) => void;
  beginExternalSession: () => void;
  endExternalSession: (detail: string) => void;
  running: boolean;
}

interface RecordedService {
  ingest: ReturnType<typeof vi.fn>;
  setPublishHook: ReturnType<typeof vi.fn>;
  beginExternalSession: ReturnType<typeof vi.fn>;
  endExternalSession: ReturnType<typeof vi.fn>;
  _running: boolean;
}

function makeService(): FakeService & RecordedService {
  const service = {
    ingest: vi.fn(),
    setPublishHook: vi.fn(),
    beginExternalSession: vi.fn(() => {
      service._running = true;
    }),
    endExternalSession: vi.fn(() => {
      service._running = false;
    }),
    _running: false,
  };
  return service as unknown as FakeService & RecordedService;
}

/** Resolve when the condition holds (bounded; not an ordering sleep). */
async function until(cond: () => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 10));
  }
}

async function loadRuntime() {
  return await import('./azure-runtime');
}

function makeDeps(service: ReturnType<typeof makeService>, archive: DurableArchive) {
  const calls = {
    onBatch: null as null | ((batch: readonly StreamEnvelope[]) => Promise<void>),
    broadcast: vi.fn(async () => undefined),
    ingests: 0,
    signal: null as AbortSignal | null,
    onReady: null as (() => void) | null,
  };
  const deps = {
    startIngestion: vi.fn(
      (
        _config: unknown,
        onBatch: (batch: readonly StreamEnvelope[]) => Promise<void>,
        signal: AbortSignal,
        _factories: unknown = undefined,
        health?: IngestionHealth,
      ) => {
        calls.onBatch = onBatch;
        calls.signal = signal;
        calls.onReady = health?.onReady ?? (() => undefined);
        // Stays pending = a live consumer loop (resolves only on abort).
        return new Promise<void>((resolve) => {
          if (signal.aborted) resolve();
          else signal.addEventListener('abort', () => resolve(), { once: true });
        });
      },
    ),
    broadcast: calls.broadcast,
    createArchive: vi.fn(async () => archive),
    getService: () => ({
      ingest: (batch: readonly StreamEnvelope[]) => {
        calls.ingests += 1;
        service.ingest(batch);
      },
      setPublishHook: (hook: ((frame: LiveFrame) => void) | null) => service.setPublishHook(hook),
      beginExternalSession: () => service.beginExternalSession(),
      endExternalSession: (detail: string) => service.endExternalSession(detail),
      get status(): { running: boolean } {
        return { running: service._running };
      },
    }),
  };
  return { deps, calls };
}

beforeEach(() => {
  vi.resetModules();
});

afterEach(async () => {
  const { stopAzureLiveWorker } = await loadRuntime();
  await stopAzureLiveWorker();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('azureConfigFromEnv — all-or-nothing contract (fail closed)', () => {
  it('returns null when ANY required variable is missing', () => {
    for (const key of Object.keys(FULL_ENV)) {
      if (key === 'KYN_LIVE_MATCH_ID') continue; // optional (defaults)
      const partial: Record<string, string | undefined> = { ...FULL_ENV };
      delete partial[key];
      expect(azureConfigFromEnv(partial)).toBeNull();
    }
    expect(azureConfigFromEnv({})).toBeNull();
  });

  it('returns the full parsed contract incl. identity client id and archive URL', () => {
    const config = azureConfigFromEnv(FULL_ENV);
    expect(config).not.toBeNull();
    expect(config!.identityClientId).toBe('00000000-0000-0000-0000-000000000000');
    expect(config!.archiveStorageContainerUrl).toContain('envelope-archive');
    expect(config!.matchId).toBe('synthetic-derby-01');
  });
});

describe('maybeStartAzureLiveWorker — cloud-session lifecycle', () => {
  it('Next.js register completes while the consumer remains running', async () => {
    const runtime = await loadRuntime();
    const service = makeService();
    const { deps, calls } = makeDeps(service, createMemoryArchive());
    Object.assign(runtime.defaultAzureRuntimeDeps, deps);
    vi.stubEnv('NEXT_RUNTIME', 'nodejs');
    for (const [key, value] of Object.entries(FULL_ENV)) vi.stubEnv(key, value);
    try {
      const { register } = await import('../../../instrumentation');
      await register();
      await until(() => calls.onBatch !== null);
      expect(service._running).toBe(true);
      expect(deps.startIngestion).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllEnvs();
    }
  }, 1000);

  it('does NOTHING without the complete env contract (local mode unchanged)', async () => {
    const { maybeStartAzureLiveWorker, azureRuntimeStatus } = await loadRuntime();
    const service = makeService();
    const { deps, calls } = makeDeps(service, createMemoryArchive());
    const result = await maybeStartAzureLiveWorker({}, deps);
    expect(result.started).toBe(false);
    expect(deps.startIngestion).not.toHaveBeenCalled();
    expect(deps.createArchive).not.toHaveBeenCalled();
    expect(service.beginExternalSession).not.toHaveBeenCalled();
    expect(calls.broadcast).not.toHaveBeenCalled();
    expect(azureRuntimeStatus().active).toBe(false);
  });

  it('replays the durable archive BEFORE the session, then ingests live batches in append→ingest order', async () => {
    const { maybeStartAzureLiveWorker, azureRuntimeStatus } = await loadRuntime();
    const service = makeService();
    const archive = createMemoryArchive();
    const replayedBatch = [
      { envelopeId: 'env-replay-1', matchId: 'synthetic-derby-01' },
    ] as unknown as StreamEnvelope[];
    archive.stored.push(replayedBatch);
    const { deps, calls } = makeDeps(service, archive);
    await maybeStartAzureLiveWorker(FULL_ENV, deps);
    await until(() => calls.onBatch !== null);

    // Archive was read for replay, the session began, and the replayed
    // corpus was ingested FIRST; the runtime reports the replay count.
    expect(deps.createArchive).toHaveBeenCalledTimes(1);
    expect(service.ingest).toHaveBeenNthCalledWith(1, [
      { envelopeId: 'env-replay-1', matchId: 'synthetic-derby-01' },
    ]);
    expect(azureRuntimeStatus().replayedEnvelopes).toBe(1);
    expect(azureRuntimeStatus().active).toBe(false);

    // A live batch: archive-append happens BEFORE ingest (durable first).
    const liveBatch = [{ envelopeId: 'env-live-1' }] as unknown as readonly StreamEnvelope[];
    await calls.onBatch!(liveBatch);
    expect(archive.stored).toHaveLength(2);
    expect(archive.stored[1]).toEqual(liveBatch as unknown as StreamEnvelope[]);
    expect(service.ingest).toHaveBeenCalledTimes(2);
    calls.onReady!();
    expect(azureRuntimeStatus().active).toBe(true);

    // The publish hook broadcasts every authoritative frame to Web PubSub.
    const hook = service.setPublishHook.mock.calls[0]![0] as (f: LiveFrame) => void;
    hook({
      type: 'status',
      matchId: 'synthetic-derby-01',
      sessionId: 's',
      seq: 0,
      status: 'connected',
      detail: '',
      traceId: '',
    });
    await until(() => calls.broadcast.mock.calls.length === 1);
  });

  it('an archive-append failure FAILS the batch (no ingest) — durable-before-checkpoint', async () => {
    const { maybeStartAzureLiveWorker } = await loadRuntime();
    const service = makeService();
    const archive = createMemoryArchive(true); // inject append failure
    const { deps, calls } = makeDeps(service, archive);
    void maybeStartAzureLiveWorker(FULL_ENV, deps);
    await until(() => calls.onBatch !== null);
    const liveBatch = [{ envelopeId: 'env-will-fail' }] as unknown as readonly StreamEnvelope[];
    await expect(calls.onBatch!(liveBatch)).rejects.toThrow('archive write failed');
    // The batch was NEVER admitted: no ingest, nothing archived.
    expect(service.ingest).toHaveBeenCalledTimes(0);
    expect(archive.stored).toHaveLength(0);
  });

  it('startup failure (archive unavailable) leaves NO session and truthful status', async () => {
    const { maybeStartAzureLiveWorker, azureRuntimeStatus } = await loadRuntime();
    const service = makeService();
    const { deps } = makeDeps(service, createMemoryArchive());
    deps.createArchive = vi.fn(async () => {
      throw new Error('blob container unreachable (injected)');
    });
    await maybeStartAzureLiveWorker(FULL_ENV, deps);
    await until(() => azureRuntimeStatus().detail.includes('cloud ingestion failed'));
    expect(service.beginExternalSession).not.toHaveBeenCalled();
    expect(azureRuntimeStatus().active).toBe(false);
    expect(azureRuntimeStatus().detail).toContain('blob container unreachable');
  });

  it('ingestion rejection ENDS the external session truthfully', async () => {
    const { maybeStartAzureLiveWorker, azureRuntimeStatus } = await loadRuntime();
    const service = makeService();
    const { deps } = makeDeps(service, createMemoryArchive());
    deps.startIngestion = vi.fn(async () => {
      throw new Error('consumer error (injected)');
    });
    await maybeStartAzureLiveWorker(FULL_ENV, deps);
    await until(() => azureRuntimeStatus().detail.includes('cloud ingestion failed'));
    expect(service.endExternalSession).toHaveBeenCalledTimes(1);
    expect(azureRuntimeStatus().active).toBe(false);
  });

  it('overlapping startup calls start exactly ONE consumer (module guard)', async () => {
    const { maybeStartAzureLiveWorker } = await loadRuntime();
    const service = makeService();
    const { deps } = makeDeps(service, createMemoryArchive());
    // The first call takes the create path (background consumer loop);
    // the overlapping second call is a synchronous-guard no-op.
    void maybeStartAzureLiveWorker(FULL_ENV, deps);
    const second = await maybeStartAzureLiveWorker(FULL_ENV, deps);
    expect(second.detail).toContain('already attempted');
    await until(() => service.beginExternalSession.mock.calls.length === 1);
    expect(deps.startIngestion).toHaveBeenCalledTimes(1);
    expect(deps.createArchive).toHaveBeenCalledTimes(1);
  });

  it('consumer failure after a healthy receive withdraws readiness and ends the session', async () => {
    const { maybeStartAzureLiveWorker, azureRuntimeStatus } = await loadRuntime();
    const service = makeService();
    const { deps } = makeDeps(service, createMemoryArchive());
    let fail: (error: Error) => void = () => undefined;
    deps.startIngestion = vi.fn((_config, _batch, _signal, _factories, health) => {
      health?.onReady();
      return new Promise<void>((_, reject) => {
        fail = reject;
      });
    });
    await maybeStartAzureLiveWorker(FULL_ENV, deps);
    await until(() => azureRuntimeStatus().active);
    fail(new Error('consumer disconnected (injected)'));
    await until(() => !azureRuntimeStatus().active);
    expect(service._running).toBe(false);
    expect(service.setPublishHook).toHaveBeenLastCalledWith(null);
    expect(azureRuntimeStatus().detail).toContain('consumer disconnected');
  });

  it('shutdown aborts the consumer, ends readiness and does not permit a second initialization', async () => {
    const runtime = await loadRuntime();
    const service = makeService();
    const { deps, calls } = makeDeps(service, createMemoryArchive());
    const termListeners = process.listenerCount('SIGTERM');
    const intListeners = process.listenerCount('SIGINT');
    await runtime.maybeStartAzureLiveWorker(FULL_ENV, deps);
    await until(() => calls.onReady !== null);
    calls.onReady!();
    await runtime.stopAzureLiveWorker();
    await runtime.stopAzureLiveWorker();
    expect(calls.signal!.aborted).toBe(true);
    expect(runtime.azureRuntimeStatus().active).toBe(false);
    expect(service._running).toBe(false);
    expect(service.endExternalSession).toHaveBeenCalledTimes(1);
    expect(process.listenerCount('SIGTERM')).toBe(termListeners);
    expect(process.listenerCount('SIGINT')).toBe(intListeners);
    await runtime.maybeStartAzureLiveWorker(FULL_ENV, deps);
    expect(deps.startIngestion).toHaveBeenCalledTimes(1);
  });

  it('shutdown during slow archive recovery cannot start a late consumer', async () => {
    const runtime = await loadRuntime();
    const service = makeService();
    const archive = createMemoryArchive();
    let finishReplay: (batch: StreamEnvelope[][]) => void = () => undefined;
    archive.readBatches = vi.fn(
      () =>
        new Promise<StreamEnvelope[][]>((resolve) => {
          finishReplay = resolve;
        }),
    );
    const { deps } = makeDeps(service, archive);
    await runtime.maybeStartAzureLiveWorker(FULL_ENV, deps);
    await until(() => vi.mocked(archive.readBatches).mock.calls.length === 1);
    await runtime.stopAzureLiveWorker();
    finishReplay([]);
    await Promise.resolve();
    expect(deps.startIngestion).not.toHaveBeenCalled();
    expect(service.beginExternalSession).not.toHaveBeenCalled();
    expect(runtime.azureRuntimeStatus().active).toBe(false);
  });

  it('HTTP readiness follows actual runtime receive and consumer failure', async () => {
    const runtime = await loadRuntime();
    const { startEventHubsIngestion } = await import('./azure-adapters');
    const { LiveMatchService } = await import('./service');
    const { GET } = await import('../../app/api/live/ready/route');
    type Handlers = {
      processEvents: (
        events: [],
        context: { updateCheckpoint: () => Promise<void> },
      ) => Promise<void>;
      processError: (error: Error) => Promise<void>;
    };
    let handlers: Handlers | null = null;
    let finishClose: () => void = () => undefined;
    const client = {
      subscribe: (value: Handlers) => {
        handlers = value;
        return { close: async () => undefined };
      },
      close: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            finishClose = resolve;
          }),
      ),
    };
    const factories = {
      createCredential: async () => ({}),
      createCheckpointStore: async () => ({}),
      createConsumerClient: async () => client,
    };
    await runtime.maybeStartAzureLiveWorker(FULL_ENV, {
      ...runtime.defaultAzureRuntimeDeps,
      createArchive: async () => createMemoryArchive(),
      startIngestion: (config, batch, signal, _factories, ready) =>
        startEventHubsIngestion(config, batch, signal, factories, ready),
    });
    await until(() => handlers !== null);
    expect((await GET()).status).toBe(503);
    await handlers!.processEvents([], { updateCheckpoint: async () => undefined });
    expect((await GET()).status).toBe(200);
    await handlers!.processError(new Error('receive failed (injected)'));
    await until(() => !runtime.azureRuntimeStatus().active);
    expect((await GET()).status).toBe(503);
    expect(LiveMatchService.get().status.running).toBe(false);
    await until(() => client.close.mock.calls.length === 1);
    expect(client.close).toHaveBeenCalledTimes(1);
    finishClose();
    await until(() => runtime.azureRuntimeStatus().detail.includes('cloud ingestion failed'));
  });
});
