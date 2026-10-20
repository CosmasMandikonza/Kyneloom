import type { TrackingSample } from '@kyneloom/contracts';
import type { Timeline } from '../reducer/timeline';
import { checkRawEndpoint, classifyPose } from './source-quality';
import {
  metricFingerprint,
  metricIdFor,
  round3,
  type MetricInsufficientEvidence,
  type MetricResult,
} from './metric-result';

/**
 * Metric C — passing-lane occupancy (`kyneloom-lane-occupancy-v1`).
 *
 * A precisely specified geometric test: which opponents occupy the corridor
 * between two supported endpoint positions?
 *
 * Specification:
 * - The lane is the FINITE line segment from endpoint A to endpoint B.
 * - Corridor width `widthM` is the TOTAL width; an opponent is inside when
 *   its perpendicular distance to the segment is ≤ widthM / 2.
 * - Endpoint treatment: the projection of the opponent onto the segment
 *   line must fall INSIDE the segment [0, 1] (clamped projections do not
 *   count — an opponent beyond the receiver is not "in the passing lane").
 * - Near-end exclusion: an opponent within `excludeRadiusM` of endpoint A
 *   (measured center-to-center) is excluded — an adjacent presser occupies
 *   the passer's space, not the corridor. Default 1.5 m.
 * - Ordering: occupants are returned sorted by lateral distance (closest
 *   to the lane axis first); ties break by lexicographic entity id.
 * - Deterministic replay: candidate scan is id-sorted before comparison.
 *
 * Truth boundary (docs/07): a geometrically occupied corridor is a
 * CALCULATED spatial condition. It does NOT establish that a pass was
 * impossible, that a defender intended to block it, or that a pass would
 * have failed. Callers must not launder this into a claim about pass
 * outcomes.
 *
 * Endpoints come from the caller OR from an accepted pass event. If the
 * receiver/target is unknown, the metric is withheld — the intended
 * receiver is never invented.
 */

export const LANE_OCCUPANCY_VERSION = 'kyneloom-lane-occupancy-v1';

export interface LaneEndpoint {
  readonly entityId: string;
  readonly atMs: number;
}

export interface LaneOccupancyInput {
  readonly matchId: string;
  readonly from: LaneEndpoint;
  readonly to: LaneEndpoint;
  /** Total corridor width in metres (perpendicular distance ≤ width/2). */
  readonly widthM: number;
  /** Opponents to test (all entities of the opposing side). */
  readonly candidateEntityIds: readonly string[];
  /** Opponents within this radius of endpoint A are excluded (default 1.5). */
  readonly excludeRadiusM?: number;
}

export interface LaneOccupant {
  readonly entityId: string;
  /** Perpendicular distance to the lane axis, metres (round3). */
  readonly lateralM: number;
  /** Projection along the axis as a 0–1 fraction of A→B (round3). */
  readonly alongFraction: number;
  readonly sourceFrameId: string;
}

export interface LaneOccupancyValue {
  readonly widthM: number;
  readonly occupants: readonly LaneOccupant[];
  readonly corridorLengthM: number;
  /**
   * Opposing candidates whose position could NOT be established at the
   * passer's instant (missing, interpolated, or below the source-quality
   * policy). Each could be a corridor blocker — an empty `occupants` list
   * with a non-empty `unresolvedOpponents` list is NEVER a verified clear
   * lane (review gate 2).
   */
  readonly unresolvedOpponents: readonly string[];
}

export type LaneOccupancyResult = MetricResult<LaneOccupancyValue>;

interface ResolvedPoint {
  readonly entityId: string;
  readonly xM: number;
  readonly yM: number;
  readonly frameId: string;
}

export function laneOccupancy(
  timeline: Timeline,
  tracking: readonly TrackingSample[],
  reducerRevision: number,
  input: LaneOccupancyInput,
): LaneOccupancyResult {
  const entityIds = [input.from.entityId, input.to.entityId];
  // Identity carries the calculation arguments AND the endpoint direction:
  // A→B at their instants is a different lane measurement than B→A or a
  // different width, even inside the same collapsed time window.
  const metricId = metricIdFor(
    'passing-lane-occupancy',
    input.matchId,
    entityIds,
    {
      windowMs: [
        Math.min(input.from.atMs, input.to.atMs),
        Math.max(input.from.atMs, input.to.atMs),
      ],
    },
    {
      from: `${input.from.entityId}@${String(input.from.atMs)}`,
      to: `${input.to.entityId}@${String(input.to.atMs)}`,
      widthM: input.widthM,
      excludeRadiusM: input.excludeRadiusM ?? 1.5,
    },
  );

  const insufficient = (
    code: MetricInsufficientEvidence['failure']['code'],
    detail: string,
  ): LaneOccupancyResult => ({
    status: 'insufficient-evidence',
    provenance: {
      kind: 'passing-lane-occupancy',
      algorithmVersion: LANE_OCCUPANCY_VERSION,
      metricId,
      matchId: input.matchId,
      reducerRevision,
      entityIds,
      units: 'entity_count',
      requested: {
        windowMs: [input.from.atMs, input.to.atMs] as const,
      },
      dependsOn: { sourceFrameIds: [], eventIds: [], entityIds },
      sourceOrigin: 'synthetic_ground_truth',
      classification: 'calculated',
      coverage: { exactSamples: 0, interpolatedSamples: 0, missingEntityIds: entityIds },
      inputFingerprint: metricFingerprint(LANE_OCCUPANCY_VERSION, { metricId, withheld: code }),
      interpretationBoundary:
        'Corridor occupancy is a geometric condition; it says nothing about pass intent, feasibility or outcome.',
    },
    failure: { code, detail },
  });

  if (!(input.widthM > 0) || !Number.isFinite(input.widthM)) {
    return insufficient('invalid-window', `widthM must be a positive finite metre value`);
  }
  if (input.from.entityId === input.to.entityId) {
    return insufficient('missing-endpoints', 'lane endpoints must be two different entities');
  }

  // Both endpoints anchor on policy-passing exact samples.
  const endpoints: ResolvedPoint[] = [];
  for (const endpoint of [input.from, input.to]) {
    const gate = checkRawEndpoint(tracking, { entityId: endpoint.entityId, atMs: endpoint.atMs });
    if (!gate.ok) {
      return insufficient(gate.code ?? 'missing-tracking', gate.detail ?? '');
    }
    const pose = timeline
      .sampleAt(endpoint.atMs)
      .entities.find((entity) => entity.entityId === endpoint.entityId);
    if (pose === undefined || classifyPose(pose) !== 'exact') {
      return insufficient(
        'missing-tracking',
        `endpoint ${endpoint.entityId} has no exact verified pose at ${String(endpoint.atMs)} ms`,
      );
    }
    endpoints.push({
      entityId: endpoint.entityId,
      xM: pose.xM,
      yM: pose.yM,
      frameId: pose.sourceFrameIds[0] ?? '',
    });
  }
  const [a, b] = endpoints as [ResolvedPoint, ResolvedPoint];

  const axisX = b.xM - a.xM;
  const axisY = b.yM - a.yM;
  const lengthSq = axisX * axisX + axisY * axisY;
  if (lengthSq === 0) {
    return insufficient('missing-endpoints', 'lane endpoints coincide geometrically');
  }
  const excludeRadius = input.excludeRadiusM ?? 1.5;

  const occupants: LaneOccupant[] = [];
  const unresolvedOpponents: string[] = [];
  let exactSamples = 2;
  for (const candidateId of [...input.candidateEntityIds].sort()) {
    if (candidateId === a.entityId || candidateId === b.entityId || candidateId === 'ball')
      continue;
    if (sameSide(a.entityId, candidateId) && sameSide(b.entityId, candidateId)) continue; // only opponents
    // Test the opponent at the PASSER's instant (the moment the ball would be played).
    const pose = timeline
      .sampleAt(input.from.atMs)
      .entities.find((entity) => entity.entityId === candidateId);
    // REVIEW GATE 2: an opponent whose position cannot be established
    // (missing, interpolated or below the source-quality policy) is a
    // POTENTIAL blocker. It is never silently skipped: it is recorded as
    // unresolved and downgrades the whole result — a "clear lane" over
    // unknown opponent positions is not verified geometry.
    if (pose === undefined || classifyPose(pose) !== 'exact') {
      unresolvedOpponents.push(candidateId);
      continue;
    }
    const gate = checkRawEndpoint(tracking, {
      entityId: candidateId,
      atMs: input.from.atMs,
    });
    if (!gate.ok) {
      unresolvedOpponents.push(candidateId);
      continue;
    }
    exactSamples += 1;
    const toOpponentX = pose.xM - a.xM;
    const toOpponentY = pose.yM - a.yM;
    const nearEndDistance = Math.hypot(toOpponentX, toOpponentY);
    if (nearEndDistance <= excludeRadius) continue; // adjacent presser, not corridor
    const along = (toOpponentX * axisX + toOpponentY * axisY) / lengthSq;
    if (along < 0 || along > 1) continue; // beyond an endpoint: not in the finite lane
    const lateral = Math.hypot(toOpponentX - along * axisX, toOpponentY - along * axisY);
    if (lateral > input.widthM / 2) continue;
    occupants.push({
      entityId: candidateId,
      lateralM: round3(lateral),
      alongFraction: round3(along),
      sourceFrameId: pose.sourceFrameIds[0] ?? '',
    });
  }

  occupants.sort((x, y) => x.lateralM - y.lateralM || (x.entityId < y.entityId ? -1 : 1));

  const value: LaneOccupancyValue = {
    widthM: input.widthM,
    occupants,
    corridorLengthM: round3(Math.sqrt(lengthSq)),
    unresolvedOpponents,
  };

  const provenance = {
    kind: 'passing-lane-occupancy' as const,
    algorithmVersion: LANE_OCCUPANCY_VERSION,
    metricId,
    matchId: input.matchId,
    reducerRevision,
    entityIds,
    units: 'entity_count' as const,
    requested: { windowMs: [input.from.atMs, input.to.atMs] as const },
    dependsOn: {
      sourceFrameIds: [a.frameId, b.frameId, ...occupants.map((o) => o.sourceFrameId)].sort(),
      eventIds: [],
      entityIds: [...entityIds, ...occupants.map((o) => o.entityId), ...unresolvedOpponents].sort(),
    },
    sourceOrigin: 'synthetic_ground_truth' as const,
    classification: 'calculated' as const,
    coverage: {
      exactSamples,
      interpolatedSamples: 0,
      missingEntityIds: unresolvedOpponents,
    },
    inputFingerprint: metricFingerprint(LANE_OCCUPANCY_VERSION, {
      metricId,
      widthM: input.widthM,
      excludeRadiusM: excludeRadius,
      endpoints: [
        `${a.entityId}@${a.frameId}:${a.xM},${a.yM}`,
        `${b.entityId}@${b.frameId}:${b.xM},${b.yM}`,
      ],
      occupants: occupants.map((o) => `${o.entityId}:${o.lateralM}@${o.alongFraction}`),
      unresolvedOpponents,
    }),
    interpretationBoundary:
      'Corridor occupancy is a geometric condition; it says nothing about pass intent, feasibility or outcome.',
  };

  if (unresolvedOpponents.length > 0) {
    return {
      status: 'disclosed' as const,
      assurance: 'includes-interpolation' as const,
      provenance,
      value,
      disclosure:
        `${String(unresolvedOpponents.length)} opposing candidate(s) could not be positioned at the passer's instant ` +
        `(${unresolvedOpponents.join(', ')}); each could be a corridor blocker, so the occupancy ` +
        `geometry is disclosed for editorial exploration — an empty occupant list is NOT a verified clear lane.`,
    };
  }
  return {
    status: 'verified' as const,
    assurance: 'exact-source' as const,
    provenance,
    value,
  };
}

function sameSide(a: string, b: string): boolean {
  const teamOf = (id: string): string => id.split('-')[0] ?? '';
  return teamOf(a) === teamOf(b) && teamOf(a) !== '';
}
