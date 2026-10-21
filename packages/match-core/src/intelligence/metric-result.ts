import { canonicalJsonStringify } from '@kyneloom/contracts';
import { fnv1aHex } from '../reducer/metric-separation';

/**
 * KYN-12 — the versioned, self-proving MetricResult contract.
 *
 * Every deterministic football measurement in the intelligence layer returns
 * one of these. The design rules (docs/05, docs/07, docs/11):
 *
 * - **Zero is a value; missing is a status.** An unsupported measurement is
 *   `insufficient-evidence` with a machine-readable failure — NEVER a
 *   numeric 0 dressed up as a measurement.
 * - **Verified** means every source dependency satisfied the shared
 *   source-quality policy (exact, unambiguous, tracked, confidence ≥ 0.9,
 *   declared origin) at the current reducer revision.
 * - **Disclosed** means the number was computed but at least one input was
 *   interpolated (or otherwise below the verified bar); the result is
 *   usable for editorial exploration and MUST NOT be presented as a
 *   verified source measurement.
 * - Source confidence (this layer) is distinct from scorer confidence
 *   (candidates.ts): a hand-chosen ranking score is never a calibrated
 *   probability and is never labeled as one.
 * - The dependency fingerprint is stable for identical inputs (canonical
 *   serialization, sorted collections, no runtime timestamps).
 */

export type MetricKind =
  'nearest-opponent' | 'separation-delta' | 'passing-lane-occupancy' | 'off-ball-movement';

export type MetricUnits = 'metres' | 'metres_per_second' | 'entity_count' | 'seconds';

/** Source quality of the inputs that produced the result. */
export type MetricAssurance = 'exact-source' | 'includes-interpolation';

export type MetricSourceOrigin = 'synthetic_ground_truth' | 'source_observed' | 'mixed';

/** Every dependency a result was computed from (events + frames + entities). */
export interface MetricDependencies {
  readonly sourceFrameIds: readonly string[];
  readonly eventIds: readonly string[];
  readonly entityIds: readonly string[];
}

export interface MetricCoverage {
  readonly exactSamples: number;
  readonly interpolatedSamples: number;
  readonly missingEntityIds: readonly string[];
}

/** Provenance shared by every result, whatever its status. */
export interface MetricProvenance {
  readonly kind: MetricKind;
  readonly algorithmVersion: string;
  readonly metricId: string;
  readonly matchId: string;
  readonly reducerRevision: number;
  readonly entityIds: readonly string[];
  readonly units: MetricUnits;
  readonly requested: {
    readonly atMs?: number;
    readonly windowMs?: readonly [number, number];
  };
  readonly dependsOn: MetricDependencies;
  readonly sourceOrigin: MetricSourceOrigin;
  readonly classification: 'calculated' | 'observed';
  readonly coverage: MetricCoverage;
  /** Deterministic fingerprint of every input the result depends on. */
  readonly inputFingerprint: string;
  /** Plain-language boundary of what this number does NOT establish. */
  readonly interpretationBoundary: string;
}

export type MetricFailureCode =
  | 'missing-tracking'
  | 'ambiguous-identity'
  | 'low-confidence'
  | 'partial-visibility'
  | 'unsupported-origin'
  | 'invalid-window'
  | 'unknown-entity'
  | 'unsupported-role'
  | 'missing-endpoints';

export interface MetricInsufficientEvidence {
  readonly status: 'insufficient-evidence';
  readonly provenance: MetricProvenance;
  readonly failure: {
    readonly code: MetricFailureCode;
    readonly detail: string;
  };
}

export interface MetricVerified<TValue> {
  readonly status: 'verified';
  readonly provenance: MetricProvenance;
  readonly assurance: 'exact-source';
  readonly value: TValue;
}

export interface MetricDisclosed<TValue> {
  readonly status: 'disclosed';
  readonly provenance: MetricProvenance;
  readonly assurance: 'includes-interpolation';
  readonly value: TValue;
  readonly disclosure: string;
}

export type MetricResult<TValue> =
  MetricVerified<TValue> | MetricDisclosed<TValue> | MetricInsufficientEvidence;

/**
 * Stable metric id from kind + entities + window + the metric-specific
 * ARGUMENTS that change the calculation (review gate 1). Different lane
 * widths, role filters or sampling intervals are different measurements and
 * must never share one reference. `args` is canonical-JSON serialized, so
 * key order never matters and replay is byte-stable. Omit it ONLY when the
 * kind has no further parameters.
 */
export function metricIdFor(
  kind: MetricKind,
  matchId: string,
  entityIds: readonly string[],
  requested: { atMs?: number; windowMs?: readonly [number, number] },
  args?: Readonly<Record<string, unknown>>,
): string {
  const scope =
    requested.windowMs !== undefined
      ? `w${String(requested.windowMs[0])}-${String(requested.windowMs[1])}`
      : requested.atMs !== undefined
        ? `t${String(requested.atMs)}`
        : 't?';
  const argScope =
    args === undefined || Object.keys(args).length === 0 ? '' : `:${canonicalJsonStringify(args)}`;
  return `${kind}:${matchId}:${[...entityIds].sort().join('+')}:${scope}${argScope}`;
}

/** Deterministic dependency fingerprint over canonical inputs. */
export function metricFingerprint(
  algorithmVersion: string,
  parts: Readonly<Record<string, unknown>>,
): string {
  return fnv1aHex(
    canonicalJsonStringify({
      algorithmVersion,
      ...parts,
    }),
  );
}

export function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

export function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
