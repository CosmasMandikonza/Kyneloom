import type { TrackingSample } from '@kyneloom/contracts';
import type { Timeline } from '../reducer/timeline';
import { checkRawEndpoint, classifyPose } from './source-quality';
import {
  metricFingerprint,
  metricIdFor,
  round2,
  round3,
  type MetricDisclosed,
  type MetricInsufficientEvidence,
  type MetricResult,
} from './metric-result';

/**
 * Metric D — windowed off-ball movement (`kyneloom-offball-movement-v1`).
 *
 * A versioned movement signal over a precisely defined window:
 *
 * - Sampling cadence: the window is sampled at the fixture's tracking grid
 *   (`sampleStepMs`, default 100 ms) anchored at fromMs; the endpoint toMs
 *   is always included when it sits on the grid.
 * - Coverage: at least `minCoverage` (default 0.6) of the grid points must
 *   resolve to a pose; below that the metric is withheld.
 * - Gap policy: a grid point resolves to exact, interpolated or unusable
 *   exactly as the shared timeline defines (interpolation only across gaps
 *   ≤ 400 ms; beyond that the point is unusable). Interpolated points
 *   downgrade the whole result to DISCLOSED — never presented as verified.
 * - Movement statistics (all over exact-or-disclosed points):
 *   displacementM (straight-line start→end), pathLengthM (sum of segment
 *   lengths), meanSpeedMps and maxSpeedMps (segment speed), and
 *   `spacingDeltaM` when an opponent entityId is supplied (change in
 *   distance subject↔opponent between the first and last resolvable grid
 *   points).
 *
 * CRITICAL truth boundary: "off the ball" here means *movement observed
 * while the subject was not identified as the ball handler at the sampled
 * instants*. Ball-handler identification is only as good as the accepted
 * event stream: we check accepted possession-identifying events (kickoff
 * actor, pass target, shot actor) with their source validity windows. If
 * the source cannot establish that the subject was off the ball for the
 * whole window, the result carries `offBallStatus: 'partial' | 'unknown'`
 * with an explicit disclosure — it NEVER claims a verified possession fact.
 * And no configuration of this metric claims the movement CAUSED anything.
 */

export const OFF_BALL_MOVEMENT_VERSION = 'kyneloom-offball-movement-v1';

export interface OffBallMovementInput {
  readonly matchId: string;
  readonly entityId: string;
  readonly fromMs: number;
  readonly toMs: number;
  /** Opponent for the optional spacing-delta signal. */
  readonly opponentEntityId?: string;
  /** Accepted possession-identifying events (kind + actor + time) for off-ball status. */
  readonly possessionEvents?: readonly {
    readonly kind: string;
    readonly actorId: string;
    readonly occurredAtMs: number;
    readonly validityMs: number;
  }[];
  readonly sampleStepMs?: number;
  readonly minCoverage?: number;
}

export interface OffBallMovementValue {
  readonly displacementM: number;
  readonly pathLengthM: number;
  readonly meanSpeedMps: number;
  readonly maxSpeedMps: number;
  readonly spacingDeltaM: number | null;
  readonly gridPoints: number;
  readonly resolvablePoints: number;
  readonly offBallStatus: 'full' | 'partial' | 'unknown';
}

export type OffBallMovementResult = MetricResult<OffBallMovementValue>;

interface GridPose {
  readonly tMs: number;
  readonly xM: number;
  readonly yM: number;
  readonly frameIds: readonly string[];
  readonly interpolated: boolean;
}

export function offBallMovement(
  timeline: Timeline,
  tracking: readonly TrackingSample[],
  reducerRevision: number,
  input: OffBallMovementInput,
): OffBallMovementResult {
  const entityIds =
    input.opponentEntityId !== undefined
      ? [input.entityId, input.opponentEntityId]
      : [input.entityId];
  const metricId = metricIdFor('off-ball-movement', input.matchId, entityIds, {
    windowMs: [input.fromMs, input.toMs],
  });

  const insufficient = (
    code: MetricInsufficientEvidence['failure']['code'],
    detail: string,
  ): OffBallMovementResult => ({
    status: 'insufficient-evidence',
    provenance: {
      kind: 'off-ball-movement',
      algorithmVersion: OFF_BALL_MOVEMENT_VERSION,
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
      inputFingerprint: metricFingerprint(OFF_BALL_MOVEMENT_VERSION, {
        metricId,
        withheld: code,
      }),
      interpretationBoundary:
        'Movement statistics describe observed displacement; they never establish intent, causation or possession.',
    },
    failure: { code, detail },
  });

  if (!(input.toMs > input.fromMs)) {
    return insufficient('invalid-window', 'toMs must be after fromMs');
  }
  const step = input.sampleStepMs ?? 100;
  if (!(step > 0) || !Number.isFinite(step)) {
    return insufficient('invalid-window', 'sampleStepMs must be positive');
  }
  const minCoverage = input.minCoverage ?? 0.6;
  if (minCoverage <= 0 || minCoverage > 1) {
    return insufficient('invalid-window', 'minCoverage must be in (0, 1]');
  }

  // Grid: anchored at fromMs; toMs appended when on-grid.
  const grid: number[] = [];
  for (let t = input.fromMs; t <= input.toMs; t += step) grid.push(t);
  if (grid[grid.length - 1] !== input.toMs && input.toMs > (grid[grid.length - 1] ?? 0)) {
    grid.push(input.toMs);
  }

  const poses: GridPose[] = [];
  let interpolated = 0;
  const frameIds: string[] = [];
  for (const tMs of grid) {
    const pose = timeline.sampleAt(tMs).entities.find((e) => e.entityId === input.entityId);
    const quality = classifyPose(pose);
    if (pose === undefined || quality === 'unusable') continue;
    if (quality === 'exact') {
      // Verified tier requires the raw sample to pass the policy too.
      const gate = checkRawEndpoint(tracking, { entityId: input.entityId, atMs: tMs });
      if (!gate.ok) continue;
    } else {
      interpolated += 1;
    }
    poses.push({
      tMs,
      xM: pose.xM,
      yM: pose.yM,
      frameIds: pose.sourceFrameIds,
      interpolated: quality === 'interpolated',
    });
    frameIds.push(...pose.sourceFrameIds);
  }

  const coverage = grid.length > 0 ? poses.length / grid.length : 0;
  if (poses.length < 2 || coverage < minCoverage) {
    return insufficient(
      'missing-tracking',
      `only ${String(poses.length)}/${String(grid.length)} grid points resolvable (coverage ${coverage.toFixed(2)} < ${String(minCoverage)}); movement signal withheld`,
    );
  }

  // Movement statistics over consecutive resolvable points.
  let pathLength = 0;
  let maxSpeed = 0;
  for (let i = 1; i < poses.length; i += 1) {
    const prev = poses[i - 1]!;
    const curr = poses[i]!;
    const d = Math.hypot(curr.xM - prev.xM, curr.yM - prev.yM);
    pathLength += d;
    const dt = (curr.tMs - prev.tMs) / 1000;
    if (dt > 0) maxSpeed = Math.max(maxSpeed, d / dt);
  }
  const first = poses[0]!;
  const last = poses[poses.length - 1]!;
  const displacement = Math.hypot(last.xM - first.xM, last.yM - first.yM);
  const windowSeconds = (last.tMs - first.tMs) / 1000;

  // Optional spacing delta at the first/last resolvable subject points.
  let spacingDelta: number | null = null;
  if (input.opponentEntityId !== undefined) {
    const opponentAt = (tMs: number): { xM: number; yM: number } | null => {
      const pose = timeline
        .sampleAt(tMs)
        .entities.find((e) => e.entityId === input.opponentEntityId);
      if (pose === undefined || classifyPose(pose) === 'unusable') return null;
      return { xM: pose.xM, yM: pose.yM };
    };
    const startOpponent = opponentAt(first.tMs);
    const endOpponent = opponentAt(last.tMs);
    if (startOpponent !== null && endOpponent !== null) {
      const before = Math.hypot(startOpponent.xM - first.xM, startOpponent.yM - first.yM);
      const after = Math.hypot(endOpponent.xM - last.xM, endOpponent.yM - last.yM);
      spacingDelta = round3(after - before);
    }
  }

  // Off-ball status from accepted possession events only.
  const offBallStatus = computeOffBallStatus(input, poses);

  const value: OffBallMovementValue = {
    displacementM: round3(displacement),
    pathLengthM: round3(pathLength),
    meanSpeedMps: windowSeconds > 0 ? round2(pathLength / windowSeconds) : 0,
    maxSpeedMps: round2(maxSpeed),
    spacingDeltaM: spacingDelta,
    gridPoints: grid.length,
    resolvablePoints: poses.length,
    offBallStatus,
  };

  const interpretationBoundary =
    offBallStatus === 'full'
      ? 'Movement observed while the subject was not the identified ball handler; statistics describe displacement only — never intent or causation.'
      : 'The source could not establish off-ball status for the entire window; statistics describe observed displacement only — never intent, possession or causation.';

  const provenanceBase = {
    kind: 'off-ball-movement' as const,
    algorithmVersion: OFF_BALL_MOVEMENT_VERSION,
    metricId,
    matchId: input.matchId,
    reducerRevision,
    entityIds,
    units: 'metres' as const,
    requested: { windowMs: [input.fromMs, input.toMs] as const },
    dependsOn: {
      sourceFrameIds: [...new Set(frameIds)].sort(),
      eventIds: (input.possessionEvents ?? []).map(
        (event) => `${event.kind}@${event.occurredAtMs}`,
      ),
      entityIds,
    },
    sourceOrigin: 'synthetic_ground_truth' as const,
    classification: 'calculated' as const,
    coverage: {
      exactSamples: poses.filter((p) => !p.interpolated).length,
      interpolatedSamples: interpolated,
      missingEntityIds: [],
    },
    inputFingerprint: metricFingerprint(OFF_BALL_MOVEMENT_VERSION, {
      metricId,
      step,
      poses: poses.map((p) => `${p.tMs}:${round2(p.xM)},${round2(p.yM)}`),
      spacingDelta,
      offBallStatus,
    }),
    interpretationBoundary,
  };

  if (interpolated > 0) {
    const disclosed: MetricDisclosed<OffBallMovementValue> = {
      status: 'disclosed',
      assurance: 'includes-interpolation',
      provenance: provenanceBase,
      value,
      disclosure: `${String(interpolated)} of ${String(poses.length)} resolvable points were interpolated across gaps ≤ 400 ms; this signal is disclosed for editorial exploration, not verified source measurement.`,
    };
    return disclosed;
  }
  return { status: 'verified', assurance: 'exact-source', provenance: provenanceBase, value };
}

const POSSESSION_KINDS: ReadonlySet<string> = new Set([
  'kickoff',
  'pass_completed',
  'shot_attempted',
  'goal',
]);

function computeOffBallStatus(
  input: OffBallMovementInput,
  poses: readonly GridPose[],
): 'full' | 'partial' | 'unknown' {
  const all = (input.possessionEvents ?? [])
    .filter((event) => POSSESSION_KINDS.has(event.kind))
    .sort((a, b) => a.occurredAtMs - b.occurredAtMs);
  if (all.length === 0) return 'unknown'; // source cannot address possession
  const subjectEvents = all.filter((event) => event.actorId === input.entityId);
  // 'full' = possession events exist and NONE identify the subject over any
  // sampled instant — i.e. the subject was not the identified ball handler
  // (never a stronger possession claim than the events support).
  for (const pose of poses) {
    for (const event of subjectEvents) {
      const from = event.occurredAtMs;
      const to = event.occurredAtMs + event.validityMs;
      if (pose.tMs >= from && pose.tMs <= to) return 'partial';
    }
  }
  return 'full';
}
