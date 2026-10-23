import { describe, expect, it, vi } from 'vitest';
import type { LiveFrame, StreamEnvelope } from '@kyneloom/match-core';
import { azureConfigFromEnv } from './azure-adapters';
import { maybeStartAzureLiveWorker, type AzureRuntimeDeps } from './azure-runtime';

/**
 * KYN-14 — the Azure runtime seam is STRICTLY env-gated and wires exactly
 * two transport paths (ingestion → service.ingest; service broadcast →
 * Web PubSub). No football semantics live here; nothing starts without the
 * complete deployed env contract. SDKs are never imported (deps injected).
 */

const FULL_ENV: Record<string, string | undefined> = {
  KYN_EVENTHUBS_NAMESPACE: 'kyneloom-dev-eh-x',
  KYN_EVENTHUB_NAME: 'kyneloom-live',
  KYN_EVENTHUBS_CONSUMER_GROUP: 'reducer',
  KYN_CHECKPOINT_CONTAINER_URL: 'https://kynldevx.blob.core.windows.net/reducer-checkpoints',
  KYN_WEBPUBSUB_CONNECTION_STRING:
    'Endpoint=https://x.webpubsub.azure.com;AccessKey=redacted;Version=1.0',
  KYN_WEBPUBSUB_HUB: 'live',
  KYN_LIVE_MATCH_ID: 'synthetic-derby-01',
};

function makeDeps() {
  const calls = {
    ingest: vi.fn(),
    started: [] as AzureRuntimeDeps['startIngestion'][],
    broadcast: vi.fn(async () => undefined),
    hooks: [] as (((frame: LiveFrame) => void) | null)[],
  };
  const deps: AzureRuntimeDeps = {
    startIngestion: vi.fn(async (config, onBatch, signal) => {
      calls.started.push(config as never);
      // Simulate one delivered batch so the wiring is proven end to end.
      const batch = [{ envelopeId: 'env-1' }] as unknown as readonly StreamEnvelope[];
      await onBatch(batch);
      void signal;
    }),
    broadcast: calls.broadcast,
    getService: () => ({
      ingest: calls.ingest,
      setPublishHook: (hook) => calls.hooks.push(hook),
    }),
  };
  return { deps, calls };
}

describe('azureConfigFromEnv — all-or-nothing contract', () => {
  it('returns null when ANY required variable is missing', () => {
    for (const key of Object.keys(FULL_ENV)) {
      if (key === 'KYN_LIVE_MATCH_ID') continue; // optional (defaults)
      const partial: Record<string, string | undefined> = { ...FULL_ENV };
      delete partial[key];
      expect(azureConfigFromEnv(partial)).toBeNull();
    }
    expect(azureConfigFromEnv({})).toBeNull();
  });

  it('returns the full parsed contract, with the documented matchId default', () => {
    const config = azureConfigFromEnv(FULL_ENV);
    expect(config).not.toBeNull();
    expect(config!.eventHubsNamespace).toBe('kyneloom-dev-eh-x');
    expect(config!.consumerGroup).toBe('reducer');
    expect(config!.hubName).toBe('live');
    const defaulted = azureConfigFromEnv({
      ...FULL_ENV,
      KYN_LIVE_MATCH_ID: undefined,
    });
    expect(defaulted!.matchId).toBe('synthetic-derby-01');
  });
});

describe('maybeStartAzureLiveWorker — strict gating + transport wiring only', () => {
  it('does NOTHING without the complete env contract (local mode unchanged)', () => {
    const { deps, calls } = makeDeps();
    const result = maybeStartAzureLiveWorker({}, deps);
    expect(result.started).toBe(false);
    expect(calls.started).toHaveLength(0);
    expect(calls.ingest).not.toHaveBeenCalled();
    expect(calls.hooks).toHaveLength(0);
    expect(calls.broadcast).not.toHaveBeenCalled();
  });

  it('with the contract: wires ingestion → ingest and broadcast ← publish hook', async () => {
    const { deps, calls } = makeDeps();
    const result = maybeStartAzureLiveWorker(FULL_ENV, deps);
    expect(result.started).toBe(true);
    // The ingestion loop started with the parsed config and its batches
    // flowed into the service's canonical ingest (no second reducer).
    expect(calls.started).toHaveLength(1);
    expect(calls.ingest).toHaveBeenCalledTimes(1);
    // The publish hook broadcasts every authoritative frame to Web PubSub.
    const hook = calls.hooks[0]!;
    hook({
      type: 'status',
      matchId: 'synthetic-derby-01',
      sessionId: 's',
      seq: 0,
      status: 'connected',
      detail: '',
      traceId: '',
    });
    await vi.waitFor(() => expect(calls.broadcast).toHaveBeenCalledTimes(1));
  });
});
