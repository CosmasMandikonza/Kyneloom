import { canonicalJsonStringify } from '@kyneloom/contracts';
import { fnv1aHex } from '../reducer/metric-separation';
import type { Timeline } from '../reducer/timeline';
import type { TrackingSample, MatchEvent } from '@kyneloom/contracts';
import { offBallMovement } from './metric-movement';
import { separationDelta } from './metric-separation-adapter';
import type { MetricResult } from './metric-result';

/**
 * KYN-12 — meaningful-moment candidate detection
 * (`kyneloom-moment-candidates-v1`).
 *
 * A goal is an EVENT. A meaningful moment can be the spatial story that led
 * up to it. The detector combines two independent signal families:
 *
 * **Event salience** — accepted source events (shots, goals, passes,
 * corrections) inside or adjacent to the window.
 *
 * **Tactical-change salience** — source-grounded spatial changes computed
 * by the metric library inside the window: separation deltas, movement
 * bursts, proximity changes. Each signal cites its metric result.
 *
 * SCORING IS NOT CAUSALITY and NOT A PROBABILITY. Weights are transparent,
 * hand-chosen and documented; the total is a ranking heuristic for editorial
 * attention. A candidate is strong when a meaningful spatial change
 * PRECEDED a source-verified outcome — the detector never asserts the
 * change caused the outcome. `causalClaimSupport` is always
 * 'insufficient' for spatial→event causation: no deterministic metric in
 * this library can establish intent or causation.
 *
 * Determinism: candidate ids are fingerprints over canonical, sorted
 * inputs — never iteration order or runtime timestamps. Replaying the
 * identical accepted input reproduces identical ids, windows and scores.
 */

export const CANDIDATE_VERSION = 'kyneloom-moment-candidates-v1';

/** Signal weights (documented; ranking heuristic, not probability). */
export const CANDIDATE_WEIGHTS = {
  goal: 40,
  shot: 12,
  pass: 4,
  correction: 6,
  separationDeltaPerMetre: 2.2,
  movementBurstPerMetrePerSecond: 6,
  proximityGain: 4,
  overlapPenalty: 0.6,
} as const;

/** Tactical-signal thresholds (documented). */
export const CANDIDATE_THRESHOLDS = {
  /** Minimum |separation delta| (m) for a separation signal. */
  separationDeltaM: 4,
  /** Minimum windowed mean speed (m/s) for a movement burst. */
  movementBurstMps: 4.5,
  /** Minimum |spacing delta| (m) toward an opponent for proximity gain. */
  proximityDeltaM: 3,
  /** Minimum total score to surface a candidate. */
  minimumTotalScore: 25,
  /** Look-back before an anchor event for the tactical window (ms). */
  tacticalLookbackMs: 4500,
  /** Look-ahead after the anchor event (ms). */
  tacticalLookaheadMs: 1500,
  /** Candidates closer than this in anchor time merge (ms). */
  mergeWindowMs: 6000,
} as const;

export type CandidateReasonCode =
  | 'event:goal'
  | 'event:shot'
  | 'event:pass'
  | 'event:correction'
  | 'tactical:separation-delta'
  | 'tactical:movement-burst'
  | 'tactical:proximity-gain'
  | 'withheld:insufficient-metric-coverage';

export interface CandidateEventContribution {
  readonly eventId: string;
  readonly kind: string;
  readonly atMs: number;
  readonly points: number;
}

export interface CandidateTacticalContribution {
  readonly metricId: string;
  readonly kind: string;
  readonly detail: string;
  readonly points: number;
}

export interface MomentCandidate {
  readonly candidateId: string;
  readonly scorerVersion: typeof CANDIDATE_VERSION;
  readonly matchId: string;
  readonly reducerRevision: number;
  readonly startMs: number;
  readonly endMs: number;
  readonly anchorEventIds: readonly string[];
  readonly eventIds: readonly string[];
  readonly metricResultRefs: readonly {
    readonly metricId: string;
    readonly algorithmVersion: string;
    readonly status: 'verified' | 'disclosed' | 'insufficient-evidence';
  }[];
  readonly eventSalience: number;
  readonly tacticalSalience: number;
  readonly totalScore: number;
  readonly events: readonly CandidateEventContribution[];
  readonly tactical: readonly CandidateTacticalContribution[];
  readonly reasonCodes: readonly CandidateReasonCode[];
  readonly coverage: {
    readonly insufficientEvidenceSignals: number;
    readonly computedSignals: number;
  };
  readonly confidenceLimitations: readonly string[];
  readonly causalClaimSupport: 'insufficient';
  readonly editorialBoundary: string;
  readonly inputFingerprint: string;
}

export interface DetectionThresholds {
  readonly separationDeltaM: number;
  readonly movementBurstMps: number;
  readonly proximityDeltaM: number;
  readonly minimumTotalScore: number;
  readonly tacticalLookbackMs: number;
  readonly tacticalLookaheadMs: number;
  readonly mergeWindowMs: number;
}

export interface DetectionInput {
  readonly matchId: string;
  readonly reducerRevision: number;
  readonly events: readonly MatchEvent[];
  readonly tracking: readonly TrackingSample[];
  readonly timeline: Timeline;
  /** Entity pairs to evaluate for separation signals (defender, striker). */
  readonly separationPairs?: readonly {
    readonly defenderId: string;
    readonly strikerId: string;
  }[];
  /** Entities to evaluate for movement bursts. */
  readonly movementSubjects?: readonly string[];
  /** Entity time span that bounds detection (the tracked window). */
  readonly windowMs: readonly [number, number];
  readonly weights?: typeof CANDIDATE_WEIGHTS;
  readonly thresholds?: Partial<DetectionThresholds>;
}

const SALIENT_EVENT_BASE_POINTS: Record<string, number> = {
  goal: CANDIDATE_WEIGHTS.goal,
  shot_attempted: CANDIDATE_WEIGHTS.shot,
  pass_completed: CANDIDATE_WEIGHTS.pass,
  pass_attempted: 0, // completion carries the signal; the attempt alone does not
};

export function detectMomentCandidates(input: DetectionInput): readonly MomentCandidate[] {
  const weights = input.weights ?? CANDIDATE_WEIGHTS;
  const thresholds = { ...CANDIDATE_THRESHOLDS, ...input.thresholds } as DetectionThresholds;
  const [windowStart, windowEnd] = input.windowMs;

  // 1. Anchor events inside the tracked window, in deterministic time+id order.
  const anchors = input.events
    .filter(
      (event) =>
        event.occurredAtMs >= windowStart &&
        event.occurredAtMs <= windowEnd &&
        (SALIENT_EVENT_BASE_POINTS[event.kind] ?? 0) > 0,
    )
    .sort((a, b) => a.occurredAtMs - b.occurredAtMs || (a.eventId < b.eventId ? -1 : 1));

  interface Draft {
    readonly anchor: MatchEvent;
    readonly startMs: number;
    readonly endMs: number;
  }
  const drafts: Draft[] = anchors.map((anchor) => ({
    anchor,
    startMs: Math.max(windowStart, anchor.occurredAtMs - thresholds.tacticalLookbackMs),
    endMs: Math.min(windowEnd, anchor.occurredAtMs + thresholds.tacticalLookaheadMs),
  }));

  // 2. Merge overlapping/adjacent drafts sharing anchor proximity.
  const merged: { anchors: MatchEvent[]; startMs: number; endMs: number }[] = [];
  for (const draft of drafts) {
    const last = merged[merged.length - 1];
    if (
      last !== undefined &&
      draft.anchor.occurredAtMs - last.anchors[last.anchors.length - 1]!.occurredAtMs <=
        thresholds.mergeWindowMs
    ) {
      last.anchors.push(draft.anchor);
      last.startMs = Math.min(last.startMs, draft.startMs);
      last.endMs = Math.max(last.endMs, draft.endMs);
    } else {
      merged.push({ anchors: [draft.anchor], startMs: draft.startMs, endMs: draft.endMs });
    }
  }

  // 3. Score each merged window.
  const candidates: MomentCandidate[] = [];
  for (const group of merged) {
    const events: CandidateEventContribution[] = [];
    let eventSalience = 0;
    for (const anchor of group.anchors) {
      const base = SALIENT_EVENT_BASE_POINTS[anchor.kind] ?? 0;
      const points =
        anchor.provenance.origin === 'synthetic_ground_truth' ? base : Math.round(base / 2);
      events.push({
        eventId: anchor.eventId,
        kind: anchor.kind,
        atMs: anchor.occurredAtMs,
        points,
      });
      eventSalience += points;
    }
    // Corrections touching the window's events add salience (a changed story
    // deserves editorial eyes) but never rescue a below-threshold candidate.
    const windowEventIds = new Set(events.map((event) => event.eventId));
    const corrections = input.events.filter(
      (event) =>
        event.correctionOf !== null &&
        (windowEventIds.has(event.correctionOf) ||
          (event.occurredAtMs >= group.startMs && event.occurredAtMs <= group.endMs)),
    );
    for (const correction of corrections) {
      events.push({
        eventId: correction.eventId,
        kind: correction.kind,
        atMs: correction.occurredAtMs,
        points: weights.correction,
      });
      eventSalience += weights.correction;
    }

    const tactical: CandidateTacticalContribution[] = [];
    const metricRefs: {
      metricId: string;
      algorithmVersion: string;
      status: 'verified' | 'disclosed' | 'insufficient-evidence';
      inputFingerprint: string;
    }[] = [];
    const reasonCodes: CandidateReasonCode[] = [];
    const limitations: string[] = [];
    let insufficientSignals = 0;
    let computedSignals = 0;

    const recordMetric = (result: MetricResult<unknown>, kind: string): void => {
      metricRefs.push({
        metricId: result.provenance.metricId,
        algorithmVersion: result.provenance.algorithmVersion,
        status: result.status,
        inputFingerprint: result.provenance.inputFingerprint,
      });
      if (result.status === 'insufficient-evidence') {
        insufficientSignals += 1;
        reasonCodes.push('withheld:insufficient-metric-coverage');
      } else {
        computedSignals += 1;
      }
      if (result.status === 'disclosed') {
        limitations.push(
          `${kind} includes interpolated samples — editorial use, not verified measurement`,
        );
      }
    };

    // Separation signals over the requested pairs.
    for (const pair of input.separationPairs ?? []) {
      const result = separationDelta(input.timeline, input.tracking, input.reducerRevision, {
        matchId: input.matchId,
        defenderId: pair.defenderId,
        strikerId: pair.strikerId,
        fromMs: group.startMs,
        toMs: Math.min(group.endMs, group.anchors[group.anchors.length - 1]!.occurredAtMs),
      });
      recordMetric(result, 'separation-delta');
      if (result.status !== 'insufficient-evidence') {
        const magnitude = Math.abs(result.value.deltaM);
        if (magnitude >= thresholds.separationDeltaM) {
          const points = Math.round(weights.separationDeltaPerMetre * magnitude);
          tactical.push({
            metricId: result.provenance.metricId,
            kind: 'separation-delta',
            detail: `${pair.defenderId}↔${pair.strikerId} separation ${String(result.value.beforeM)}→${String(result.value.afterM)} m (Δ${String(result.value.deltaM)})`,
            points,
          });
          reasonCodes.push('tactical:separation-delta');
        }
      }
    }

    // Movement bursts over the requested subjects.
    const possessionEvents = input.events
      .filter((event) => event.actorId !== null)
      .map((event) => ({
        kind: event.kind,
        actorId: event.actorId as string,
        occurredAtMs: event.occurredAtMs,
        validityMs: 10_000,
      }));
    for (const subject of input.movementSubjects ?? []) {
      const result = offBallMovement(input.timeline, input.tracking, input.reducerRevision, {
        matchId: input.matchId,
        entityId: subject,
        fromMs: group.startMs,
        toMs: Math.min(group.endMs, group.anchors[group.anchors.length - 1]!.occurredAtMs),
        possessionEvents,
      });
      recordMetric(result, 'off-ball-movement');
      if (result.status !== 'insufficient-evidence') {
        // A burst is either a sustained high mean OR a pronounced peak — a
        // sprint inside a longer window must not be diluted by recovery
        // walking (the golden run peaks 7.18 m/s inside a 6.6 s window).
        const meanBurst = result.value.meanSpeedMps >= thresholds.movementBurstMps;
        const peakBurst = result.value.maxSpeedMps >= thresholds.movementBurstMps * 1.5;
        if (meanBurst || peakBurst) {
          const intensity = meanBurst ? result.value.meanSpeedMps : result.value.maxSpeedMps;
          const points = Math.round(weights.movementBurstPerMetrePerSecond * intensity);
          tactical.push({
            metricId: result.provenance.metricId,
            kind: 'movement-burst',
            detail: `${subject} ${meanBurst ? 'mean' : 'peak'} ${String(intensity)} m/s over ${String(result.value.resolvablePoints)} points (off-ball ${result.value.offBallStatus})`,
            points,
          });
          reasonCodes.push('tactical:movement-burst');
          if (result.value.offBallStatus !== 'full') {
            limitations.push(
              `${subject} off-ball status '${result.value.offBallStatus}' — possession identity limited by source events`,
            );
          }
        }
        if (
          result.value.spacingDeltaM !== null &&
          Math.abs(result.value.spacingDeltaM) >= thresholds.proximityDeltaM
        ) {
          tactical.push({
            metricId: result.provenance.metricId,
            kind: 'proximity-gain',
            detail: `${subject} spacing Δ${String(result.value.spacingDeltaM)} m over the window`,
            points: weights.proximityGain,
          });
          reasonCodes.push('tactical:proximity-gain');
        }
      }
    }

    for (const event of events) {
      reasonCodes.push(
        event.kind === 'goal'
          ? 'event:goal'
          : event.kind.startsWith('shot')
            ? 'event:shot'
            : event.kind.startsWith('pass')
              ? 'event:pass'
              : 'event:correction',
      );
    }
    const uniqueReasons = [...new Set(reasonCodes)].sort();

    const tacticalSalience = tactical.reduce((total, signal) => total + signal.points, 0);
    const overlapTrim =
      group.anchors.length > 1
        ? Math.round(group.anchors.length * weights.overlapPenalty * 10) / 10
        : 0;
    const totalScore = Math.max(
      0,
      Math.round((eventSalience + tacticalSalience - overlapTrim) * 10) / 10,
    );
    if (totalScore < thresholds.minimumTotalScore) continue;

    const anchorEventIds = [...group.anchors]
      .sort((a, b) => a.occurredAtMs - b.occurredAtMs || (a.eventId < b.eventId ? -1 : 1))
      .map((anchor) => anchor.eventId);
    // Context events: every accepted event inside the final window (e.g. the
    // pass release attempt) is CITED without adding salience — the story is
    // bigger than its anchors.
    const contextEventIds = input.events
      .filter((event) => event.occurredAtMs >= group.startMs && event.occurredAtMs <= group.endMs)
      .map((event) => event.eventId);
    const allEventIds = [
      ...new Set([...events.map((event) => event.eventId), ...contextEventIds]),
    ].sort();

    const scorerConfig = { weights, thresholds };
    const candidateId = candidateIdFor({
      matchId: input.matchId,
      scorerVersion: CANDIDATE_VERSION,
      reducerRevision: input.reducerRevision,
      startMs: group.startMs,
      endMs: group.endMs,
      anchorEventIds,
      // The DEPENDENCY fingerprints of the contributing metrics — these
      // encode the actual measured source positions, so a tracking
      // correction that changes any relevant measurement changes the
      // candidate identity even at a constant event revision.
      metricFingerprints: metricRefs.map(
        (ref) => `${ref.metricId}:${ref.algorithmVersion}:${ref.inputFingerprint}`,
      ),
      scorerConfig,
    });
    const candidateFingerprint = fnv1aHex(
      canonicalJsonStringify({
        candidateId,
        totalScore,
        eventSalience,
        tacticalSalience,
        tactical: tactical.map((t) => `${t.metricId}:${t.kind}:${String(t.points)}`),
        scorerConfig,
      }),
    );

    limitations.push(
      'Ranking score is a documented heuristic for editorial attention, not a probability',
    );

    candidates.push({
      candidateId,
      scorerVersion: CANDIDATE_VERSION,
      matchId: input.matchId,
      reducerRevision: input.reducerRevision,
      startMs: group.startMs,
      endMs: group.endMs,
      anchorEventIds,
      eventIds: allEventIds,
      metricResultRefs: metricRefs,
      eventSalience,
      tacticalSalience,
      totalScore,
      events: events.sort((a, b) => a.atMs - b.atMs || (a.eventId < b.eventId ? -1 : 1)),
      tactical,
      reasonCodes: uniqueReasons,
      coverage: { insufficientEvidenceSignals: insufficientSignals, computedSignals },
      confidenceLimitations: limitations,
      causalClaimSupport: 'insufficient',
      editorialBoundary:
        'Spatial signals and source events are reported together because they co-occurred in one window; the detector does not establish that any movement caused any outcome.',
      inputFingerprint: candidateFingerprint,
    });
  }

  // 4. Deterministic ranking: score desc, then window start, then id.
  return candidates.sort(
    (a, b) =>
      b.totalScore - a.totalScore ||
      a.startMs - b.startMs ||
      (a.candidateId < b.candidateId ? -1 : 1),
  );
}

function candidateIdFor(parts: {
  matchId: string;
  scorerVersion: string;
  reducerRevision: number;
  startMs: number;
  endMs: number;
  anchorEventIds: readonly string[];
  metricFingerprints: readonly string[];
  /** Resolved weights + thresholds: score-affecting configuration is part
   *  of the identity (review gate 1) — a re-scored corpus can never
   *  silently reuse a candidate id minted under different parameters. */
  scorerConfig: Readonly<Record<string, unknown>>;
}): string {
  return `cand-${fnv1aHex(
    canonicalJsonStringify({
      scorerVersion: parts.scorerVersion,
      matchId: parts.matchId,
      revision: parts.reducerRevision,
      window: [parts.startMs, parts.endMs],
      anchors: [...parts.anchorEventIds].sort(),
      metrics: [...parts.metricFingerprints].sort(),
      scorerConfig: parts.scorerConfig,
    }),
  )}`;
}
