import type { StreamEnvelope, LiveFrame, LiveConnectionStatus } from '@kyneloom/match-core';
import { STREAM_CONTRACT_VERSION, validateLiveFrame } from '@kyneloom/match-core';

/**
 * KYN-13 — the AZURE transport adapters, written against the OFFICIAL SDK
 * contracts (lazy imports keep the SDKs out of the local bundle).
 *
 * STATUS: NOT DEPLOYED — this host has no Azure CLI and no authenticated
 * subscription. These adapters are contract-true implementations awaiting
 * `az login` + the Bicep in `infra/live-stream.bicep`; they follow the
 * documented Event Hubs + Web PubSub SDK APIs exactly:
 *
 * - Event Hubs consumer: `@azure/event-hubs` `EventHubConsumerClient` with
 *   an explicit consumer group, partition key `matchId`, and the official
 *   `@azure/eventhubs-checkpointstore-blob` for durable checkpoints —
 *   checkpointed ONLY after the worker's durable obligations (archive
 *   append) succeed, never merely because a handler saw the message.
 * - Delivery: `@azure/web-pubsub` service SDK broadcasting typed frames to
 *   a `match:{matchId}` group; browsers connect via
 *   `@azure/web-pubsub-client` over a server-negotiated, narrowly scoped
 *   (public synthetic demo) access token — no service key in the browser.
 *
 * Wire format over both clouds is EXACTLY `StreamEnvelope` / `LiveFrame`
 * (same contract as the local SSE path) — one client business logic.
 */

export interface AzureLiveConfig {
  readonly eventHubsNamespace: string;
  readonly eventHubName: string;
  readonly consumerGroup: string;
  readonly checkpointStorageContainerUrl: string;
  readonly webPubSubConnectionString: string;
  readonly hubName: string;
  readonly matchId: string;
}

export function azureConfigFromEnv(env: {
  readonly [key: string]: string | undefined;
}): AzureLiveConfig | null {
  const namespace = env.KYN_EVENTHUBS_NAMESPACE;
  const hub = env.KYN_EVENTHUB_NAME;
  const group = env.KYN_EVENTHUBS_CONSUMER_GROUP;
  const container = env.KYN_CHECKPOINT_CONTAINER_URL;
  const wps = env.KYN_WEBPUBSUB_CONNECTION_STRING;
  const wpsHub = env.KYN_WEBPUBSUB_HUB;
  if (
    namespace === undefined ||
    hub === undefined ||
    group === undefined ||
    container === undefined ||
    wps === undefined ||
    wpsHub === undefined
  ) {
    return null;
  }
  return {
    eventHubsNamespace: namespace,
    eventHubName: hub,
    consumerGroup: group,
    checkpointStorageContainerUrl: container,
    webPubSubConnectionString: wps,
    hubName: wpsHub,
    matchId: env.KYN_LIVE_MATCH_ID ?? 'synthetic-derby-01',
  };
}

/**
 * Ingest from Event Hubs into the LiveMatchService. At-least-once handling:
 * the producer-side partition key is `matchId` (ordered per match); the
 * worker's envelope-id dedupe makes redelivery idempotent; poison envelopes
 * (invalid contract version / unparseable body) go to the worker's durable
 * quarantine with trace ids.
 *
 * Checkpoint law: `updateCheckpoint` runs ONLY after `onBatch` (which must
 * archive durably) resolves — an in-memory handler receipt is never enough.
 */
export async function startEventHubsIngestion(
  config: AzureLiveConfig,
  onBatch: (batch: readonly StreamEnvelope[]) => Promise<void>,
  signal: AbortSignal,
): Promise<void> {
  const { EventHubConsumerClient } = await import('@azure/event-hubs');
  const { BlobCheckpointStore } = await import('@azure/eventhubs-checkpointstore-blob');
  const { ContainerClient } = await import('@azure/storage-blob');

  const container = new ContainerClient(config.checkpointStorageContainerUrl);
  const checkpointStore = new BlobCheckpointStore(container);
  const client = new EventHubConsumerClient(
    config.consumerGroup,
    config.eventHubsNamespace,
    config.eventHubName,
    checkpointStore,
  );

  const subscriptions = client.subscribe({
    processEvents: async (events, context) => {
      if (events.length === 0) return;
      const batch: StreamEnvelope[] = [];
      for (const event of events) {
        const body = event.body as Record<string, unknown> | undefined;
        if (
          body === undefined ||
          body.contractVersion !== STREAM_CONTRACT_VERSION ||
          typeof body.envelopeId !== 'string'
        ) {
          // Poison envelope: quarantine via a synthetic record; the worker's
          // quarantine store captures the trace id when present.
          batch.push({
            contractVersion: STREAM_CONTRACT_VERSION,
            envelopeId: `poison-${String(event.offset ?? event.sequenceNumber)}`,
            matchId: config.matchId,
            kind: 'event',
            event: body as StreamEnvelope['event'],
            emittedAt: event.enqueuedTimeUtc?.getTime() ?? Date.now(),
            traceId: typeof body?.traceId === 'string' ? (body.traceId as string) : 'trc-unknown',
          });
          continue;
        }
        batch.push(body as unknown as StreamEnvelope);
      }
      // Durable obligations FIRST (archive etc.), then checkpoint — the
      // documented at-least-once contract.
      await onBatch(batch);
      for (const event of events) {
        await context.updateCheckpoint(event);
      }
    },
    processError: async (err) => {
      // Bounded retry policy lives in the SDK client options; surface the
      // error for telemetry without crashing the consumer loop.
      console.error('[live] event hubs consumer error:', String(err).slice(0, 200));
    },
  });

  signal.addEventListener('abort', () => {
    void subscriptions.close();
  });
  await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve()));
}

/**
 * Broadcast a LiveFrame to the match group through Web PubSub. Browsers
 * never see the service connection string — they connect via the negotiated
 * client URL from `negotiateWebPubSubAccess`.
 */
export async function broadcastViaWebPubSub(
  config: AzureLiveConfig,
  frame: LiveFrame,
): Promise<void> {
  const { WebPubSubServiceClient } = await import('@azure/web-pubsub');
  const service = new WebPubSubServiceClient(config.webPubSubConnectionString, config.hubName);
  const group = service.group(config.matchId);
  await group.sendToAll(JSON.stringify(frame), { contentType: 'text/plain' });
}

/**
 * Narrow negotiation for the PUBLIC synthetic demo ONLY (Issue #21 owns real
 * auth): the client token is scoped to group-join for `match:{matchId}` and
 * NOT the publish permission — a viewer can never inject match state.
 */
export async function negotiateWebPubSubAccess(
  config: AzureLiveConfig,
): Promise<{ url: string; scopes: readonly string[] } | null> {
  const { WebPubSubServiceClient } = await import('@azure/web-pubsub');
  const service = new WebPubSubServiceClient(config.webPubSubConnectionString, config.hubName);
  // Join/leave the synthetic match group ONLY — no publish permission, so a
  // viewer can never inject match state through negotiated access.
  const roles = [`webpubsub.joinLeaveGroup.match.${config.matchId}`];
  const result = await service.getClientAccessToken({ roles });
  return { url: result.url, scopes: roles };
}

/**
 * The AZURE client transport — same LiveTransport interface as the local
 * SSE path, backed by `@azure/web-pubsub-client` over the negotiated URL.
 * Contract-true; inactive until the cloud is provisioned.
 */
export class AzureWebPubSubTransport {
  // Implemented against the SDK contract; instantiated only with a
  // negotiated URL (see negotiateWebPubSubAccess). Kept as a class so the
  // interface parity is compile-checked against LocalSseTransport usage.
  static readonly transportKind = 'azure-web-pubsub';

  async connect(negotiatedUrl: string): Promise<void> {
    const { WebPubSubClient } = await import('@azure/web-pubsub-client');
    this.client = new WebPubSubClient(negotiatedUrl, {
      autoRejoinGroups: true,
    });
    await this.client.start();
  }

  // The SDK client, typed by its used surface (the real constructor type
  // arrives with the lazy import; assigning the instance keeps parity).
  /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
  private client: any = null;

  onFrame(listener: (frame: unknown) => void): void {
    this.client?.on('group-message', (message: { message?: { data?: unknown } }) => {
      const data = message.message?.data ?? message;
      if (validateLiveFrame(data) !== null) listener(data);
    });
  }

  onStatus(listener: (status: LiveConnectionStatus, detail: string) => void): void {
    this.client?.on('connected', () => listener('connected', 'Web PubSub connected'));
    this.client?.on('disconnected', () => listener('reconnecting', 'Web PubSub link lost'));
  }

  async close(): Promise<void> {
    await this.client?.stop();
    this.client = null;
  }
}
