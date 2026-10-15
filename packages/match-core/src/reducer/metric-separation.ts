import { canonicalJsonStringify } from '@kyneloom/contracts';
import type { TrackingSample } from '@kyneloom/contracts';
import { createTimeline, type Timeline } from './timeline';

/**
 * The first trustworthy metric (KYN-04): defender separation over the decoy
 * run, computed ONLY from authoritative tracking frames. The result is a
 * self-describing evidence record — algorithm version, exact source frame
 * ids, entity identities and the measurement window — so downstream
 * manifests can carry and later re-verify the dependency.
 *
 * Classification: the DISTANCE CHANGE is a `calculated` fact. Any causal
 * reading ("the run opened the passing lane on purpose") stays a HYPOTHESIS
 * for agents/humans; this module never emits it as verified.
 */

export const SEPARATION_ALGORITHM_VERSION = 'kyneloom-separation-v1';

export interface SeparationInput {
  readonly matchId: string;
  readonly defenderId: string;
  readonly strikerId: string;
  readonly fromMs: number;
  readonly toMs: number;
}

export interface SeparationEvidence {
  readonly algorithmVersion: typeof SEPARATION_ALGORITHM_VERSION;
  readonly matchId: string;
  readonly defenderId: string;
  readonly strikerId: string;
  readonly fromMs: number;
  readonly toMs: number;
  readonly separationBeforeM: number;
  readonly separationAfterM: number;
  readonly deltaM: number;
  /** Source frames the two endpoint measurements came from. */
  readonly beforeSourceFrameIds: readonly [string, string];
  readonly afterSourceFrameIds: readonly [string, string];
  /** Metric→source dependency map: exactly these frames feed this number. */
  readonly dependsOn: {
    readonly sourceFrameIds: readonly string[];
    readonly entityIds: readonly [string, string];
  };
  readonly basis: 'synthetic_ground_truth';
  readonly classification: 'calculated';
  readonly hypothesisBoundary: 'Distance change is a measured fact; tactical causality (intent, lane creation) remains a hypothesis.';
  /** Stable fingerprint of every input the number depends on. */
  readonly inputFingerprint: string;
}

export type SeparationResult =
  | { readonly ok: true; readonly evidence: SeparationEvidence }
  | { readonly ok: false; readonly reason: 'missing-tracking'; readonly detail: string };

export function computeSeparation(
  tracking: readonly TrackingSample[],
  input: SeparationInput,
): SeparationResult {
  if (input.toMs <= input.fromMs) {
    throw new RangeError(
      `toMs must be after fromMs, got ${String(input.fromMs)}..${String(input.toMs)}`,
    );
  }
  const timeline: Timeline = createTimeline(tracking);
  return separationFromTimeline(timeline, input);
}

export function separationFromTimeline(
  timeline: Timeline,
  input: SeparationInput,
): SeparationResult {
  // Endpoints must be EXACT frames — measured facts never interpolate.
  const endpoints = [input.fromMs, input.toMs] as const;
  const poses: {
    tMs: number;
    defender: { xM: number; yM: number; frame: string };
    striker: { xM: number; yM: number; frame: string };
  }[] = [];
  for (const tMs of endpoints) {
    const frame = timeline.sampleAt(tMs);
    const defender = frame.entities.find((e) => e.entityId === input.defenderId && e.exact);
    const striker = frame.entities.find((e) => e.entityId === input.strikerId && e.exact);
    if (!defender || !striker) {
      const missing = [input.defenderId, input.strikerId].filter(
        (id) => !frame.entities.some((e) => e.entityId === id && e.exact),
      );
      return {
        ok: false,
        reason: 'missing-tracking',
        detail: `no exact tracking frame for ${missing.join(' and ')} at ${String(tMs)} ms; separation is not computable and must not be fabricated`,
      };
    }
    poses.push({
      tMs,
      defender: { xM: defender.xM, yM: defender.yM, frame: defender.sourceFrameIds[0]! },
      striker: { xM: striker.xM, yM: striker.yM, frame: striker.sourceFrameIds[0]! },
    });
  }
  const [before, after] = poses as [
    {
      tMs: number;
      defender: { xM: number; yM: number; frame: string };
      striker: { xM: number; yM: number; frame: string };
    },
    {
      tMs: number;
      defender: { xM: number; yM: number; frame: string };
      striker: { xM: number; yM: number; frame: string };
    },
  ];
  const distance = (a: typeof before.defender, b: typeof before.striker): number =>
    round3(Math.hypot(a.xM - b.xM, a.yM - b.yM));
  const beforeM = distance(before.defender, before.striker);
  const afterM = distance(after.defender, after.striker);

  const dependsOn = {
    sourceFrameIds: [
      before.defender.frame,
      before.striker.frame,
      after.defender.frame,
      after.striker.frame,
    ],
    entityIds: [input.defenderId, input.strikerId] as const,
  };
  const evidence: SeparationEvidence = {
    algorithmVersion: SEPARATION_ALGORITHM_VERSION,
    matchId: input.matchId,
    defenderId: input.defenderId,
    strikerId: input.strikerId,
    fromMs: input.fromMs,
    toMs: input.toMs,
    separationBeforeM: beforeM,
    separationAfterM: afterM,
    deltaM: round3(afterM - beforeM),
    beforeSourceFrameIds: [before.defender.frame, before.striker.frame],
    afterSourceFrameIds: [after.defender.frame, after.striker.frame],
    dependsOn,
    basis: 'synthetic_ground_truth',
    classification: 'calculated',
    hypothesisBoundary:
      'Distance change is a measured fact; tactical causality (intent, lane creation) remains a hypothesis.',
    inputFingerprint: fingerprintInputs(dependsOn, [input.fromMs, input.toMs], timeline),
  };
  return { ok: true, evidence };
}

/** Fingerprint of every input the measurement depends on (entity@frame positions). */
function fingerprintInputs(
  dependsOn: {
    sourceFrameIds: readonly string[];
    entityIds: readonly [string, string] | readonly string[];
  },
  window: readonly [number, number] | readonly number[],
  timeline: Timeline,
): string {
  // Each dependency is (entityId, frameId): capture THAT entity's position in
  // THAT frame — a frame shared by 23 entities must contribute 23 distinct
  // possible facts, and an identity swap must change the fingerprint.
  const parts: string[] = [];
  for (const entityId of dependsOn.entityIds) {
    for (const frameId of dependsOn.sourceFrameIds) {
      const tMs = Number(frameId.replace(/^frame-/, '')) * 100;
      const frame = timeline.sampleAt(tMs);
      const entity = frame.entities.find((e) => e.entityId === entityId && e.exact);
      parts.push(
        entity
          ? `${entityId}@${frameId}:${entity.xM},${entity.yM},${entity.zM}`
          : `${entityId}@${frameId}:absent`,
      );
    }
  }
  return fnv1aHex(
    canonicalJsonStringify({
      algorithmVersion: SEPARATION_ALGORITHM_VERSION,
      entityIds: dependsOn.entityIds,
      window,
      dependencies: parts,
    }),
  );
}

/**
 * Re-verification: an evidence record stays valid only while the exact same
 * source frames with the exact same coordinates still exist. A tracking
 * correction touching any dependency frame invalidates the metric.
 */
export function verifySeparationEvidence(
  evidence: SeparationEvidence,
  tracking: readonly TrackingSample[],
): boolean {
  const recomputed = computeSeparation(tracking, {
    matchId: evidence.matchId,
    defenderId: evidence.defenderId,
    strikerId: evidence.strikerId,
    fromMs: evidence.fromMs,
    toMs: evidence.toMs,
  });
  if (!recomputed.ok) return false;
  return (
    recomputed.evidence.inputFingerprint === evidence.inputFingerprint &&
    recomputed.evidence.deltaM === evidence.deltaM
  );
}

/** FNV-1a 32-bit hex — deterministic, dependency-free checksum for projections and evidence. */
export function fnv1aHex(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}
