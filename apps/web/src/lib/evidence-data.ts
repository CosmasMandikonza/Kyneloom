import {
  createTimeline,
  separationFromTimeline,
  verifySeparationEvidence,
  type SeparationEvidence,
} from '@kyneloom/match-core';
import type { GoldenMatchStatus } from './match-fixture';

/**
 * KYN-08 server→client Evidence X-Ray projection.
 *
 * ONE authoritative evidence object per moment: the separation between the
 * defender and the striker over the decoy-run window, computed by the SAME
 * `separationFromTimeline` the reducer tests pin (never a UI-side copy),
 * then RE-VERIFIED against the accepted tracking (`verifySeparationEvidence`
 * — KYN-04 dependency semantics). Only a verified evidence record crosses
 * the wire, and it carries exactly the source coordinates the overlay and
 * inspector need — nothing more, no plausible defaults.
 *
 * Truth distinction (docs/05, metric-separation.ts): the distance change is
 * a `calculated` synthetic-ground-truth FACT; the tactical reading
 * ("the winger's run opened the space") is an INTERPRETATION that ships as
 * clearly-labeled text and dashed-amber geometry, never as a verified claim.
 */

/** The canonical measurement window for The Invisible Assist (docs/15). */
export const SEPARATION_INPUT = {
  matchId: 'synthetic-derby-01',
  defenderId: 'away-03',
  strikerId: 'home-09',
  fromMs: 4_720_500,
  toMs: 4_724_000,
} as const;

/** The off-ball runner whose movement the interpretation refers to. */
export const DECOY_RUNNER_ID = 'home-11';

export interface EvidenceEndpointPose {
  readonly entityId: string;
  readonly xM: number;
  readonly yM: number;
  readonly sourceFrameId: string;
  readonly exact: true;
}

/**
 * JSON-serializable evidence projection. `status` is the trust gate:
 * - 'verified' — recomputed fingerprint matches; overlays and the inspector
 *   may show the measurement;
 * - 'unverified' — verification failed (tracking correction touched a
 *   dependency, fingerprint mismatch); the UI WITHHOLDS the measurement and
 *   says why. A verified number is never shown after verification fails.
 */
export type EvidenceProjection =
  | {
      readonly status: 'verified';
      readonly evidence: SeparationEvidence;
      /** Endpoint poses (defender & striker at from/to) for anchored drawing. */
      readonly endpoints: readonly EvidenceEndpointPose[];
      /** Decoy-runner path samples across the window (for the trail overlay). */
      readonly runnerTrail: readonly { tMs: number; xM: number; yM: number }[];
      /** Plain-language interpretation, explicitly NOT a verified cause. */
      readonly interpretation: {
        readonly text: string;
        readonly classification: 'hypothesis';
        readonly boundary: string;
      };
    }
  | {
      readonly status: 'unverified';
      readonly reason: string;
      readonly defenderId: string;
      readonly strikerId: string;
      readonly fromMs: number;
      readonly toMs: number;
    };

export function buildEvidenceProjection(golden: GoldenMatchStatus): EvidenceProjection {
  if (!golden.ok) {
    return unverified('golden fixture unavailable — no evidence can be shown');
  }
  const tracking = golden.data.projected.acceptedTracking;
  const result = separationFromTimeline(createTimeline(tracking), SEPARATION_INPUT);
  if (!result.ok) {
    return unverified(result.detail);
  }
  if (!verifySeparationEvidence(result.evidence, tracking)) {
    return unverified(
      'evidence re-verification failed — a source dependency changed, so the measurement is withheld',
    );
  }
  const timeline = createTimeline(tracking);
  const endpoints: EvidenceEndpointPose[] = [];
  for (const tMs of [SEPARATION_INPUT.fromMs, SEPARATION_INPUT.toMs] as const) {
    const frame = timeline.sampleAt(tMs);
    for (const entityId of [SEPARATION_INPUT.defenderId, SEPARATION_INPUT.strikerId] as const) {
      const entity = frame.entities.find((e) => e.entityId === entityId && e.exact);
      if (entity === undefined) {
        return unverified(`exact endpoint sample missing for ${entityId} at ${String(tMs)} ms`);
      }
      endpoints.push({
        entityId,
        xM: entity.xM,
        yM: entity.yM,
        sourceFrameId: entity.sourceFrameIds[0]!,
        exact: true,
      });
    }
  }
  // Decoy trail: every exact runner sample inside the window — grounded in
  // actual samples, no invented path.
  const runnerTrail: { tMs: number; xM: number; yM: number }[] = [];
  for (const sample of tracking) {
    if (
      sample.entityId === DECOY_RUNNER_ID &&
      sample.sampleTimeMs >= SEPARATION_INPUT.fromMs &&
      sample.sampleTimeMs <= SEPARATION_INPUT.toMs
    ) {
      runnerTrail.push({ tMs: sample.sampleTimeMs, xM: sample.xM, yM: sample.yM });
    }
  }
  runnerTrail.sort((a, b) => a.tMs - b.tMs);
  if (runnerTrail.length < 2) {
    return unverified('decoy runner trail has fewer than two samples in the window');
  }

  return {
    status: 'verified',
    evidence: result.evidence,
    endpoints,
    runnerTrail,
    interpretation: {
      text: 'The winger’s decoy run may have helped create the passing space. Tracking alone does not establish intent or causation.',
      classification: 'hypothesis',
      boundary:
        'Distance change is a measured fact; tactical causality (intent, lane creation) remains a hypothesis.',
    },
  };
}

function unverified(reason: string): EvidenceProjection {
  return {
    status: 'unverified',
    reason,
    defenderId: SEPARATION_INPUT.defenderId,
    strikerId: SEPARATION_INPUT.strikerId,
    fromMs: SEPARATION_INPUT.fromMs,
    toMs: SEPARATION_INPUT.toMs,
  };
}

/**
 * Client-side validation of the projection payload — same fail-closed law as
 * the scene bridge: a corrupted or incomplete payload is rejected, never
 * repaired into plausible evidence. Returns null on any violation.
 */
export function validateEvidenceProjection(value: unknown): EvidenceProjection | null {
  if (typeof value !== 'object' || value === null) return null;
  const p = value as Record<string, unknown>;
  if (p.status === 'unverified') {
    return typeof p.reason === 'string' &&
      typeof p.defenderId === 'string' &&
      typeof p.strikerId === 'string' &&
      Number.isFinite(p.fromMs) &&
      Number.isFinite(p.toMs)
      ? (p as unknown as EvidenceProjection)
      : null;
  }
  if (p.status !== 'verified') return null;
  const e = p.evidence as Record<string, unknown> | undefined;
  if (e === undefined) return null;
  const numbers = [e.separationBeforeM, e.separationAfterM, e.deltaM, e.fromMs, e.toMs];
  if (numbers.some((n) => typeof n !== 'number' || !Number.isFinite(n))) return null;
  if (e.algorithmVersion !== 'kyneloom-separation-v1') return null;
  if (e.basis !== 'synthetic_ground_truth' || e.classification !== 'calculated') return null;
  if (typeof e.inputFingerprint !== 'string' || e.inputFingerprint.length === 0) return null;
  const frames = [
    ...((e.beforeSourceFrameIds as unknown[]) ?? []),
    ...((e.afterSourceFrameIds as unknown[]) ?? []),
  ];
  if (frames.length !== 4 || frames.some((f) => typeof f !== 'string' || f.length === 0))
    return null;
  if (!Array.isArray(p.endpoints) || p.endpoints.length !== 4) return null;
  for (const ep of p.endpoints as Record<string, unknown>[]) {
    if (
      typeof ep.entityId !== 'string' ||
      !Number.isFinite(ep.xM) ||
      !Number.isFinite(ep.yM) ||
      typeof ep.sourceFrameId !== 'string' ||
      ep.sourceFrameId.length === 0 ||
      ep.exact !== true
    ) {
      return null;
    }
  }
  // Arithmetic cross-check — a fabricated or internally inconsistent
  // measurement is rejected even when every field is individually finite:
  // the endpoint coordinates must reproduce both distances, and the
  // distances must reproduce the delta.
  const eps = p.endpoints as EvidenceEndpointPose[];
  const pairDistance = (a: EvidenceEndpointPose, b: EvidenceEndpointPose): number =>
    Math.round(Math.hypot(a.xM - b.xM, a.yM - b.yM) * 1000) / 1000;
  const beforePoses = eps.slice(0, 2);
  const afterPoses = eps.slice(2, 4);
  if (
    pairDistance(beforePoses[0]!, beforePoses[1]!) !== e.separationBeforeM ||
    pairDistance(afterPoses[0]!, afterPoses[1]!) !== e.separationAfterM
  ) {
    return null;
  }
  const expectedDelta = Math.round((e.separationAfterM - e.separationBeforeM) * 1000) / 1000;
  if (e.deltaM !== expectedDelta) return null;
  if (!Array.isArray(p.runnerTrail) || p.runnerTrail.length < 2) return null;
  for (const s of p.runnerTrail as Record<string, unknown>[]) {
    if (!Number.isFinite(s.tMs) || !Number.isFinite(s.xM) || !Number.isFinite(s.yM)) return null;
  }
  const interp = p.interpretation as Record<string, unknown> | undefined;
  if (
    interp === undefined ||
    typeof interp.text !== 'string' ||
    interp.classification !== 'hypothesis'
  ) {
    return null;
  }
  return p as unknown as EvidenceProjection;
}
