import type { LiveFrame, StreamEnvelope } from '@kyneloom/match-core';
import {
  azureConfigFromEnv,
  broadcastViaWebPubSub,
  startEventHubsIngestion,
  type AzureLiveConfig,
} from './azure-adapters';
import { createBlobArchive, type DurableArchive } from './blob-archive';
import { LiveMatchService } from './service';

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
 * STARTUP (review C ordering): the durable archive is REPLAYED before the
 * session begins, so a restarted container reconstructs the authoritative
 * corpus instead of silently skipping source its Event Hubs checkpoints
 * already consumed. Only then does consumption start — a fresh external
 * session whose checkpoints begin where the replayed corpus ends.
 *
 * FAILURE LAWS: if ingestion start fails, the external session ENDS
 * truthfully (viewers see disconnected, never a fabricated healthy live
 * session); a failing archive append fails the batch BEFORE any Event Hubs
 * checkpoint advances (durable-before-checkpoint). When ANY env var is
 * missing (local development, this host) nothing starts — the local SSE
 * demo path is exactly as before. Transport wiring only: no football
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
}

/** Live diagnostics surfaced by /api/live/status (readiness honesty). */
let runtimeStatus: AzureRuntimeStatus = {
  active: false,
  detail: 'azure runtime not started (local mode)',
  replayedEnvelopes: 0,
  archivedBatches: 0,
};

export function azureRuntimeStatus(): AzureRuntimeStatus {
  return runtimeStatus;
}

/** Module-level single-start guard: one consumer per process, ever. */
let startupAttempted = false;

export interface AzureRuntimeDeps {
  startIngestion: typeof startEventHubsIngestion;
  broadcast: typeof broadcastViaWebPubSub;
  createArchive: (config: AzureLiveConfig) => Promise<DurableArchive>;
  getService: () => {
    ingest(batch: readonly StreamEnvelope[]): void;
    setPublishHook(hook: ((frame: LiveFrame) => void) | null): void;
    beginExternalSession(sessionId?: string): void;
    endExternalSession(detail: string): void;
    readonly status: { running: boolean };
  };
}

export const defaultAzureRuntimeDeps: AzureRuntimeDeps = {
  startIngestion: startEventHubsIngestion,
  broadcast: broadcastViaWebPubSub,
  createArchive: (config) => createBlobArchive(config),
  getService: () => LiveMatchService.get(),
};

/**
 * Start the Azure live worker if — and ONLY if — the deployed env contract
 * is complete. The module-level guard makes overlapping startup calls
 * no-ops: exactly one authoritative consumer/session per process.
 */
export async function maybeStartAzureLiveWorker(
  env: { readonly [key: string]: string | undefined },
  deps: AzureRuntimeDeps = defaultAzureRuntimeDeps,
): Promise<AzureRuntimeResult> {
  const config = azureConfigFromEnv(env);
  if (config === null) {
    runtimeStatus = {
      ...runtimeStatus,
      detail: 'azure live env contract absent — local mode only',
    };
    return { started: false, detail: 'azure live env contract absent — local mode only' };
  }
  if (startupAttempted) {
    return { started: false, detail: 'azure live worker already attempted in this process' };
  }
  startupAttempted = true;

  const service = deps.getService();
  const controller = new AbortController();
  let batchIndex = 0;
  let replayedCount = 0;
  try {
    const archive = await deps.createArchive(config);
    // 1. REPLAY the durable archive: reconstruct the authoritative corpus
    //    BEFORE the session begins (restart recovery law).
    const replayed = await archive.readAllEnvelopes();
    replayedCount = replayed.length;
    // 2. BEGIN the external session (new generation; NO local producer).
    service.beginExternalSession();
    runtimeStatus = {
      active: true,
      detail: 'cloud session active — event hubs ingestion starting',
      replayedEnvelopes: replayedCount,
      archivedBatches: 0,
    };
    if (replayed.length > 0) {
      service.ingest(replayed);
    }
    // 3. Fan out every authoritative frame to the Web PubSub match group.
    service.setPublishHook((frame) => {
      void deps.broadcast(config, frame).catch((error) => {
        console.error('[live] web pubsub broadcast failed:', String(error).slice(0, 160));
      });
    });
    // 4. Consume: durable archive append FIRST, then canonical admission —
    //    and the adapter checkpoints ONLY after this onBatch resolves.
    await deps.startIngestion(
      config,
      async (batch) => {
        await archive.appendEnvelopes(config.matchId, batchIndex, batch);
        batchIndex += 1;
        runtimeStatus = { ...runtimeStatus, archivedBatches: batchIndex };
        service.ingest(batch);
      },
      controller.signal,
    );
    // startIngestion resolves only on abort: end truthfully.
    service.endExternalSession('ingestion stopped');
    runtimeStatus = { ...runtimeStatus, active: false, detail: 'cloud ingestion ended' };
    return { started: false, detail: 'cloud ingestion ended' };
  } catch (error) {
    // Fail closed: no fabricated healthy session, truthful diagnostics.
    if (service.status.running) {
      service.endExternalSession('ingestion failed');
    }
    const reason = String(error).slice(0, 160);
    runtimeStatus = {
      active: false,
      detail: `cloud ingestion failed: ${reason}`,
      replayedEnvelopes: replayedCount,
      archivedBatches: batchIndex,
    };
    console.error('[live] event hubs ingestion failed:', reason);
    return { started: false, detail: `cloud ingestion failed: ${reason}` };
  }
}
