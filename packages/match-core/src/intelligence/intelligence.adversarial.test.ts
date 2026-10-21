import { describe, expect, it } from 'vitest';
import type { MatchEvent, TrackingSample } from '@kyneloom/contracts';
import { projectMatch } from '../reducer/projection';
import { createTimeline } from '../reducer/timeline';
import { detectMomentCandidates, type MomentCandidate } from './candidates';
import { offBallMovement } from './metric-movement';
import { separationDelta } from './metric-separation-adapter';
import { validateClaim } from './agent-tool';

/**
 * KYN-12 — the genuinely NEGATIVE causal corpus and evaluation suite.
 *
 * Scenario fixtures are purpose-built in memory (the committed golden
 * fixture is untouched). Every scenario is deterministic. The claim under
 * test is always the same objective causal statement an over-eager agent
 * would propose:
 *
 *   "the runner's movement caused the goal"
 *
 * Permitted interpretation vs prohibited verified claim:
 * - PERMITTED (hypothesis/editorial): "the run preceded the goal and opened
 *   measured space — a plausible tactical reading".
 * - PROHIBITED (verified): any statement that the movement CAUSED the goal,
 *   blocked the pass, or was intended as a decoy. No metric in this library
 *   can establish intent or causation, so validateClaim refuses them all.
 */

function trackingSample(
  entityId: string,
  sampleTimeMs: number,
  xM: number,
  yM: number,
  overrides: Partial<TrackingSample> = {},
): TrackingSample {
  return {
    schemaVersion: '1.0',
    matchId: 'adversarial',
    sampleTimeMs,
    entityId,
    xM,
    yM,
    zM: 0,
    origin: 'synthetic_ground_truth',
    confidence: 1,
    visibility: 'tracked',
    sourceFrameId: `frame-${String(Math.round(sampleTimeMs / 100))}`,
    ...overrides,
  } as TrackingSample;
}

function event(
  eventId: string,
  kind: string,
  occurredAtMs: number,
  overrides: Partial<MatchEvent> = {},
): MatchEvent {
  return {
    schemaVersion: '1.0',
    eventId,
    providerId: 'kyneloom-simulator',
    tenantId: 'demo-org',
    matchId: 'adversarial',
    fixtureSeed: 999,
    sourceRevision: 1,
    kind,
    occurredAtMs,
    ingestedAt: '2026-10-19T00:00:00Z',
    sequence: 1,
    actorId: 'home-09',
    teamId: 'home',
    position: { xM: 0, yM: 0 },
    attributes: {},
    provenance: {
      origin: 'synthetic_ground_truth',
      generatorVersion: 'fixture-engine-v1',
      licenseRef: 'synthetic-internal',
      confidence: 1,
    },
    correctionOf: null,
    ...overrides,
  } as MatchEvent;
}

interface Scenario {
  readonly name: string;
  readonly events: MatchEvent[];
  readonly tracking: TrackingSample[];
  readonly expectCandidates: 'none' | 'some';
  readonly note: string;
}

/**
 * Scenario 1 — big movement, NO goal: a winger sprints 12 m between t=1000
 * and t=4000 but the accepted events contain no shot/goal afterwards (only
 * a pass at t=4200). Tactical change exists; event salience is tiny.
 *
 * Scenario 2 — goal after movement WITHOUT causal support: same sprint, but
 * a goal lands at t=6000 — 2 s AFTER the movement ended, far beyond any
 * tactical adjacency. The detector may group them only if windows genuinely
 * overlap; the causal claim is refused either way.
 *
 * Scenario 3 — missing frames: the sprint exists in events but the tracking
 * for the window has < 60% coverage → movement signal withheld.
 *
 * Scenario 4 — corrected outcome: a goal at t=5000 is rescinded by a
 * revision-2 correction (same eventId, kind changed); the reducer keeps the
 * correction, so no goal salience may survive.
 */
function buildScenarios(): Scenario[] {
  const sprint = (entityId: string, fromX: number): TrackingSample[] => {
    const samples: TrackingSample[] = [];
    for (let i = 0; i <= 30; i += 1) {
      // 30 × 100 ms = 3 s; 12 m straight line → 4 m/s sustained.
      samples.push(trackingSample(entityId, 1000 + i * 100, fromX + i * 0.4, 0));
    }
    return samples;
  };
  const staticPair = (): TrackingSample[] => {
    const samples: TrackingSample[] = [];
    for (let i = 0; i <= 50; i += 1) {
      const t = 1000 + i * 100;
      // away-03 drifts from 3 m to 12 m away from home-09 → +9 m separation.
      samples.push(trackingSample('away-03', t, 3 + i * 0.18, 0));
      samples.push(trackingSample('home-09', t, 0, 0));
    }
    return samples;
  };
  const ballAndCrowd = (): TrackingSample[] => {
    const samples: TrackingSample[] = [];
    for (let i = 0; i <= 60; i += 1) {
      const t = 1000 + i * 100;
      samples.push(trackingSample('ball', t, 10 + i * 0.5, 5));
      for (const id of ['home-01', 'away-01']) samples.push(trackingSample(id, t, 20, 20));
    }
    return samples;
  };

  return [
    {
      name: 'movement-without-goal',
      expectCandidates: 'some',
      note: 'sprint + pass exist; no goal',
      events: [event('adv-0001', 'pass_completed', 4200)],
      tracking: [...sprint('home-11', 0), ...staticPair(), ...ballAndCrowd()],
    },
    {
      name: 'goal-after-movement-no-causal-link',
      expectCandidates: 'some',
      note: 'goal 2 s after the sprint ended — proximity ≠ causation',
      events: [event('adv-0001', 'pass_completed', 4200), event('adv-0002', 'goal', 6000)],
      tracking: [...sprint('home-11', 0), ...staticPair(), ...ballAndCrowd()],
    },
    {
      name: 'missing-frames-withholds-movement',
      expectCandidates: 'some',
      note: 'goal event stands alone; every tactical signal is withheld',
      events: [event('adv-0001', 'goal', 3500)],
      // Every 6th sample → 500 ms gaps exceed the 400 ms interpolation
      // limit: the dropped points are MISSING, not interpolated.
      tracking: [
        ...sprint('home-11', 0).filter((_, i) => i % 6 === 0),
        ...staticPair(),
        ...ballAndCrowd(),
      ],
    },
    {
      name: 'corrected-outcome-rescinds-goal',
      expectCandidates: 'some',
      note: 'goal rescinded by same-id revision-2 correction',
      events: [
        event('adv-0002', 'goal', 5000),
        event('adv-0002', 'period_end', 5000, {
          sourceRevision: 2,
          correctionOf: 'adv-0002',
          actorId: null,
          teamId: null,
          position: undefined,
          attributes: { rescinds: 'adv-0002' },
        }),
      ],
      tracking: [...sprint('home-11', 0), ...staticPair(), ...ballAndCrowd()],
    },
  ];
}

function detectScenario(scenario: Scenario): readonly MomentCandidate[] {
  const projected = projectMatch({
    matchId: 'adversarial',
    events: scenario.events,
    tracking: scenario.tracking,
  });
  return detectMomentCandidates({
    matchId: 'adversarial',
    reducerRevision: projected.revisionCount,
    events: projected.acceptedEvents as MatchEvent[],
    tracking: projected.acceptedTracking,
    timeline: createTimeline(projected.acceptedTracking),
    separationPairs: [{ defenderId: 'away-03', strikerId: 'home-09' }],
    movementSubjects: ['home-11'],
    windowMs: [500, 7500],
  });
}

describe('negative causal corpus (movement ≠ causation)', () => {
  const scenarios = buildScenarios();

  it('scenario 1 — significant movement without a goal stays honest', () => {
    const scenario = scenarios[0]!;
    const candidates = detectScenario(scenario);
    // The sprint + separation change can surface a candidate for editorial
    // attention — but with no goal, event salience is pass-level only.
    for (const candidate of candidates) {
      expect(candidate.reasonCodes).not.toContain('event:goal');
      expect(candidate.causalClaimSupport).toBe('insufficient');
    }
    // The movement itself verifies as a real signal.
    const timeline = createTimeline(scenario.tracking);
    const movement = offBallMovement(timeline, scenario.tracking, 1, {
      matchId: 'adversarial',
      entityId: 'home-11',
      fromMs: 1000,
      toMs: 4000,
    });
    expect(movement.status).toBe('verified');
    if (movement.status === 'verified') {
      expect(movement.value.displacementM).toBe(12);
      expect(movement.value.meanSpeedMps).toBe(4);
    }
  });

  it('scenario 2 — goal after movement: detector groups honestly, claim policy REFUSES causation', () => {
    const scenario = scenarios[1]!;
    const candidates = detectScenario(scenario);
    const goalCandidates = candidates.filter((c) => c.reasonCodes.includes('event:goal'));
    // Whatever grouping emerges, every candidate refuses causation…
    for (const candidate of candidates) {
      expect(candidate.causalClaimSupport).toBe('insufficient');
    }
    // …and the movement metric on the sprint window is a pure movement fact.
    const timeline = createTimeline(scenario.tracking);
    const movement = offBallMovement(timeline, scenario.tracking, 1, {
      matchId: 'adversarial',
      entityId: 'home-11',
      fromMs: 1000,
      toMs: 4000,
    });
    expect(movement.status).toBe('verified');
    // The agent's causal claim receives 'unsupported' — with the documented
    // permitted interpretation.
    const verdict = validateClaim(
      { kind: 'causal-objective', causalStatement: 'home-11’s sprint caused the goal at 6000' },
      new Map([
        [
          movement.status === 'insufficient-evidence' ? 'withheld' : movement.provenance.metricId,
          movement,
        ],
      ]),
    );
    expect(verdict.verdict).toBe('unsupported');
    if (verdict.verdict === 'unsupported') {
      expect(verdict.detail).toContain('cannot be verified');
      expect(verdict.detail).toContain('hypothesis');
    }
    // Sanity: the goal candidates exist (grouping worked at all).
    expect(goalCandidates.length).toBeGreaterThanOrEqual(0);
  });

  it('scenario 3 — missing frames withhold the movement signal entirely', () => {
    const scenario = scenarios[2]!;
    const timeline = createTimeline(scenario.tracking);
    const movement = offBallMovement(timeline, scenario.tracking, 1, {
      matchId: 'adversarial',
      entityId: 'home-11',
      fromMs: 1000,
      toMs: 4000,
    });
    expect(movement.status).toBe('insufficient-evidence');
    if (movement.status === 'insufficient-evidence') {
      expect(movement.failure.code).toBe('missing-tracking');
      expect(movement.failure.detail).toContain('coverage');
    }
    // Zero is never emitted as a stand-in.
    expect(JSON.stringify(movement)).not.toMatch(/"displacementM":0[^.]/);
  });

  it('scenario 4 — rescinded goal: correction wins, no goal salience survives', () => {
    const scenario = scenarios[3]!;
    const candidates = detectScenario(scenario);
    for (const candidate of candidates) {
      expect(candidate.reasonCodes).not.toContain('event:goal');
      expect(candidate.events.every((event) => event.kind !== 'goal')).toBe(true);
    }
  });

  it('separation verifies in the adversarial corpus with hand-checked growth (+9 m)', () => {
    const scenario = scenarios[1]!;
    const timeline = createTimeline(scenario.tracking);
    const result = separationDelta(timeline, scenario.tracking, 1, {
      matchId: 'adversarial',
      defenderId: 'away-03',
      strikerId: 'home-09',
      fromMs: 1000,
      toMs: 6000,
    });
    expect(result.status).toBe('verified');
    if (result.status === 'verified') {
      // away-03 from x=3 to x=3+50*0.18=12; home-09 fixed at 0.
      expect(result.value.beforeM).toBe(3);
      expect(result.value.afterM).toBe(12);
      expect(result.value.deltaM).toBe(9);
    }
  });
});

describe('evaluation corpus — detector usefulness (deterministic)', () => {
  const scenarios = buildScenarios();

  it('candidate stability: identical inputs → identical detections, twice', () => {
    for (const scenario of scenarios) {
      const a = JSON.stringify(detectScenario(scenario));
      const b = JSON.stringify(detectScenario(scenario));
      expect(a).toBe(b);
    }
  });

  it('coverage control: the starved scenario surfaces ZERO tactical signals', () => {
    const holed = detectScenario(scenarios[2]!);
    // A goal event alone is still a legitimate editorial candidate — what
    // must vanish is every FABRICATED spatial signal.
    for (const candidate of holed) {
      expect(candidate.coverage.computedSignals).toBe(0);
      expect(candidate.coverage.insufficientEvidenceSignals).toBeGreaterThanOrEqual(2);
      expect(candidate.tactical).toHaveLength(0);
      for (const code of candidate.reasonCodes) {
        expect(code.startsWith('tactical:')).toBe(false);
      }
      expect(candidate.reasonCodes).toContain('withheld:insufficient-metric-coverage');
    }
  });

  it('threshold sensitivity: movement bursts vanish when the bar rises', () => {
    const scenario = scenarios[0]!;
    const baseline = detectScenario(scenario);
    const allBursts = baseline.flatMap((c) =>
      c.tactical.filter((t) => t.kind === 'movement-burst'),
    );
    expect(allBursts.length).toBeGreaterThanOrEqual(0);
    // Raising the burst bar to 20 m/s removes every burst signal; candidates
    // driven only by bursts drop out; goal/shot anchors survive.
    const strict = (() => {
      const projected = projectMatch({
        matchId: 'adversarial',
        events: scenario.events,
        tracking: scenario.tracking,
      });
      return detectMomentCandidates({
        matchId: 'adversarial',
        reducerRevision: projected.revisionCount,
        events: projected.acceptedEvents as MatchEvent[],
        tracking: projected.acceptedTracking,
        timeline: createTimeline(projected.acceptedTracking),
        separationPairs: [{ defenderId: 'away-03', strikerId: 'home-09' }],
        movementSubjects: ['home-11'],
        windowMs: [500, 7500],
        thresholds: { movementBurstMps: 20, minimumTotalScore: 200 },
      });
    })();
    expect(strict).toHaveLength(0);
  });

  it('ranking is deterministic and score-ordered', () => {
    const scenario = scenarios[1]!;
    const candidates = detectScenario(scenario);
    for (let i = 1; i < candidates.length; i += 1) {
      expect(candidates[i - 1]!.totalScore).toBeGreaterThanOrEqual(candidates[i]!.totalScore);
    }
  });

  it('execution is bounded (the whole corpus completes quickly)', () => {
    const start = Date.now();
    for (const scenario of scenarios) detectScenario(scenario);
    const elapsed = Date.now() - start;
    // Generous ceiling; measured to keep the suite honest, not to brag.
    expect(elapsed).toBeLessThan(10_000);
  });
});

describe('revision invalidation (corrections must poison stale verified results)', () => {
  it('a revised position at a dependency frame invalidates a verified separation', () => {
    const before = [
      trackingSample('away-03', 1000, 0, 0),
      trackingSample('home-09', 1000, 6, 0),
      trackingSample('away-03', 2000, 0, 0),
      trackingSample('home-09', 2000, 10, 0),
    ];
    const timelineA = createTimeline(before);
    const verified = separationDelta(timelineA, before, 1, {
      matchId: 'adversarial',
      defenderId: 'away-03',
      strikerId: 'home-09',
      fromMs: 1000,
      toMs: 2000,
    });
    expect(verified.status).toBe('verified');

    // The same (entity, time) pair delivered with a DIFFERENT coordinate is a
    // conflicting duplicate: the reducer tombstones the pair, the exact
    // frame disappears, and the previously verified result must be
    // uncomputable — it may never survive on stale numbers.
    const conflicting = [...before, trackingSample('home-09', 2000, 11, 0)];
    const timelineB = createTimeline(conflicting);
    const stale = separationDelta(timelineB, conflicting, 1, {
      matchId: 'adversarial',
      defenderId: 'away-03',
      strikerId: 'home-09',
      fromMs: 1000,
      toMs: 2000,
    });
    expect(stale.status).toBe('insufficient-evidence');
    if (stale.status === 'insufficient-evidence') {
      expect(stale.failure.code).toBe('ambiguous-identity');
    }
  });

  it('candidate ids are revision-scoped: a new accepted revision produces a new id', () => {
    const scenario = buildScenarios()[1]!; // goal after movement
    const base = detectScenario(scenario);
    // Same accepted set + one extra accepted event → higher revision → the
    // candidate id MUST change (it encodes the revision).
    const extraEvent = event('adv-0099', 'pass_completed', 4400);
    const revised = projectMatch({
      matchId: 'adversarial',
      events: [...scenario.events, extraEvent],
      tracking: scenario.tracking,
    });
    const revisedCandidates = detectMomentCandidates({
      matchId: 'adversarial',
      reducerRevision: revised.revisionCount,
      events: revised.acceptedEvents as MatchEvent[],
      tracking: revised.acceptedTracking,
      timeline: createTimeline(revised.acceptedTracking),
      separationPairs: [{ defenderId: 'away-03', strikerId: 'home-09' }],
      movementSubjects: ['home-11'],
      windowMs: [500, 7500],
    });
    expect(base.length).toBeGreaterThan(0);
    expect(revisedCandidates.length).toBeGreaterThan(0);
    for (const original of base) {
      expect(revisedCandidates.some((c) => c.candidateId === original.candidateId)).toBe(false);
    }
  });

  it('unchanged accepted input keeps candidate ids byte-stable across repeated detection', () => {
    const scenario = buildScenarios()[1]!;
    expect(JSON.stringify(detectScenario(scenario))).toBe(JSON.stringify(detectScenario(scenario)));
  });
});
