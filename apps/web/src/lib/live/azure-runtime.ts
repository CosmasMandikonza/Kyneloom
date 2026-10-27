import { randomUUID } from 'node:crypto';
import type { LiveFrame, StreamEnvelope } from '@kyneloom/match-core';
import {
  azureConfigFromEnv,
  azureModeRequested,
  broadcastViaWebPubSub,
  startEventHubsIngestion,
  type AzureLiveConfig,
} from './azure-adapters';
import type { DurableArchive } from './blob-archive';
import { acquireOwnedArchive } from './owned-archive';
import { LiveMatchService } from './service';
import { liveProcessState } from './process-state';

/**
 * KYN-14 — the Azure runtime seam. When the full adapter env contract is
 * present (deployed by infra/azure), the ONE service process runs the
 * cloud vertical slice IN-PROCESS:
 *
 *   durable envelope archive (Blob) ⇄ Event Hubs ('reducer' group)
 *   → onBatch: archive-append FIRST → LiveMatchService.ingest (the SAME
 *     canonical worker + archive-before-checkpoint law as the local path)
 *   → broadcast → SSE subscribers AND the Web PubSub match group.
 *
 * STARTUP: read the durable archive before beginning a session, then admit
 * each original batch in receipt order before consuming. This reconstructs
 * the authoritative corpus instead of skipping source its Event Hubs checkpoints
 * already consumed. Only then does consumption start — a fresh external
 * session. Checkpoints may trail the archive; admission deduplicates redelivery.
 *
 * FAILURE LAWS: if ingestion start fails, the external session ENDS
 * truthfully (viewers see disconnected, never a fabricated healthy live
 * session); a failing archive append fails the batch BEFORE any Event Hubs
 * checkpoint advances (durable-before-checkpoint). With NO Azure env vars,
 * the local SSE demo path remains unchanged. Partial cloud configuration
 * fails closed and cannot start the synthetic producer. No football
 * semantics live here.
 */

export interface AzureRuntimeResult {
  readonly started: boolean;
  readonly detail: string;
}

export interface AzureRuntimeStatus {
  readonly active: boolean;
  readonly detail: string;
  readonly replayedEnvelopes: number;
  readonly archivedBatches: number;
  readonly ownershipGeneration?: string;
}

// Capture the shared object, never a copy of its mutable fields.
const state = liveProcessState().azure;

export function azureRuntimeStatus(): AzureRuntimeStatus {
  // Also check the deadline on HTTP reads: a delayed timer/event-loop pause
  // must not let a resumed process report an expired owner as ready.
  try {
    state.ownership?.assertOwned();
  } catch {
    state.controller?.abort();
  }
  return state.status;
}

/** Stop the background consumer and await its resource cleanup. No restart in this process. */
export async function stopAzureLiveWorker(): Promise<void> {
  state.controller?.abort();
  await state.task;
}

export interface AzureRuntimeDeps {
  exitProcess?: (code: number) => void;
  startIngestion: typeof startEventHubsIngestion;
  broadcast: typeof broadcastViaWebPubSub;
  createArchive: (config: AzureLiveConfig, signal?: AbortSignal) => Promise<DurableArchive>;
  getService: () => {
    ingest(batch: readonly StreamEnvelope[]): void;
    setPublishHook(hook: ((frame: LiveFrame) => void) | null): void;
    beginExternalSession(sessionId?: string): void;
    endExternalSession(detail: string): void;
    readonly status: { running: boolean };
  };
}

export const defaultAzureRuntimeDeps: AzureRuntimeDeps = (state.deps ??= {
  exitProcess: (code) => process.exit(code),
  startIngestion: startEventHubsIngestion,
  broadcast: broadcastViaWebPubSub,
  createArchive: (config, signal) => acquireOwnedArchive(config, signal ? { signal } : {}),
  getService: () => LiveMatchService.get(),
});

/**
 * Start the Azure live worker if — and ONLY if — the deployed env contract
 * is complete. The process-global guard makes overlapping startup calls
 * no-ops: exactly one authoritative consumer/session per process. Scheduling
 * returns immediately; archive recovery and the consumer lifetime must NEVER
 * hold Next.js register() open. Readiness stays false until a receive succeeds.
 */
export async function maybeStartAzureLiveWorker(
  env: { readonly [key: string]: string | undefined },
  deps: AzureRuntimeDeps = defaultAzureRuntimeDeps,
): Promise<AzureRuntimeResult> {
  const config = azureConfigFromEnv(env);
  if (config === null) {
    state.status = {
      ...state.status,
      detail: azureModeRequested(env)
        ? 'incomplete Azure configuration — ingestion disabled'
        : 'azure live env contract absent — local mode only',
    };
    return { started: false, detail: state.status.detail };
  }
  if (state.startupAttempted) {
    return { started: false, detail: 'azure live worker already attempted in this process' };
  }
  state.startupAttempted = true;
  const service = deps.getService();
  const controller = new AbortController();
  state.controller = controller;
  state.status = { ...state.status, active: false, detail: 'cloud ingestion starting' };

  const shutdown = (): void => {
    // Next's automatic signal cleanup calls process.exit independently of this
    // task. The cloud template disables that cleanup; Node is PID 1 and exits
    // here only AFTER processing/broadcast drain and lease cleanup.
    void stopAzureLiveWorker()
      .then(() => {
        if (env.NEXT_MANUAL_SIG_HANDLE === '1') deps.exitProcess?.(0);
      })
      .catch((error) => {
        console.error('[live] cloud shutdown failed:', String(error).slice(0, 160));
        if (env.NEXT_MANUAL_SIG_HANDLE === '1') deps.exitProcess?.(1);
      });
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
  state.task = runAzureLiveWorker(config, deps, service, controller).finally(() => {
    process.removeListener('SIGTERM', shutdown);
    process.removeListener('SIGINT', shutdown);
  });
  return { started: true, detail: 'cloud ingestion starting in background' };
}

async function runAzureLiveWorker(
  config: AzureLiveConfig,
  deps: AzureRuntimeDeps,
  service: ReturnType<AzureRuntimeDeps['getService']>,
  controller: AbortController,
): Promise<void> {
  const { signal } = controller;
  let ownsSession = false;
  let archive: DurableArchive | undefined;
  let failure: unknown;
  let batchIndex = 0;
  let replayedCount = 0;
  let batchTail: Promise<void> = Promise.resolve();
  const pending = new Set<Promise<void>>();
  const track = (task: Promise<void>): Promise<void> => {
    pending.add(task);
    void task.then(
      () => pending.delete(task),
      () => pending.delete(task),
    );
    return task;
  };
  const endSession = (): void => {
    if (!ownsSession) return;
    service.setPublishHook(null);
    service.endExternalSession('cloud ingestion ended');
    ownsSession = false;
  };
  const onAbort = (): void => {
    state.status = {
      ...state.status,
      active: false,
      detail:
        failure === undefined
          ? 'cloud ingestion stopping'
          : `cloud ingestion failed: ${String(failure).slice(0, 160)}`,
    };
    endSession();
  };
  const fail = (error: unknown): void => {
    failure = error;
    controller.abort();
  };
  const onOwnershipLost = (): void => fail(archive?.ownership?.signal.reason);
  const assertAuthority = (): void => {
    signal.throwIfAborted();
    archive?.ownership?.assertOwned();
  };
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    state.status = { ...state.status, detail: 'acquiring match ownership' };
    // Do not abandon an acquisition/recovery promise on shutdown. A late
    // acquisition must be cleaned up, not become a leaked renewable owner.
    archive = await deps.createArchive(config, signal);
    state.ownership = archive.ownership;
    archive.ownership?.signal.addEventListener('abort', onOwnershipLost, { once: true });
    assertAuthority();
    const replayed = await archive.readBatches();
    assertAuthority();
    if (service.status.running) throw new Error('another stream session is already running');
    const generation = archive.ownership?.generation;
    service.beginExternalSession(
      generation === undefined ? undefined : `cloud-${generation}-${randomUUID()}`,
    );
    ownsSession = true;
    state.status = {
      active: false,
      detail: 'cloud session starting — awaiting successful event hubs receive',
      replayedEnvelopes: 0,
      archivedBatches: 0,
      ...(generation === undefined ? {} : { ownershipGeneration: generation }),
    };
    for (const batch of replayed) {
      assertAuthority();
      service.ingest(batch);
      replayedCount += batch.length;
      state.status = { ...state.status, replayedEnvelopes: replayedCount };
    }
    service.setPublishHook((frame) => {
      if (signal.aborted || !ownsSession) return;
      const task = Promise.resolve()
        .then(async () => {
          assertAuthority();
          await deps.broadcast(config, frame, signal);
        })
        .catch((error: unknown) => {
          console.error('[live] web pubsub broadcast failed:', String(error).slice(0, 160));
        });
      track(task); // best-effort delivery, but shutdown must drain issued sends
    });
    await deps.startIngestion(
      config,
      (batch) => {
        // Serialize admission as well as commits; even concurrent SDK callbacks
        // cannot admit batch N+1 before N. Retired callbacks fail at the gate.
        const task = batchTail.then(async () => {
          assertAuthority();
          if (!ownsSession) throw new Error('cloud session ended');
          await archive!.appendEnvelopes(batch); // immutable upload THEN fenced commit
          assertAuthority();
          if (!ownsSession) throw new Error('cloud session ended');
          batchIndex += 1;
          state.status = { ...state.status, archivedBatches: batchIndex };
          service.ingest(batch);
        });
        batchTail = task.catch(fail);
        return track(task);
      },
      signal,
      undefined,
      {
        assertOwned: assertAuthority,
        onReady: () => {
          assertAuthority();
          if (ownsSession)
            state.status = { ...state.status, active: true, detail: 'cloud ingestion active' };
        },
        onError: fail,
      },
    );
  } catch (error) {
    if (!signal.aborted) failure = error;
    controller.abort();
  } finally {
    controller.abort();
    endSession();
    // Ownership renewal continues until all processing, checkpoint callbacks
    // (drained by the adapter), and sends have settled. On lease loss, delayed
    // uploads can finish only as orphans: the commit blob rejects the old lease.
    while (pending.size > 0) await Promise.allSettled([...pending]);
    archive?.ownership?.signal.removeEventListener('abort', onOwnershipLost);
    try {
      await archive?.ownership?.close();
    } catch (error) {
      failure ??= error;
    }
    state.ownership = undefined;
    signal.removeEventListener('abort', onAbort);
    state.status = {
      ...state.status,
      active: false,
      detail:
        failure === undefined
          ? 'cloud ingestion stopped'
          : `cloud ingestion failed: ${String(failure).slice(0, 160)}`,
      replayedEnvelopes: replayedCount,
      archivedBatches: batchIndex,
    };
    if (failure !== undefined)
      console.error('[live] event hubs ingestion failed:', String(failure).slice(0, 160));
  }
}
