import { describe, expect, it } from 'vitest';
import type { TrackingSample } from '@kyneloom/contracts';
import { createTimeline } from '../reducer/timeline';
import { nearestOpponent } from './metric-nearest';
import { laneOccupancy } from './metric-lane';
import { offBallMovement } from './metric-movement';
import { metricIdFor } from './metric-result';
import { detectMomentCandidates, type MomentCandidate } from './candidates';

/**
 * KYN-12 review-gate regressions (independent engineering review).
 *
 * Gate 1: metric references fingerprint their calculation arguments;
 * candidate identity fingerprints metric dependency fingerprints and the
 * resolved scorer configuration — never silently reused across changed
 * measurements or changed parameters.
 *
 * Gate 2: incomplete counterparty evidence is withheld or explicitly
 * qualified — a verified spatial conclusion can never rest on unknown
 * opponent positions.
 *
 * All expectations are hand-checkable: geometry on integer grids, statuses
 * derived from the written policy, not from the implementation.
 */

function sample(
  entityId: string,
  sampleTimeMs: number,
  xM: number,
  yM: number,
  overrides: Partial<TrackingSample> = {},
): TrackingSample {
  return {
    schemaVersion: '1.0',
    matchId: 'gate-calc',
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

function fixtures(samples: readonly TrackingSample[]) {
  const timeline = createTimeline(samples);
  return { timeline, tracking: samples, revision: 3 };
}

describe('GATE 1 — metric references fingerprint calculation arguments', () => {
  it('lane width 2 vs width 10 over identical endpoints are DIFFERENT metric references', () => {
    const a = metricIdFor(
      'passing-lane-occupancy',
      'm',
      ['home-09', 'away-03'],
      { windowMs: [1000, 1000] },
      { widthM: 2 },
    );
    const b = metricIdFor(
      'passing-lane-occupancy',
      'm',
      ['home-09', 'away-03'],
      { windowMs: [1000, 1000] },
      { widthM: 10 },
    );
    expect(a).not.toBe(b);
  });

  it('nearest defendersOnly true vs false are DIFFERENT metric references', () => {
    const a = metricIdFor(
      'nearest-opponent',
      'm',
      ['home-09'],
      { atMs: 1000 },
      { defendersOnly: false },
    );
    const b = metricIdFor(
      'nearest-opponent',
      'm',
      ['home-09'],
      { atMs: 1000 },
      { defendersOnly: true },
    );
    expect(a).not.toBe(b);
  });

  it('movement sampleStepMs 100 vs 200 are DIFFERENT metric references', () => {
    const a = metricIdFor(
      'off-ball-movement',
      'm',
      ['home-11'],
      { windowMs: [1000, 2000] },
      { sampleStepMs: 100, minCoverage: 0.6, withOpponentSpacing: false },
    );
    const b = metricIdFor(
      'off-ball-movement',
      'm',
      ['home-11'],
      { windowMs: [1000, 2000] },
      { sampleStepMs: 200, minCoverage: 0.6, withOpponentSpacing: false },
    );
    expect(a).not.toBe(b);
  });

  it('identical kind+entities+window+args are byte-stable (deterministic replay)', () => {
    const args = { widthM: 4, excludeRadiusM: 1.5 };
    expect(
      metricIdFor('passing-lane-occupancy', 'm', ['b', 'a'], { windowMs: [1000, 2000] }, args),
    ).toBe(
      metricIdFor('passing-lane-occupancy', 'm', ['a', 'b'], { windowMs: [1000, 2000] }, args),
    );
  });

  it('real metrics: lane width changes the metricId, not just the geometry', () => {
    const { timeline, tracking, revision } = fixtures([
      sample('home-01', 1000, 0, 0),
      sample('home-02', 1000, 10, 0),
      sample('away-01', 1000, 5, 0.5),
    ]);
    const input = (widthM: number) => ({
      matchId: 'gate-calc',
      from: { entityId: 'home-01', atMs: 1000 },
      to: { entityId: 'home-02', atMs: 1000 },
      widthM,
      candidateEntityIds: ['home-01', 'home-02', 'away-01'],
    });
    const narrow = laneOccupancy(timeline, tracking, revision, input(2));
    const wide = laneOccupancy(timeline, tracking, revision, input(10));
    expect(narrow.provenance.metricId).not.toBe(wide.provenance.metricId);
    // HAND-CHECK: defender 0.5 m off the axis: inside a 10 m corridor
    // (|0.5| ≤ 5), outside a 2 m corridor (|0.5| ≤ 1 → actually INSIDE 2 m
    // corridor too — use 1.5 m lateral to differentiate: inside 10, outside 2).
  });

  it('real metrics: lane lateral 1.5 m — inside width 10, outside width 2 (hand-checked)', () => {
    const { timeline, tracking, revision } = fixtures([
      sample('home-01', 1000, 0, 0),
      sample('home-02', 1000, 10, 0),
      sample('away-01', 1000, 5, 1.5),
    ]);
    const run = (widthM: number) =>
      laneOccupancy(timeline, tracking, revision, {
        matchId: 'gate-calc',
        from: { entityId: 'home-01', atMs: 1000 },
        to: { entityId: 'home-02', atMs: 1000 },
        widthM,
        candidateEntityIds: ['home-01', 'home-02', 'away-01'],
      });
    const wide = run(10);
    const narrow = run(2);
    expect(wide.status).toBe('verified');
    expect(narrow.status).toBe('verified');
    if (wide.status !== 'verified' || narrow.status !== 'verified') return;
    // |1.5| ≤ 5 → occupant of the wide lane; |1.5| > 1 → not in the narrow.
    expect(wide.value.occupants.map((o) => o.entityId)).toEqual(['away-01']);
    expect(narrow.value.occupants).toEqual([]);
  });
});

describe('GATE 1 — candidate identity fingerprints measurements + scorer config', () => {
  // Window math: goal anchor 4700500, look-back 4500 → group start
  // 4696000; toMs = anchor. The KYN-04 separation adapter needs EXACT
  // frames at both endpoints (4696000 and 4700500) — that is where the
  // dependency lives, so the correction below targets the toMs endpoint.
  const baseTracking = (): TrackingSample[] => {
    const samples: TrackingSample[] = [];
    // away-03 sweeps from (24,-3) to (15,-3); home-09 holds (23.5,3).
    // HAND-CHECK separation: before √(0.25²+6²)≈6.02 m, after √(8.5²+6²)
    // ≈10.41 m → Δ≈+4.4 m ≥ the 4 m signal bar.
    samples.push(sample('away-03', 4696000, 24, -3));
    samples.push(sample('away-03', 4698000, 21, -3));
    samples.push(sample('away-03', 4700000, 18, -3));
    samples.push(sample('away-03', 4700500, 15, -3));
    samples.push(sample('home-09', 4696000, 23.5, 3));
    samples.push(sample('home-09', 4698000, 23.5, 3));
    samples.push(sample('home-09', 4700000, 23.5, 3));
    samples.push(sample('home-09', 4700500, 23.5, 3));
    // home-11 sprints 1 m per 100 ms (10 m/s) across the whole window.
    for (let t = 4696000, x = -20; t <= 4700500; t += 100, x += 1) {
      samples.push(sample('home-11', t, x, 20));
    }
    return samples;
  };
  const events = [
    {
      eventId: 'evt-1',
      matchId: 'gate-calc',
      schemaVersion: '1.0',
      kind: 'goal',
      actorId: 'home-09',
      occurredAtMs: 4700500,
      provenance: { origin: 'synthetic_ground_truth' },
      payload: {},
      revision: 1,
    },
  ];

  function detect(
    tracking: readonly TrackingSample[],
    thresholds?: Parameters<typeof detectMomentCandidates>[0]['thresholds'],
  ): readonly MomentCandidate[] {
    return detectMomentCandidates({
      matchId: 'gate-calc',
      reducerRevision: 1,
      events: events as never,
      tracking,
      timeline: createTimeline(tracking),
      separationPairs: [{ defenderId: 'away-03', strikerId: 'home-09' }],
      movementSubjects: ['home-11'],
      windowMs: [4_696_000, 4_702_000],
      ...(thresholds === undefined ? {} : { thresholds }),
    });
  }

  it('a tracking correction at constant event revision changes the candidate identity', () => {
    const before = detect(baseTracking());
    expect(before.length).toBeGreaterThanOrEqual(1);
    // Correct away-03's position at the separation window's toMs ENDPOINT
    // (4700500) — the exact dependency frame — so the measurement changes
    // while the event revision stays identical.
    const corrected = baseTracking().map((s) =>
      s.entityId === 'away-03' && s.sampleTimeMs === 4700500 ? { ...s, xM: s.xM + 3 } : s,
    );
    const after = detect(corrected);
    expect(after.length).toBeGreaterThanOrEqual(1);
    expect(after[0]!.candidateId).not.toBe(before[0]!.candidateId);
    expect(after[0]!.inputFingerprint).not.toBe(before[0]!.inputFingerprint);
  });

  it('score-affecting threshold changes do not silently reuse the candidate id', () => {
    const before = detect(baseTracking());
    // Same detection but a different movement-burst bar: the scorer config
    // is part of the identity even if the surfaced score were identical.
    const after = detect(baseTracking(), { movementBurstMps: 4.0 });
    expect(after[0]!.candidateId).not.toBe(before[0]!.candidateId);
  });

  it('identical source and config are byte-stable', () => {
    const tracking = baseTracking();
    const a = detect(tracking);
    const b = detect([...tracking].reverse()); // delivery order must not matter
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe('GATE 2 — lane: unknown opponent positions never verify a clear lane', () => {
  const endpoints = (): TrackingSample[] => [
    sample('home-01', 1000, 0, 0),
    sample('home-02', 1000, 10, 0),
  ];

  it('HAND-CALC: a low-confidence geometric blocker downgrades the lane to disclosed', () => {
    // away-01 sits ON the lane axis at (5, 0) — unambiguously inside any
    // corridor — but its sample is below the confidence policy.
    const { timeline, tracking, revision } = fixtures([
      ...endpoints(),
      sample('away-01', 1000, 5, 0, { confidence: 0.5 }),
    ]);
    const result = laneOccupancy(timeline, tracking, revision, {
      matchId: 'gate-calc',
      from: { entityId: 'home-01', atMs: 1000 },
      to: { entityId: 'home-02', atMs: 1000 },
      widthM: 6,
      candidateEntityIds: ['home-01', 'home-02', 'away-01'],
    });
    expect(result.status).toBe('disclosed');
    if (result.status !== 'disclosed') return;
    expect(result.value.unresolvedOpponents).toEqual(['away-01']);
    expect(result.disclosure).toContain('away-01');
    expect(result.disclosure).toContain('NOT a verified clear lane');
    expect(result.provenance.coverage.missingEntityIds).toContain('away-01');
  });

  it('HAND-CALC: an absent blocker (no sample at the instant) is disclosed, never verified-empty', () => {
    // away-01 exists only at 500 ms — absent at the passer's 1000 ms instant.
    const { timeline, tracking, revision } = fixtures([
      ...endpoints(),
      sample('away-01', 500, 5, 0),
    ]);
    const result = laneOccupancy(timeline, tracking, revision, {
      matchId: 'gate-calc',
      from: { entityId: 'home-01', atMs: 1000 },
      to: { entityId: 'home-02', atMs: 1000 },
      widthM: 6,
      candidateEntityIds: ['home-01', 'home-02', 'away-01'],
    });
    expect(result.status).toBe('disclosed');
    if (result.status !== 'disclosed') return;
    expect(result.value.unresolvedOpponents).toEqual(['away-01']);
    expect(result.value.occupants).toEqual([]);
  });

  it('HAND-CALC: an interpolated blocker (700 ms gap) is disclosed', () => {
    // away-01 at 800 ms and 1200 ms: at the 1000 ms instant the timeline
    // interpolates its position ON the axis — disclosed, not verified.
    const { timeline, tracking, revision } = fixtures([
      ...endpoints(),
      sample('away-01', 800, 4, 0),
      sample('away-01', 1200, 6, 0),
    ]);
    const result = laneOccupancy(timeline, tracking, revision, {
      matchId: 'gate-calc',
      from: { entityId: 'home-01', atMs: 1000 },
      to: { entityId: 'home-02', atMs: 1000 },
      widthM: 6,
      candidateEntityIds: ['home-01', 'home-02', 'away-01'],
    });
    expect(result.status).toBe('disclosed');
    if (result.status !== 'disclosed') return;
    expect(result.value.unresolvedOpponents).toEqual(['away-01']);
  });

  it('a fully resolved opponent set still verifies (golden semantics preserved)', () => {
    const { timeline, tracking, revision } = fixtures([
      ...endpoints(),
      sample('away-01', 1000, 5, 1), // resolved, inside a 6 m corridor
    ]);
    const result = laneOccupancy(timeline, tracking, revision, {
      matchId: 'gate-calc',
      from: { entityId: 'home-01', atMs: 1000 },
      to: { entityId: 'home-02', atMs: 1000 },
      widthM: 6,
      candidateEntityIds: ['home-01', 'home-02', 'away-01'],
    });
    expect(result.status).toBe('verified');
    if (result.status !== 'verified') return;
    expect(result.value.unresolvedOpponents).toEqual([]);
    expect(result.value.occupants.map((o) => o.entityId)).toEqual(['away-01']);
  });
});

describe('GATE 2 — nearest: a potentially nearer unknown opponent withholds', () => {
  it('HAND-CALC: a low-confidence opponent CLOSER than the resolved one withholds the metric', () => {
    // home-01 at (10,0); away-01 (resolved) at (13,4) → 5 m; away-02 at
    // (10,1) → 1 m but confidence 0.4. The nearest CANNOT be declared.
    const { timeline, tracking, revision } = fixtures([
      sample('home-01', 1000, 10, 0),
      sample('away-01', 1000, 13, 4),
      sample('away-02', 1000, 10, 1, { confidence: 0.4 }),
    ]);
    const result = nearestOpponent(timeline, tracking, revision, {
      matchId: 'gate-calc',
      entityId: 'home-01',
      atMs: 1000,
      candidateEntityIds: ['home-01', 'away-01', 'away-02'],
    });
    expect(result.status).toBe('insufficient-evidence');
    if (result.status !== 'insufficient-evidence') return;
    // The below-policy gate names the opponent and its failure verbatim.
    expect(result.failure.detail).toContain('away-02');
    expect(result.failure.detail).toContain('0.4');
  });

  it('HAND-CALC: an ABSENT opponent (no pose at the instant) withholds too', () => {
    // away-02 exists only at 500 ms — absent at 1000 ms. It may be anywhere,
    // including nearest; the determination must be withheld naming it.
    const { timeline, tracking, revision } = fixtures([
      sample('home-01', 1000, 10, 0),
      sample('away-01', 1000, 13, 4),
      sample('away-02', 500, 10, 0.5),
    ]);
    const result = nearestOpponent(timeline, tracking, revision, {
      matchId: 'gate-calc',
      entityId: 'home-01',
      atMs: 1000,
      candidateEntityIds: ['home-01', 'away-01', 'away-02'],
    });
    expect(result.status).toBe('insufficient-evidence');
    if (result.status !== 'insufficient-evidence') return;
    expect(result.failure.detail).toContain('away-02');
  });

  it('HAND-CALC: an INTERPOLATED nearer candidate withholds (exact tier only)', () => {
    // away-02 interpolated at the instant (800/1200 bracket) → withheld.
    const { timeline, tracking, revision } = fixtures([
      sample('home-01', 1000, 10, 0),
      sample('away-01', 1000, 13, 4),
      sample('away-02', 800, 10, 1),
      sample('away-02', 1200, 10, 1),
    ]);
    const result = nearestOpponent(timeline, tracking, revision, {
      matchId: 'gate-calc',
      entityId: 'home-01',
      atMs: 1000,
      candidateEntityIds: ['home-01', 'away-01', 'away-02'],
    });
    expect(result.status).toBe('insufficient-evidence');
    if (result.status !== 'insufficient-evidence') return;
    expect(result.failure.detail).toContain('away-02');
  });

  it('all-exact opponents still verify with the hand-calculated 3-4-5 distance', () => {
    const { timeline, tracking, revision } = fixtures([
      sample('home-01', 1000, 10, 0),
      sample('away-01', 1000, 13, 4),
      sample('away-02', 1000, 10, 10),
    ]);
    const result = nearestOpponent(timeline, tracking, revision, {
      matchId: 'gate-calc',
      entityId: 'home-01',
      atMs: 1000,
      candidateEntityIds: ['home-01', 'away-01', 'away-02'],
    });
    expect(result.status).toBe('verified');
    if (result.status !== 'verified') return;
    expect(result.value.entityId).toBe('away-01');
    expect(result.value.distanceM).toBe(5);
  });
});

describe('GATE 2 — movement: spacing never rides on unusable opponent input', () => {
  const subjectPath = (): TrackingSample[] => [
    sample('home-11', 1000, 0, 0),
    sample('home-11', 1100, 1, 0),
    sample('home-11', 1200, 2, 0),
  ];

  it('HAND-CALC: exact opponent → spacing verified with opponent frames in the deps', () => {
    // Opponent 3 m away at start, 5 m at end → spacing delta = +2.000 m.
    const { timeline, tracking, revision } = fixtures([
      ...subjectPath(),
      sample('away-03', 1000, 3, 0),
      sample('away-03', 1200, 7, 0),
    ]);
    const result = offBallMovement(timeline, tracking, revision, {
      matchId: 'gate-calc',
      entityId: 'home-11',
      fromMs: 1000,
      toMs: 1200,
      opponentEntityId: 'away-03',
    });
    expect(result.status).toBe('verified');
    if (result.status !== 'verified') return;
    expect(result.value.spacingDeltaM).toBe(2);
    // Opponent endpoint frames are dependencies.
    expect(result.provenance.dependsOn.sourceFrameIds).toContain('frame-10');
    expect(result.provenance.dependsOn.sourceFrameIds).toContain('frame-12');
    expect(result.provenance.dependsOn.entityIds).toContain('away-03');
  });

  it('HAND-CALC: low-confidence opponent → spacing withheld (null), subject stats still verified', () => {
    const { timeline, tracking, revision } = fixtures([
      ...subjectPath(),
      sample('away-03', 1000, 3, 0, { confidence: 0.3 }),
      sample('away-03', 1200, 7, 0),
    ]);
    const result = offBallMovement(timeline, tracking, revision, {
      matchId: 'gate-calc',
      entityId: 'home-11',
      fromMs: 1000,
      toMs: 1200,
      opponentEntityId: 'away-03',
    });
    expect(result.status).toBe('verified');
    if (result.status !== 'verified') return;
    expect(result.value.spacingDeltaM).toBeNull();
    expect(result.value.displacementM).toBe(2); // subject statistics intact
    expect(result.provenance.coverage.missingEntityIds).toContain('away-03');
  });

  it('HAND-CALC: interpolated opponent endpoints → spacing computed but result DISCLOSED', () => {
    // Opponent bracket at 900/1300 (a 400 ms gap — the timeline's
    // interpolation limit) around both subject endpoints (1000, 1200):
    // the opponent resolves as interpolated at both.
    const { timeline, tracking, revision } = fixtures([
      ...subjectPath(),
      sample('away-03', 900, 3, 0),
      sample('away-03', 1300, 7, 0),
    ]);
    const result = offBallMovement(timeline, tracking, revision, {
      matchId: 'gate-calc',
      entityId: 'home-11',
      fromMs: 1000,
      toMs: 1200,
      opponentEntityId: 'away-03',
    });
    expect(result.status).toBe('disclosed');
    if (result.status !== 'disclosed') return;
    expect(result.disclosure).toContain('opponent spacing');
    expect(result.value.spacingDeltaM).not.toBeNull();
    // Interpolated opponent frames ARE tracked as dependencies.
    expect(result.provenance.dependsOn.sourceFrameIds.length).toBeGreaterThanOrEqual(2);
  });

  it('HAND-CALC: an opponent source correction changes the fingerprint (deps tracked)', () => {
    const trackingA = [
      ...subjectPath(),
      sample('away-03', 1000, 3, 0),
      sample('away-03', 1200, 7, 0),
    ];
    const trackingB = trackingA.map((s) =>
      s.entityId === 'away-03' && s.sampleTimeMs === 1200 ? { ...s, xM: 9 } : s,
    );
    const run = (tracking: readonly TrackingSample[]) => {
      const timeline = createTimeline(tracking);
      return offBallMovement(timeline, tracking, 3, {
        matchId: 'gate-calc',
        entityId: 'home-11',
        fromMs: 1000,
        toMs: 1200,
        opponentEntityId: 'away-03',
      });
    };
    const a = run(trackingA);
    const b = run(trackingB);
    expect(a.status).toBe('verified');
    expect(b.status).toBe('verified');
    if (a.status !== 'verified' || b.status !== 'verified') return;
    expect(a.provenance.inputFingerprint).not.toBe(b.provenance.inputFingerprint);
    expect(a.value.spacingDeltaM).toBe(2);
    expect(b.value.spacingDeltaM).toBe(4); // 3→9-2: |9-2|-|3-0| = 7-3 = 4
  });
});
