import type { TrackingSample } from '@kyneloom/contracts';
import { separationFromTimeline, SEPARATION_ALGORITHM_VERSION } from '../reducer/metric-separation';
import type { Timeline } from '../reducer/timeline';
import { checkRawEndpoint } from './source-quality';
import {
  metricFingerprint,
  metricIdFor,
  type MetricInsufficientEvidence,
  type MetricResult,
} from './metric-result';

/**
 * Metric B — player separation delta, as a MetricResult.
 *
 * This is a THIN ADAPTER over the canonical KYN-04 implementation
 * (`separationFromTimeline`, algorithm `kyneloom-separation-v1`). The X-Ray
 * contract, fingerprints and verification behavior are preserved exactly:
 * the adapter adds the shared MetricResult envelope (units, dependencies,
 * coverage, interpretation boundary) plus the KYN-08 source-quality gate on
 * the four endpoint samples — the same gate the web-layer Evidence X-Ray
 * applies. No alternate formula exists here, so the conflicting 14.037
 * display can never reappear from this path.
 */

export interface SeparationDeltaValue {
  readonly beforeM: number;
  readonly afterM: number;
  readonly deltaM: number;
  readonly defenderId: string;
  readonly strikerId: string;
}

export type SeparationDeltaResult = MetricResult<SeparationDeltaValue>;

export interface SeparationDeltaInput {
  readonly matchId: string;
  readonly defenderId: string;
  readonly strikerId: string;
  readonly fromMs: number;
  readonly toMs: number;
}

export function separationDelta(
  timeline: Timeline,
  tracking: readonly TrackingSample[],
  reducerRevision: number,
  input: SeparationDeltaInput,
): SeparationDeltaResult {
  const entityIds = [input.defenderId, input.strikerId];
  const metricId = metricIdFor('separation-delta', input.matchId, entityIds, {
    windowMs: [input.fromMs, input.toMs],
  });

  const insufficient = (
    code: MetricInsufficientEvidence['failure']['code'],
    detail: string,
  ): SeparationDeltaResult => ({
    status: 'insufficient-evidence',
    provenance: {
      kind: 'separation-delta',
      algorithmVersion: SEPARATION_ALGORITHM_VERSION,
      metricId,
      matchId: input.matchId,
      reducerRevision,
      entityIds,
      units: 'metres',
      requested: { windowMs: [input.fromMs, input.toMs] as const },
      dependsOn: { sourceFrameIds: [], eventIds: [], entityIds },
      sourceOrigin: 'synthetic_ground_truth',
      classification: 'calculated',
      coverage: { exactSamples: 0, interpolatedSamples: 0, missingEntityIds: entityIds },
      inputFingerprint: metricFingerprint(SEPARATION_ALGORITHM_VERSION, {
        metricId,
        withheld: code,
      }),
      interpretationBoundary:
        'Distance change is a measured fact; tactical causality (intent, lane creation) remains a hypothesis.',
    },
    failure: { code, detail },
  });

  // Source-quality gate on the four endpoint samples (KYN-08 parity).
  for (const entityId of entityIds) {
    for (const atMs of [input.fromMs, input.toMs]) {
      const gate = checkRawEndpoint(tracking, { entityId, atMs });
      if (!gate.ok) {
        return insufficient(gate.code ?? 'missing-tracking', gate.detail ?? '');
      }
    }
  }

  const canonical = separationFromTimeline(timeline, input);
  if (!canonical.ok) {
    return insufficient('missing-tracking', canonical.detail);
  }
  const evidence = canonical.evidence;

  return {
    status: 'verified',
    assurance: 'exact-source',
    provenance: {
      kind: 'separation-delta',
      algorithmVersion: SEPARATION_ALGORITHM_VERSION,
      metricId,
      matchId: input.matchId,
      reducerRevision,
      entityIds,
      units: 'metres',
      requested: { windowMs: [input.fromMs, input.toMs] as const },
      dependsOn: {
        sourceFrameIds: [...evidence.dependsOn.sourceFrameIds],
        eventIds: [],
        entityIds: [...evidence.dependsOn.entityIds],
      },
      sourceOrigin: evidence.basis,
      classification: evidence.classification,
      coverage: { exactSamples: 4, interpolatedSamples: 0, missingEntityIds: [] },
      // The canonical record's fingerprint IS the fingerprint (single source
      // of numerical truth — the adapter never re-derives it).
      inputFingerprint: evidence.inputFingerprint,
      interpretationBoundary: evidence.hypothesisBoundary,
    },
    value: {
      beforeM: evidence.separationBeforeM,
      afterM: evidence.separationAfterM,
      deltaM: evidence.deltaM,
      defenderId: evidence.defenderId,
      strikerId: evidence.strikerId,
    },
  };
}
