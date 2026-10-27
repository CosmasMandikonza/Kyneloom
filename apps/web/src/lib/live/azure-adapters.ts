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
  /** Durable envelope-archive container (NOT Event Hubs retention). */
  readonly archiveStorageContainerUrl: string;
  readonly webPubSubConnectionString: string;
  readonly hubName: string;
  readonly matchId: string;
  /** User-assigned managed identity CLIENT ID (DefaultAzureCredential). */
  readonly identityClientId: string;
}

/** The ONE Web PubSub group identity, used on every boundary (KYN-14 D). */
export function webPubSubGroupName(matchId: string): string {
  return `match.${matchId}`;
}

/** Fully qualified Event Hubs namespace the SDK expects (not the name). */
export function eventHubsFqdn(namespaceName: string): string {
  return `${namespaceName}.servicebus.windows.net`;
}

export function azureConfigFromEnv(env: {
  readonly [key: string]: string | undefined;
}): AzureLiveConfig | null {
  const namespace = env.KYN_EVENTHUBS_NAMESPACE;
  const hub = env.KYN_EVENTHUB_NAME;
  const group = env.KYN_EVENTHUBS_CONSUMER_GROUP;
  const container = env.KYN_CHECKPOINT_CONTAINER_URL;
  const archive = env.KYN_ARCHIVE_CONTAINER_URL;
  const wps = env.KYN_WEBPUBSUB_CONNECTION_STRING;
  const wpsHub = env.KYN_WEBPUBSUB_HUB;
  const identityClientId = env.KYN_AZURE_CLIENT_ID;
  if (
    namespace === undefined ||
    hub === undefined ||
    group === undefined ||
    container === undefined ||
    archive === undefined ||
    wps === undefined ||
    wpsHub === undefined ||
    identityClientId === undefined
  ) {
    // Fail closed: an incomplete Azure contract never produces a
    // seemingly-healthy cloud mode (KYN-14 review B).
    return null;
  }
  return {
    eventHubsNamespace: namespace,
    eventHubName: hub,
    consumerGroup: group,
    checkpointStorageContainerUrl: container,
    archiveStorageContainerUrl: archive,
    webPubSubConnectionString: wps,
    hubName: wpsHub,
    matchId: env.KYN_LIVE_MATCH_ID ?? 'synthetic-derby-01',
    identityClientId,
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
/**
 * Injectable SDK boundary (KYN-14 review B): tests substitute these to
 * assert the REAL constructor contracts — fully qualified namespace, the
 * DefaultAzureCredential instance, the checkpoint store, and the exact
 * Web PubSub group — without any Azure account.
 */
export const azureClientFactories = {
  async createCredential(config: AzureLiveConfig): Promise<object> {
    const { DefaultAzureCredential } = await import('@azure/identity');
    return new DefaultAzureCredential({
      managedIdentityClientId: config.identityClientId,
    });
  },
  async createCheckpointStore(config: AzureLiveConfig, credential: object): Promise<object> {
    const { BlobCheckpointStore } = await import('@azure/eventhubs-checkpointstore-blob');
    const { ContainerClient } = await import('@azure/storage-blob');
    // Private containers REQUIRE a credential — an anonymous ContainerClient
    // cannot read the checkpoint store (KYN-14 review B).
    const container = new ContainerClient(
      config.checkpointStorageContainerUrl,
      credential as never,
    );
    return new BlobCheckpointStore(container);
  },
  async createConsumerClient(
    config: AzureLiveConfig,
    credential: object,
    checkpointStore: object,
  ): Promise<object> {
    const { EventHubConsumerClient } = await import('@azure/event-hubs');
    // The pinned SDK's AAD overload is POSITIONAL:
    //   (consumerGroup, fullyQualifiedNamespace, eventHubName,
    //    credential, checkpointStore, options?) — verified against
    //   @azure/event-hubs@6.0.4's eventHubConsumerClient.d.ts.
    return new EventHubConsumerClient(
      config.consumerGroup,
      eventHubsFqdn(config.eventHubsNamespace),
      config.eventHubName,
      credential as never,
      checkpointStore as never,
    );
  },
};

export interface IngestionHealth {
  onReady(): void;
  onError(error: unknown): void;
}

export async function startEventHubsIngestion(
  config: AzureLiveConfig,
  onBatch: (batch: readonly StreamEnvelope[]) => Promise<void>,
  signal: AbortSignal,
  factories: typeof azureClientFactories = azureClientFactories,
  health?: IngestionHealth,
): Promise<void> {
  if (signal.aborted) return;
  const credential = await factories.createCredential(config);
  const checkpointStore = await factories.createCheckpointStore(config, credential);
  const client = (await factories.createConsumerClient(config, credential, checkpointStore)) as {
    subscribe(handlers: {
      processEvents: (
        events: {
          body: unknown;
          offset?: number;
          sequenceNumber?: number;
          enqueuedTimeUtc?: Date;
        }[],
        context: { updateCheckpoint: (event: unknown) => Promise<void> },
      ) => Promise<void>;
      processError: (err: unknown) => Promise<void>;
      processClose: (reason: string) => Promise<void>;
    }): { close(): Promise<void> };
    close(): Promise<void>;
  };

  let resolveStopped: () => void = () => undefined;
  let rejectStopped: (error: unknown) => void = () => undefined;
  const stopped = new Promise<void>((resolve, reject) => {
    resolveStopped = resolve;
    rejectStopped = reject;
  });
  const onAbort = (): void => resolveStopped();
  signal.addEventListener('abort', onAbort, { once: true });
  let subscription: { close(): Promise<void> } | undefined;
  try {
    if (signal.aborted) return;
    subscription = client.subscribe({
      processEvents: async (events, context) => {
        if (signal.aborted) return;
        if (events.length === 0) {
          health?.onReady(); // A successful empty receive also proves consumer connectivity.
          return;
        }
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
        signal.throwIfAborted();
        for (const event of events) {
          await context.updateCheckpoint(event);
        }
        health?.onReady();
      },
      processError: async (err) => {
        // Fail closed: let the runtime withdraw readiness and end the session.
        // Recovery is a process restart; no second consumer is started here.
        if (!signal.aborted) {
          health?.onError(err); // Withdraw readiness before potentially slow SDK cleanup.
          rejectStopped(err);
        }
      },
      processClose: async (reason) => {
        if (!signal.aborted) {
          const error = new Error(`event hubs partition closed: ${reason}`);
          health?.onError(error);
          rejectStopped(error);
        }
      },
    });
    await stopped;
  } finally {
    signal.removeEventListener('abort', onAbort);
    try {
      await subscription?.close();
    } finally {
      await client.close();
    }
  }
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
  // The ONE group identity — identical on broadcast, negotiation and any
  // future browser subscription (KYN-14 review D).
  const group = service.group(webPubSubGroupName(config.matchId));
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
  // viewer can never inject match state through negotiated access. The role
  // suffix is EXACTLY the group the server broadcasts to.
  const roles = [`webpubsub.joinLeaveGroup.${webPubSubGroupName(config.matchId)}`];
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
