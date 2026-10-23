import type { LiveFrame, StreamEnvelope } from '@kyneloom/match-core';
import {
  azureConfigFromEnv,
  broadcastViaWebPubSub,
  startEventHubsIngestion,
} from './azure-adapters';
import { LiveMatchService } from './service';

/**
 * KYN-14 — the Azure runtime seam. When the full adapter env contract is
 * present (deployed by infra/azure), the ONE service process runs the
 * cloud vertical slice IN-PROCESS:
 *
 *   Event Hubs ('reducer' consumer group) → onBatch → LiveMatchService
 *   .ingest (the SAME canonical worker + archive-before-checkpoint law as
 *   the local path) → broadcast → SSE subscribers AND the Web PubSub match
 *   group (publish hook).
 *
 * When ANY env var is missing (local development, this host), nothing
 * starts — the local SSE demo path is exactly as before. This module adds
 * NO football semantics: it is transport wiring only.
 */

export interface AzureRuntimeResult {
  readonly started: boolean;
  readonly detail: string;
}

export interface AzureRuntimeDeps {
  /** Ingestion loop (lazy SDK import in production). */
  startIngestion: typeof startEventHubsIngestion;
  /** Web PubSub frame fan-out (lazy SDK import in production). */
  broadcast: typeof broadcastViaWebPubSub;
  /** The singleton live service (transport wiring target). */
  getService: () => {
    ingest(batch: readonly StreamEnvelope[]): void;
    setPublishHook(hook: ((frame: LiveFrame) => void) | null): void;
  };
}

export const defaultAzureRuntimeDeps: AzureRuntimeDeps = {
  startIngestion: startEventHubsIngestion,
  broadcast: broadcastViaWebPubSub,
  getService: () => LiveMatchService.get(),
};

/**
 * Start the Azure live worker if — and ONLY if — the deployed env contract
 * is complete. Idempotent per process by construction (call once from the
 * Next.js instrumentation hook).
 */
export function maybeStartAzureLiveWorker(
  env: { readonly [key: string]: string | undefined },
  deps: AzureRuntimeDeps = defaultAzureRuntimeDeps,
): AzureRuntimeResult {
  const config = azureConfigFromEnv(env);
  if (config === null) {
    return { started: false, detail: 'azure live env contract absent — local mode only' };
  }
  const service = deps.getService();
  const controller = new AbortController();
  service.setPublishHook((frame) => {
    void deps.broadcast(config, frame).catch((error) => {
      console.error('[live] web pubsub broadcast failed:', String(error).slice(0, 160));
    });
  });
  void deps
    .startIngestion(
      config,
      async (batch) => {
        // Durable obligations (archive → projection → quarantine →
        // checkpoint locally recorded) complete inside ingest BEFORE the
        // consumer loop checkpoints the Event Hubs position (the adapter's
        // checkpoint-after-onBatch law).
        service.ingest(batch);
      },
      controller.signal,
    )
    .catch((error) => {
      console.error('[live] event hubs ingestion failed:', String(error).slice(0, 160));
    });
  return { started: true, detail: 'event hubs ingestion + web pubsub fan-out active' };
}
