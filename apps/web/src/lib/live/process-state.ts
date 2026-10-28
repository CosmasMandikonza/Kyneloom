import type { ArchiveOwnership } from './blob-archive';
import type { AzureRuntimeDeps, AzureRuntimeStatus } from './azure-runtime';
import type { LiveMatchService } from './service';

interface LiveProcessState {
  service?: LiveMatchService;
  azure: {
    status: AzureRuntimeStatus;
    ownership?: ArchiveOwnership;
    startupAttempted: boolean;
    controller: AbortController | null;
    task: Promise<void> | null;
    deps?: AzureRuntimeDeps;
  };
}

// Next builds instrumentation and routes in different module contexts. Keep
// mutable authority here rather than on a module or class. Symbol.for shares
// the slot across bundles in ONE Node global; it is not cross-process/thread
// coordination. Blob's leased commit record remains the distributed fence.
const key = Symbol.for('kyneloom.live.process-state.v1');
const scope = globalThis as typeof globalThis & { [key]?: LiveProcessState };

export function liveProcessState(): LiveProcessState {
  return (scope[key] ??= {
    azure: {
      status: {
        active: false,
        detail: 'azure runtime not started (local mode)',
        replayedEnvelopes: 0,
        archivedBatches: 0,
      },
      startupAttempted: false,
      controller: null,
      task: null,
    },
  });
}
