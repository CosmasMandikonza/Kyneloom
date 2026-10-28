/** Test-only Node preload. No application endpoint/env switch enables this.
 * next start still calls the compiled instrumentation register(). Override only
 * its existing Azure dependency boundary; keep the REAL service and reducer.
 */
import { threadId } from 'node:worker_threads';
import {
  defaultAzureRuntimeDeps,
  maybeStartAzureLiveWorker,
  stopAzureLiveWorker,
} from '../../apps/web/src/lib/live/azure-runtime';
import { startEventHubsIngestion } from '../../apps/web/src/lib/live/azure-adapters';
import { acquireOwnedArchive } from '../../apps/web/src/lib/live/owned-archive';
import { LiveMatchService } from '../../apps/web/src/lib/live/service';
import { ownedStorage, deferred } from '../../apps/web/src/lib/live/test-support/owned-storage';
import type { StreamEnvelope } from '@kyneloom/match-core';

export interface ProductionReply {
  id: number;
  ok: boolean;
  value?: unknown;
  error?: string;
}
interface Command {
  id: number;
  command: string;
  batch?: StreamEnvelope[];
}
type Handlers = {
  processEvents(
    events: { body: unknown; offset: number; sequenceNumber: number }[],
    context: { updateCheckpoint(event: unknown): Promise<void> },
  ): Promise<void>;
};
const storage = ownedStorage();
let handlers: Handlers | undefined;
let archiveStarts = 0;
let consumers = 0;
let checkpoints = 0;
let broadcasts = 0;
let broadcastGate: ReturnType<typeof deferred> | undefined;
const realExit = defaultAzureRuntimeDeps.exitProcess;
Object.assign(defaultAzureRuntimeDeps, {
  exitProcess: (code: number) => {
    process.send?.({ event: 'exit', code, leases: storage.leases.size }, () => realExit?.(code));
  },
  createArchive: async (config, signal) => {
    archiveStarts++;
    return acquireOwnedArchive(config, { createContainer: storage.createContainer, signal });
  },
  broadcast: async () => {
    broadcasts++;
    await broadcastGate?.promise;
  },
  startIngestion: (config, onBatch, signal, _factories, health) =>
    startEventHubsIngestion(
      config,
      onBatch,
      signal,
      {
        createCredential: async () => ({}),
        createCheckpointStore: async () => ({}),
        createConsumerClient: async () => ({
          subscribe(value: Handlers) {
            consumers++;
            handlers = value;
            return { close: async () => undefined };
          },
          close: async () => undefined,
        }),
      },
      health,
    ),
} satisfies Partial<typeof defaultAzureRuntimeDeps>);
const context = {
  updateCheckpoint: async () => {
    checkpoints++;
  },
};

process.on('message', (message: Command) => {
  void (async () => {
    switch (message.command) {
      case 'stats':
        return {
          pid: process.pid,
          threadId,
          archiveStarts,
          consumers,
          checkpoints,
          broadcasts,
          leases: storage.leases.size,
          service: LiveMatchService.get().status,
        };
      case 'ready':
        if (!handlers) throw new Error('consumer not initialized by instrumentation');
        await handlers.processEvents([], context);
        return true;
      case 'receive':
        if (!handlers) throw new Error('consumer not initialized by instrumentation');
        await handlers.processEvents(
          (message.batch ?? []).map((body, offset) => ({ body, offset, sequenceNumber: offset })),
          context,
        );
        return true;
      case 'lose':
        storage.failRenew(); // real renewal timer/SDK failure retires this owner
        return true;
      case 'repeat-start':
        return Promise.all(
          Array.from({ length: 10 }, () => maybeStartAzureLiveWorker(process.env)),
        );
      case 'block-broadcast':
        broadcastGate = deferred();
        return true;
      case 'release-broadcast':
        broadcastGate?.resolve();
        return true;
      case 'stop':
        await stopAzureLiveWorker();
        return true;
      case 'local-start':
        await LiveMatchService.get().start();
        return true;
      default:
        throw new Error('unknown test command');
    }
  })().then(
    (value) => process.send?.({ id: message.id, ok: true, value } satisfies ProductionReply),
    (error) =>
      process.send?.({
        id: message.id,
        ok: false,
        error: String(error),
      } satisfies ProductionReply),
  );
});
