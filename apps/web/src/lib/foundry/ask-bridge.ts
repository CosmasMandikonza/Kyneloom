/**
 * KYN-15 — the Ask → Foundry bridge. Runs the multi-agent workflow when
 * Foundry is enabled; maps the outcome onto the EXISTING AskMomentOutcome
 * shape so /studio/compile rebinds unchanged (stage, cues, recap, hash) —
 * plus a compact provenance summary the UI can show. Provider failures map
 * to an honest unsupported/needs-review outcome; the last valid stage
 * artifact is retained by the client owner (unchanged law).
 */

import type { AskMomentOutcome } from '@/lib/ask-intent-shared';
import { createLiveFoundryProvider, type FoundryEnvConfig } from './live-provider';
import { runFoundryExperience, type FoundryRunResult } from './orchestrator';
import { createInMemoryJobStore } from './job-store';
import type { FoundryProvider } from './provider';
import type { FoundryJobStore } from './job-store';

export const FOUNDRY_RESOLVER_LABEL =
  'Microsoft Foundry multi-agent · UNVERIFIED (no authorized project)';

export interface FoundryAskExtras {
  readonly resolver: string;
  readonly jobId: string | null;
  readonly agentRoles: readonly string[];
  readonly correctionOccurred: boolean;
  readonly verifiedEvidenceIds: readonly string[];
  readonly turns: { role: string; requestId: string | null; latencyMs: number }[];
  readonly jobStatus: string;
}

export type FoundryAskOutcome = AskMomentOutcome & { readonly foundry?: FoundryAskExtras };

/** Test seam: inject provider/store (tests drive the REAL orchestrator). */
export async function runFoundryAsk(
  prompt: string,
  provider: FoundryProvider,
  store: FoundryJobStore,
): Promise<{ outcome: FoundryAskOutcome; run: FoundryRunResult }> {
  const run = await runFoundryExperience(prompt, provider, store);
  const extras: FoundryAskExtras = {
    resolver: FOUNDRY_RESOLVER_LABEL,
    jobId: run.job.jobId,
    agentRoles: run.provenance.agentRoles,
    correctionOccurred: run.provenance.correctionOccurred,
    verifiedEvidenceIds: run.provenance.verifiedEvidenceIds,
    turns: run.provenance.turns.map((turn) => ({
      role: turn.role,
      requestId: turn.requestId,
      latencyMs: turn.latencyMs,
    })),
    jobStatus: run.job.status,
  };
  if (run.status === 'completed' && run.compile !== null && run.compile.ok) {
    return {
      run,
      outcome: {
        ok: true,
        routeVersion: 'kyneloom-ask-intent-v1',
        resolver: FOUNDRY_RESOLVER_LABEL,
        intentId: 'foundry-experience',
        sourceEventIds: [],
        evidenceIds: run.provenance.verifiedEvidenceIds,
        claimIds: [],
        explanation: run.explanation ?? 'Compiled from the multi-agent workflow.',
        evidenceNote: `Challenged by the editorial agent${run.provenance.correctionOccurred ? ' and repaired once' : ''}; verified by the deterministic compiler. Status: draft, approval null.`,
        focusPlayheadMs: run.focusPlayheadMs ?? 0,
        result: run.compile,
        foundry: extras,
      },
    };
  }
  return {
    run,
    outcome: {
      ok: false,
      routeVersion: 'kyneloom-ask-intent-v1',
      resolver: FOUNDRY_RESOLVER_LABEL,
      kind: 'unsupported',
      message:
        run.job.errorMessage ??
        'The Foundry workflow could not produce a verified experience — the current moment is unchanged.',
      supportedExamples: [],
      foundry: extras,
    },
  };
}

/** Production path used by the Ask route when Foundry is enabled. */
export async function resolveAskMomentViaFoundry(
  prompt: string,
  config: FoundryEnvConfig,
): Promise<FoundryAskOutcome> {
  const provider = createLiveFoundryProvider(config);
  // Job durability FAILS CLOSED: without authorized Blob storage the run is
  // ephemeral and that limitation is reported, not hidden. (Tests inject a
  // store; production storage wiring lands with the authorized resource.)
  const store = createInMemoryJobStore();
  const { outcome } = await runFoundryAsk(prompt, provider, store);
  if (outcome.ok !== true) {
    return {
      ...outcome,
      message: `${outcome.message} (Job persistence: ephemeral — Azure Blob job store requires authorized storage; provider live status: ${provider.kind}.)`,
    };
  }
  return outcome;
}
