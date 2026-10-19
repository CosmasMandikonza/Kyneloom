import type { TrackingSample } from '@kyneloom/contracts';
import type { Timeline } from '../reducer/timeline';
import { checkRawEndpoint, classifyPose, originEligibleForVerified } from './source-quality';
import {
  metricFingerprint,
  metricIdFor,
  round3,
  type MetricInsufficientEvidence,
  type MetricResult,
} from './metric-result';

/**
 * Metric A — nearest opponent distance (`kyneloom-nearest-opponent-v1`).
 *
 * Given a player and a source time, identifies the nearest OPPOSING player
 * from exact tracked positions. The label "defender" is applied only when
 * the caller supplies authoritative roster roles and the nearest qualifying
 * opponent actually holds a defensive role in that source — a nearest
 * opponent is never silently called a defender.
 *
 * Tie-breaking is deterministic: equal distances resolve to the lexicographically
 * smallest entity id, so replay is byte-stable regardless of input order.
 */

export const NEAREST_OPPONENT_VERSION = 'kyneloom-nearest-opponent-v1';

/** Roles the authoritative roster classifies as defensive. */
const DEFENSIVE_ROLES: ReadonlySet<string> = new Set(['back', 'defender', 'goalkeeper']);

export interface NearestOpponentInput {
  readonly matchId: string;
  readonly entityId: string;
  readonly atMs: number;
  /** All tracked entities (players; the ball is rejected). */
  readonly candidateEntityIds: readonly string[];
  /** Authoritative roster roles by entity id; when absent no role labeling occurs. */
  readonly rolesByEntity?: ReadonlyMap<string, string>;
  /** Restrict to defensive roles (requires rolesByEntity). */
  readonly defendersOnly?: boolean;
}

export interface NearestOpponentValue {
  readonly entityId: string;
  readonly distanceM: number;
  readonly roleLabel: string | null;
}

export type NearestOpponentResult = MetricResult<NearestOpponentValue>;

export function nearestOpponent(
  timeline: Timeline,
  tracking: readonly TrackingSample[],
  reducerRevision: number,
  input: NearestOpponentInput,
): NearestOpponentResult {
  const entityIds = [input.entityId];
  const metricId = metricIdFor('nearest-opponent', input.matchId, entityIds, {
    atMs: input.atMs,
  });

  const insufficient = (
    code: MetricInsufficientEvidence['failure']['code'],
    detail: string,
    dependsOn: { sourceFrameIds?: readonly string[] } = {},
  ): NearestOpponentResult => ({
    status: 'insufficient-evidence',
    provenance: {
      kind: 'nearest-opponent',
      algorithmVersion: NEAREST_OPPONENT_VERSION,
      metricId,
      matchId: input.matchId,
      reducerRevision,
      entityIds,
      units: 'metres',
      requested: { atMs: input.atMs },
      dependsOn: {
        sourceFrameIds: dependsOn.sourceFrameIds ?? [],
        eventIds: [],
        entityIds,
      },
      sourceOrigin: 'synthetic_ground_truth',
      classification: 'calculated',
      coverage: { exactSamples: 0, interpolatedSamples: 0, missingEntityIds: [input.entityId] },
      inputFingerprint: metricFingerprint(NEAREST_OPPONENT_VERSION, {
        metricId,
        withheld: code,
      }),
      interpretationBoundary:
        'Nearest-opponent distance is a calculated spatial fact; it says nothing about intent, marking assignments or pressure.',
    },
    failure: { code, detail },
  });

  // The actor must anchor on a policy-passing exact sample.
  const actorGate = checkRawEndpoint(tracking, { entityId: input.entityId, atMs: input.atMs });
  if (!actorGate.ok) {
    return insufficient(actorGate.code ?? 'missing-tracking', actorGate.detail ?? '');
  }
  if (input.defendersOnly === true && input.rolesByEntity === undefined) {
    return insufficient(
      'unsupported-role',
      'defendersOnly requested without authoritative roster roles — defensive labeling cannot be inferred from tracking',
    );
  }

  const frame = timeline.sampleAt(input.atMs);
  const actorPose = frame.entities.find((entity) => entity.entityId === input.entityId);
  if (actorPose === undefined || classifyPose(actorPose) !== 'exact') {
    return insufficient('missing-tracking', `actor pose unusable at ${String(input.atMs)} ms`);
  }

  let best: { entityId: string; distanceM: number; frameId: string } | null = null;
  let ambiguousDistance = false;
  const scannedFrameIds: string[] = [];
  for (const candidateId of [...input.candidateEntityIds].sort()) {
    if (candidateId === input.entityId || candidateId === 'ball') continue;
    // Opponent = different team prefix over the canonical id grammar.
    if (sameTeam(input.entityId, candidateId)) continue;
    if (input.defendersOnly === true) {
      const role = input.rolesByEntity?.get(candidateId);
      if (role === undefined || !DEFENSIVE_ROLES.has(role)) continue;
    }
    const pose = frame.entities.find((entity) => entity.entityId === candidateId);
    const quality = classifyPose(pose);
    if (pose === undefined || quality === 'unusable') continue; // absent opponent: not a candidate
    if (quality === 'interpolated') continue; // verified tier: exact opponents only
    const gate = checkRawEndpoint(tracking, { entityId: candidateId, atMs: input.atMs });
    if (!gate.ok) {
      // A present-but-unreliable opponent poisons nearest determination:
      // it may BE the nearest, so the metric is withheld with its failure,
      // never resolved to a farther opponent.
      return insufficient(gate.code ?? 'missing-tracking', gate.detail ?? '');
    }
    scannedFrameIds.push(pose.sourceFrameIds[0] ?? '');
    const distance = Math.hypot(pose.xM - actorPose.xM, pose.yM - actorPose.yM);
    if (best === null) {
      best = { entityId: candidateId, distanceM: distance, frameId: pose.sourceFrameIds[0] ?? '' };
    } else if (distance < best.distanceM) {
      ambiguousDistance = false;
      best = { entityId: candidateId, distanceM: distance, frameId: pose.sourceFrameIds[0] ?? '' };
    } else if (distance === best.distanceM) {
      // Deterministic tie-break: lexicographically smallest id wins; the
      // sorted iteration order guarantees the incumbent IS the smaller id.
      ambiguousDistance = true;
    }
  }

  if (best === null) {
    return insufficient(
      'missing-tracking',
      'no policy-passing opposing sample at the requested instant',
      { sourceFrameIds: [actorPose.sourceFrameIds[0] ?? ''] },
    );
  }

  const value: NearestOpponentValue = {
    entityId: best.entityId,
    distanceM: round3(best.distanceM),
    roleLabel:
      input.rolesByEntity !== undefined ? (input.rolesByEntity.get(best.entityId) ?? null) : null,
  };

  return {
    status: 'verified',
    assurance: 'exact-source',
    provenance: {
      kind: 'nearest-opponent',
      algorithmVersion: NEAREST_OPPONENT_VERSION,
      metricId,
      matchId: input.matchId,
      reducerRevision,
      entityIds,
      units: 'metres',
      requested: { atMs: input.atMs },
      dependsOn: {
        sourceFrameIds: [actorPose.sourceFrameIds[0] ?? '', best.frameId],
        eventIds: [],
        entityIds: [input.entityId, best.entityId],
      },
      sourceOrigin: 'synthetic_ground_truth',
      classification: 'calculated',
      coverage: { exactSamples: 2, interpolatedSamples: 0, missingEntityIds: [] },
      inputFingerprint: metricFingerprint(NEAREST_OPPONENT_VERSION, {
        metricId,
        actor: `${input.entityId}@${actorPose.sourceFrameIds[0]}:${actorPose.xM},${actorPose.yM}`,
        opponent: `${best.entityId}@${best.frameId}:${round3(best.distanceM)}`,
        tie: ambiguousDistance,
      }),
      interpretationBoundary:
        'Nearest-opponent distance is a calculated spatial fact; it says nothing about intent, marking assignments or pressure.',
    },
    value,
  };
}

function sameTeam(a: string, b: string): boolean {
  const teamOf = (id: string): string => id.split('-')[0] ?? '';
  return teamOf(a) === teamOf(b) && teamOf(a) !== '';
}

/** Role eligibility helper for callers building rolesByEntity from rosters. */
export function isDefensiveRole(role: string): boolean {
  return DEFENSIVE_ROLES.has(role);
}

export { originEligibleForVerified };
