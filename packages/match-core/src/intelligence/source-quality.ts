import type { TrackingSample } from '@kyneloom/contracts';
import type { EntityTimelineSample } from '../reducer/timeline';
import type { MetricFailureCode } from './metric-result';

/**
 * KYN-12 shared source-quality policy — the match-core mirror of the
 * Evidence X-Ray policy shipped in KYN-08 (`SOURCE_QUALITY_POLICY` in
 * apps/web/src/lib/evidence-data.ts). The intelligence layer must not open a
 * weaker numerical-truth path than the verified X-Ray presentation.
 *
 * A (entity, time) endpoint may anchor a VERIFIED measurement only when:
 *
 * 1. EXISTENCE — exactly one accepted raw sample exists for the pair. Zero
 *    is missing data; two is ambiguous identity. Either withholds.
 * 2. VISIBILITY — the sample is `tracked`. A `partial` (reconstructed)
 *    sample can never anchor a verified number.
 * 3. CONFIDENCE — ≥ 0.9. Below the threshold the source itself is not
 *    confident enough; the offending value is named, never averaged up.
 * 4. ORIGIN — the declared origin must be eligible for the assurance tier.
 *    For the current verified synthetic presentation that is exactly
 *    `synthetic_ground_truth`. Observed or mixed inputs are never
 *    mislabeled: an `observed`-eligible policy may be attached when
 *    licensed observed data exists (future); today such inputs withhold
 *    verified status.
 *
 * Interpolated timeline poses (origin 'interpolated') may only produce
 * DISCLOSED results, never verified ones.
 */

export interface EndpointCheck {
  readonly ok: boolean;
  readonly code?: MetricFailureCode;
  readonly detail?: string;
}

export interface EndpointContext {
  readonly entityId: string;
  readonly atMs: number;
}

/** Raw-sample gate: existence + visibility + confidence on accepted tracking. */
export function checkRawEndpoint(
  tracking: readonly TrackingSample[],
  context: EndpointContext,
  options: { minConfidence?: number } = {},
): EndpointCheck {
  const minConfidence = options.minConfidence ?? 0.9;
  const matches = tracking.filter(
    (sample) => sample.entityId === context.entityId && sample.sampleTimeMs === context.atMs,
  );
  if (matches.length === 0) {
    return {
      ok: false,
      code: 'missing-tracking',
      detail: `no accepted sample for ${context.entityId} at ${String(context.atMs)} ms`,
    };
  }
  if (matches.length > 1) {
    return {
      ok: false,
      code: 'ambiguous-identity',
      detail: `${String(matches.length)} conflicting samples for ${context.entityId} at ${String(context.atMs)} ms`,
    };
  }
  const sample = matches[0]!;
  if (sample.visibility !== 'tracked') {
    return {
      ok: false,
      code: 'partial-visibility',
      detail: `${context.entityId}@${String(context.atMs)} visibility '${sample.visibility}' cannot anchor a verified measurement`,
    };
  }
  if (sample.confidence < minConfidence) {
    return {
      ok: false,
      code: 'low-confidence',
      detail: `${context.entityId}@${String(context.atMs)} confidence ${String(sample.confidence)} < ${String(minConfidence)}`,
    };
  }
  return { ok: true };
}

/** Origin gate: is this declared origin eligible for VERIFIED assurance? */
export function originEligibleForVerified(origin: string): boolean {
  // The current corpus is synthetic ground truth only. When licensed
  // observed data lands, register its eligibility here — never by weakening
  // this check at call sites.
  return origin === 'synthetic_ground_truth';
}

/**
 * Classify a timeline pose for metric use. Exact + verified-eligible origin
 * → 'exact'; interpolated → 'interpolated' (disclosed only); anything else
 * (missing/extrapolated) → 'unusable' (withhold).
 */
export function classifyPose(
  pose: EntityTimelineSample | undefined,
): 'exact' | 'interpolated' | 'unusable' {
  if (pose === undefined) return 'unusable';
  if (pose.exact && originEligibleForVerified(pose.origin)) return 'exact';
  if (pose.origin === 'interpolated') return 'interpolated';
  return 'unusable';
}
