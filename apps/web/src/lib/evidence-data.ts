import {
  createTimeline,
  separationFromTimeline,
  SEPARATION_ALGORITHM_VERSION,
  verifySeparationEvidence,
  type SeparationEvidence,
  type Timeline,
} from '@kyneloom/match-core';
import type { TrackingSample } from '@kyneloom/contracts';
import type { GoldenMatchStatus } from './match-fixture';

/**
 * KYN-08 server→client Evidence X-Ray projection.
 *
 * ONE authoritative evidence object per moment: the separation between the
 * defender and the striker over the decoy-run window, computed by the SAME
 * `separationFromTimeline` the reducer tests pin (never a UI-side copy),
 * then RE-VERIFIED against the accepted tracking (`verifySeparationEvidence`
 * — KYN-04 dependency semantics), then gated by the SOURCE-QUALITY POLICY
 * below against the raw endpoint samples. Only a verified, source-supported
 * evidence record crosses the wire, and it carries exactly the source
 * coordinates the overlay and inspector need — nothing more, no plausible
 * defaults.
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

/**
 * SOURCE-QUALITY POLICY (review gate 2, documented).
 *
 * `separationFromTimeline` deliberately keeps only exact, coordinate-bearing
 * timeline samples — it does not inspect raw `confidence`/`visibility` — so
 * this boundary inspects the ORIGINAL accepted endpoint records before a
 * measurement may be presented as verified:
 *
 * 1. EXISTENCE — each of the four (entity, time) endpoints must resolve to
 *    exactly one accepted raw sample; zero is missing data, two is ambiguous
 *    identity. Either withholds the measurement.
 * 2. VISIBILITY — every endpoint sample must be `tracked`. A `partial`
 *    (reconstructed) sample can never support a measured fact.
 * 3. CONFIDENCE — every endpoint sample must be ≥ 0.9. Below the threshold
 *    the source is not confident enough to anchor a broadcast measurement;
 *    the measurement is withheld with the offending value named, never
 *    invented or averaged up.
 * 4. PROVENANCE — this product's X-Ray presents measurements whose basis is
 *    `synthetic_ground_truth`, so every endpoint origin must be
 *    `synthetic_ground_truth`. Observed or mixed provenance would be
 *    MISLABELED by the metric's basis field, so it is withheld with an
 *    explicit provenance reason instead (never relabeled).
 *
 * The golden fixture's four endpoints are confidence 1.0 / tracked /
 * synthetic_ground_truth, so the canonical result (6.306 → 20.344 m,
 * +14.038 m) stays verified.
 */
export const SOURCE_QUALITY_POLICY = {
  minEndpointConfidence: 0.9,
  requiredVisibility: 'tracked',
  requiredOrigin: 'synthetic_ground_truth',
} as const;

export interface EvidenceEndpointPose {
  readonly entityId: string;
  readonly xM: number;
  readonly yM: number;
  readonly sourceFrameId: string;
  readonly exact: true;
}

/**
 * JSON-serializable evidence projection. `status` is the trust gate:
 * - 'verified' — recomputed fingerprint matches AND the source-quality gate
 *   passed; overlays and the inspector may show the measurement;
 * - 'unverified' — verification or the source gate failed (tracking
 *   correction touched a dependency, missing/low-confidence/ambiguous/
 *   non-synthetic endpoints); the UI WITHHOLDS the measurement and says why.
 *   A verified number is never shown after verification fails.
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
  const timeline = createTimeline(tracking);
  const result = separationFromTimeline(timeline, SEPARATION_INPUT);
  if (!result.ok) {
    return unverified(result.detail);
  }
  if (!verifySeparationEvidence(result.evidence, tracking)) {
    return unverified(
      'evidence re-verification failed — a source dependency changed, so the measurement is withheld',
    );
  }
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
  // Source-quality gate (policy above): inspect the ORIGINAL accepted
  // endpoint records before the measurement may be presented.
  const gate = sourceQualityGate(tracking, endpoints);
  if (gate !== null) return unverified(gate);

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

/**
 * Returns null when every endpoint sample satisfies the SOURCE-QUALITY
 * POLICY, else the withholding reason. Never throws: malformed tracking
 * rows simply fail their policy check.
 */
function sourceQualityGate(
  tracking: readonly TrackingSample[],
  endpoints: readonly EvidenceEndpointPose[],
): string | null {
  for (const endpoint of endpoints) {
    const tMs = frameTimeMs(endpoint.sourceFrameId);
    const raw = tracking.filter(
      (sample) => sample.entityId === endpoint.entityId && sample.sampleTimeMs === tMs,
    );
    if (raw.length === 0) {
      return `endpoint source sample missing for ${endpoint.entityId} — the measurement is withheld rather than computed from unreferenced data`;
    }
    if (raw.length > 1) {
      return `ambiguous endpoint identity — ${String(raw.length)} accepted samples for ${endpoint.entityId} at ${String(tMs)} ms; the measurement is withheld`;
    }
    const sample = raw[0]!;
    if (sample.sourceFrameId !== endpoint.sourceFrameId) {
      return `endpoint source frame mismatch for ${endpoint.entityId} — the measurement does not reference its claimed source`;
    }
    if (sample.visibility !== SOURCE_QUALITY_POLICY.requiredVisibility) {
      return `endpoint visibility "${String(sample.visibility)}" for ${endpoint.entityId} at ${String(sample.sampleTimeMs)} ms is not tracked — reconstructed positions cannot support a measured fact`;
    }
    if (sample.confidence < SOURCE_QUALITY_POLICY.minEndpointConfidence) {
      return `endpoint confidence ${String(sample.confidence)} for ${endpoint.entityId} at ${String(sample.sampleTimeMs)} ms is below the supported threshold ${String(SOURCE_QUALITY_POLICY.minEndpointConfidence)} — the measurement is withheld`;
    }
    if (sample.origin !== SOURCE_QUALITY_POLICY.requiredOrigin) {
      return `endpoint provenance "${String(sample.origin)}" for ${endpoint.entityId} at ${String(sample.sampleTimeMs)} ms is not synthetic ground truth — an observed or mixed source would be mislabeled by this basis, so the measurement is withheld rather than relabeled`;
    }
  }
  return null;
}

function frameTimeMs(frameId: string): number {
  return Number(frameId.replace(/^frame-/, '')) * 100;
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

/** The authoritative client-side context the projection is bound against. */
export interface EvidenceValidationContext {
  /** The scene's own match id — a projection for another match is rejected. */
  readonly matchId: string;
  /** The scene's rehydrated timeline (same createTimeline as the server). */
  readonly timeline: Timeline;
  /** The scene's rehydrated accepted tracking (raw samples, with quality). */
  readonly tracking: readonly TrackingSample[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}
function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}
function isFrameId(value: unknown): value is string {
  return typeof value === 'string' && /^frame-\d+$/.test(value);
}
function isStringArray(value: unknown, length: number): value is string[] {
  return Array.isArray(value) && value.length === length && value.every(isNonEmptyString);
}

/**
 * Client-side validation of the projection payload — same fail-closed law as
 * the scene bridge: a corrupted or incomplete payload is rejected, never
 * repaired into plausible evidence. Returns null on any violation.
 *
 * Two independent layers, both fail-closed and THROW-FREE for arbitrary
 * `unknown` input:
 *
 * A. SHAPE — every field is guard-checked through narrow predicates before
 *    it is read (null evidence, non-array frame ids, null endpoint rows and
 *    every other malformed structure is rejected, never dereferenced).
 * B. AUTHORITATIVE BINDING — arithmetic consistency alone is insufficient:
 *    the payload's evidence must be the EXACT object `separationFromTimeline`
 *    recomputes from the scene's own timeline (every field, including
 *    `inputFingerprint`, dependency frame ids and the hypothesis boundary),
 *    and must pass the EXISTING `verifySeparationEvidence` against the
 *    scene's accepted tracking (KYN-04 semantics — no new metric). Endpoint
 *    poses must match the authoritative timeline sample for the claimed
 *    entity/time/frame; the runner trail must match the accepted raw
 *    samples; identities, window and match must match the canonical input.
 */
export function validateEvidenceProjection(
  value: unknown,
  ctx: EvidenceValidationContext,
): EvidenceProjection | null {
  if (!isRecord(value)) return null;
  if (value.status === 'unverified') {
    if (
      !isNonEmptyString(value.reason) ||
      value.defenderId !== SEPARATION_INPUT.defenderId ||
      value.strikerId !== SEPARATION_INPUT.strikerId ||
      value.fromMs !== SEPARATION_INPUT.fromMs ||
      value.toMs !== SEPARATION_INPUT.toMs
    ) {
      return null;
    }
    return value as unknown as EvidenceProjection;
  }
  if (value.status !== 'verified') return null;

  // ---- Layer A: shape (throw-free) ------------------------------------
  const e = value.evidence;
  if (!isRecord(e)) return null;
  if (
    !isFiniteNumber(e.separationBeforeM) ||
    !isFiniteNumber(e.separationAfterM) ||
    !isFiniteNumber(e.deltaM) ||
    !isFiniteNumber(e.fromMs) ||
    !isFiniteNumber(e.toMs)
  ) {
    return null;
  }
  if (!Number.isInteger(e.fromMs) || !Number.isInteger(e.toMs) || e.toMs <= e.fromMs) return null;
  if (e.algorithmVersion !== SEPARATION_ALGORITHM_VERSION) return null;
  if (e.matchId === undefined || e.defenderId === undefined || e.strikerId === undefined) {
    return null;
  }
  if (
    !isNonEmptyString(e.matchId) ||
    !isNonEmptyString(e.defenderId) ||
    !isNonEmptyString(e.strikerId)
  ) {
    return null;
  }
  if (e.basis !== 'synthetic_ground_truth' || e.classification !== 'calculated') return null;
  if (!isNonEmptyString(e.hypothesisBoundary) || !isNonEmptyString(e.inputFingerprint)) return null;
  if (!isFrameArray2(e.beforeSourceFrameIds) || !isFrameArray2(e.afterSourceFrameIds)) return null;
  if (!isRecord(e.dependsOn)) return null;
  if (!isStringArray(e.dependsOn.sourceFrameIds, 4) || !isStringArray(e.dependsOn.entityIds, 2)) {
    return null;
  }
  if (!Array.isArray(value.endpoints) || value.endpoints.length !== 4) return null;
  const endpoints: EvidenceEndpointPose[] = [];
  for (const ep of value.endpoints) {
    if (!isRecord(ep)) return null;
    if (
      !isNonEmptyString(ep.entityId) ||
      !isFiniteNumber(ep.xM) ||
      !isFiniteNumber(ep.yM) ||
      !isFrameId(ep.sourceFrameId) ||
      ep.exact !== true
    ) {
      return null;
    }
    endpoints.push({
      entityId: ep.entityId,
      xM: ep.xM,
      yM: ep.yM,
      sourceFrameId: ep.sourceFrameId,
      exact: true,
    });
  }
  if (!Array.isArray(value.runnerTrail) || value.runnerTrail.length < 2) return null;
  const trail: { tMs: number; xM: number; yM: number }[] = [];
  for (const s of value.runnerTrail) {
    if (!isRecord(s) || !isFiniteNumber(s.tMs) || !isFiniteNumber(s.xM) || !isFiniteNumber(s.yM)) {
      return null;
    }
    trail.push({ tMs: s.tMs, xM: s.xM, yM: s.yM });
  }
  const interp = value.interpretation;
  if (
    !isRecord(interp) ||
    !isNonEmptyString(interp.text) ||
    interp.classification !== 'hypothesis' ||
    !isNonEmptyString(interp.boundary)
  ) {
    return null;
  }

  // ---- Layer B: authoritative binding ---------------------------------
  // B1. The claim is about THIS scene and THIS canonical moment.
  if (e.matchId !== ctx.matchId) return null;
  if (
    e.defenderId !== SEPARATION_INPUT.defenderId ||
    e.strikerId !== SEPARATION_INPUT.strikerId ||
    e.fromMs !== SEPARATION_INPUT.fromMs ||
    e.toMs !== SEPARATION_INPUT.toMs
  ) {
    return null;
  }

  // B2. Recompute with the EXISTING metric on the scene's own timeline.
  const authoritative = separationFromTimeline(ctx.timeline, SEPARATION_INPUT);
  if (!authoritative.ok) return null;
  const truth = authoritative.evidence;

  // B3. Reuse the EXISTING verifier (KYN-04) against accepted tracking.
  const reconstructed: SeparationEvidence = {
    algorithmVersion: e.algorithmVersion as SeparationEvidence['algorithmVersion'],
    matchId: e.matchId,
    defenderId: e.defenderId,
    strikerId: e.strikerId,
    fromMs: e.fromMs,
    toMs: e.toMs,
    separationBeforeM: e.separationBeforeM,
    separationAfterM: e.separationAfterM,
    deltaM: e.deltaM,
    beforeSourceFrameIds: e.beforeSourceFrameIds as unknown as readonly [string, string],
    afterSourceFrameIds: e.afterSourceFrameIds as unknown as readonly [string, string],
    dependsOn: {
      sourceFrameIds: e.dependsOn.sourceFrameIds,
      entityIds: e.dependsOn.entityIds as unknown as readonly [string, string],
    },
    basis: 'synthetic_ground_truth',
    classification: 'calculated',
    hypothesisBoundary: e.hypothesisBoundary as SeparationEvidence['hypothesisBoundary'],
    inputFingerprint: e.inputFingerprint,
  };
  if (!verifySeparationEvidence(reconstructed, ctx.tracking)) return null;

  // B4. Every evidence field must equal the authoritative recomputation —
  // a forged fingerprint, swapped dependency ids, shifted values or a
  // rewritten hypothesis boundary all fail here even when arithmetically
  // consistent.
  if (
    truth.separationBeforeM !== e.separationBeforeM ||
    truth.separationAfterM !== e.separationAfterM ||
    truth.deltaM !== e.deltaM ||
    truth.inputFingerprint !== e.inputFingerprint ||
    truth.hypothesisBoundary !== e.hypothesisBoundary ||
    !framesEqual(truth.beforeSourceFrameIds, e.beforeSourceFrameIds) ||
    !framesEqual(truth.afterSourceFrameIds, e.afterSourceFrameIds) ||
    !framesEqual(truth.dependsOn.sourceFrameIds, e.dependsOn.sourceFrameIds) ||
    !framesEqual(truth.dependsOn.entityIds, e.dependsOn.entityIds)
  ) {
    return null;
  }

  // B5. Endpoint poses bind to the authoritative timeline sample for the
  // claimed entity at the claimed time (identity + frame + coordinates).
  const expectedOrder: readonly { entityId: string; tMs: number }[] = [
    { entityId: SEPARATION_INPUT.defenderId, tMs: SEPARATION_INPUT.fromMs },
    { entityId: SEPARATION_INPUT.strikerId, tMs: SEPARATION_INPUT.fromMs },
    { entityId: SEPARATION_INPUT.defenderId, tMs: SEPARATION_INPUT.toMs },
    { entityId: SEPARATION_INPUT.strikerId, tMs: SEPARATION_INPUT.toMs },
  ];
  const expectedFrames = [
    truth.beforeSourceFrameIds[0],
    truth.beforeSourceFrameIds[1],
    truth.afterSourceFrameIds[0],
    truth.afterSourceFrameIds[1],
  ];
  for (let i = 0; i < 4; i += 1) {
    const expected = expectedOrder[i]!;
    const pose = endpoints[i]!;
    if (pose.entityId !== expected.entityId) return null;
    if (pose.sourceFrameId !== expectedFrames[i]) return null;
    const sample = ctx.timeline
      .sampleAt(expected.tMs)
      .entities.find((entity) => entity.entityId === expected.entityId && entity.exact);
    if (sample === undefined) return null;
    if (sample.xM !== pose.xM || sample.yM !== pose.yM) return null;
    if (sample.sourceFrameIds[0] !== pose.sourceFrameId) return null;
  }

  // B6. The runner trail is exactly the accepted raw runner samples in the
  // window — no invented path points.
  const expectedTrail = ctx.tracking
    .filter(
      (sample) =>
        sample.entityId === DECOY_RUNNER_ID &&
        sample.sampleTimeMs >= SEPARATION_INPUT.fromMs &&
        sample.sampleTimeMs <= SEPARATION_INPUT.toMs,
    )
    .map((sample) => ({ tMs: sample.sampleTimeMs, xM: sample.xM, yM: sample.yM }))
    .sort((a, b) => a.tMs - b.tMs);
  if (expectedTrail.length !== trail.length) return null;
  for (let i = 0; i < trail.length; i += 1) {
    if (
      expectedTrail[i]!.tMs !== trail[i]!.tMs ||
      expectedTrail[i]!.xM !== trail[i]!.xM ||
      expectedTrail[i]!.yM !== trail[i]!.yM
    ) {
      return null;
    }
  }

  // B7. The interpretation's boundary text must be the metric's own.
  if (interp.boundary !== truth.hypothesisBoundary) return null;

  // ---- Defense in depth: arithmetic still has to hold -----------------
  const pairDistance = (a: EvidenceEndpointPose, b: EvidenceEndpointPose): number =>
    Math.round(Math.hypot(a.xM - b.xM, a.yM - b.yM) * 1000) / 1000;
  if (pairDistance(endpoints[0]!, endpoints[1]!) !== e.separationBeforeM) return null;
  if (pairDistance(endpoints[2]!, endpoints[3]!) !== e.separationAfterM) return null;
  const expectedDelta = Math.round((e.separationAfterM - e.separationBeforeM) * 1000) / 1000;
  if (e.deltaM !== expectedDelta) return null;

  return {
    status: 'verified',
    evidence: reconstructed,
    endpoints,
    runnerTrail: trail,
    interpretation: {
      text: interp.text,
      classification: 'hypothesis',
      boundary: interp.boundary,
    },
  };
}

function isFrameArray2(value: unknown): value is [string, string] {
  return Array.isArray(value) && value.length === 2 && value.every((f) => isFrameId(f));
}

function framesEqual(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((frame, i) => frame === b[i]);
}
