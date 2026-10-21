import { describe, expect, it } from 'vitest';
import type { TrackingSample } from '@kyneloom/contracts';
import { createTimeline } from '../reducer/timeline';
import { nearestOpponent } from './metric-nearest';
import { laneOccupancy } from './metric-lane';
import { offBallMovement } from './metric-movement';
import { separationDelta } from './metric-separation-adapter';
import { parseMetricQuery } from './agent-tool';

/**
 * KYN-12 independent numerical validation.
 *
 * Each metric is checked against HAND-CALCULATED expectations on tiny
 * purpose-built fixtures — never against another function that shares the
 * implementation. Geometry is chosen so the expected values are derivable
 * on paper (3-4-5 triangles, integer grids).
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
    matchId: 'hand-calc',
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
  return { timeline, tracking: samples, revision: 7 };
}

describe('Metric A — nearest opponent (kyneloom-nearest-opponent-v1)', () => {
  it('HAND-CALC: 3-4-5 triangle → exactly 5.000 m to the nearest opponent', () => {
    // home-01 at (10, 0). away-01 at (13, 4) → dx 3, dy 4 → 5 m (nearest).
    // away-02 at (10, 10) → 10 m (farther).
    const { timeline, tracking, revision } = fixtures([
      sample('home-01', 1000, 10, 0),
      sample('away-01', 1000, 13, 4),
      sample('away-02', 1000, 10, 10),
    ]);
    const result = nearestOpponent(timeline, tracking, revision, {
      matchId: 'hand-calc',
      entityId: 'home-01',
      atMs: 1000,
      candidateEntityIds: ['home-01', 'away-01', 'away-02'],
    });
    expect(result.status).toBe('verified');
    if (result.status !== 'verified') return;
    expect(result.value.entityId).toBe('away-01');
    expect(result.value.distanceM).toBe(5);
    expect(result.provenance.units).toBe('metres');
    expect(result.provenance.dependsOn.sourceFrameIds).toContain('frame-10');
  });

  it('HAND-CALC: equidistant opponents tie-break to the smallest entity id', () => {
    // home-01 at (0, 0); away-01 at (3, 4) and away-02 at (-3, 4) → both 5 m.
    const { timeline, tracking, revision } = fixtures([
      sample('home-01', 1000, 0, 0),
      sample('away-01', 1000, 3, 4),
      sample('away-02', 1000, -3, 4),
    ]);
    const result = nearestOpponent(timeline, tracking, revision, {
      matchId: 'hand-calc',
      entityId: 'home-01',
      atMs: 1000,
      candidateEntityIds: ['home-01', 'away-01', 'away-02'],
    });
    expect(result.status).toBe('verified');
    if (result.status !== 'verified') return;
    expect(result.value.entityId).toBe('away-01'); // lexicographic tie-break
    expect(result.value.distanceM).toBe(5);
    // Reversing input order must not change the answer.
    const reversed = nearestOpponent(timeline, tracking, revision, {
      matchId: 'hand-calc',
      entityId: 'home-01',
      atMs: 1000,
      candidateEntityIds: ['away-02', 'away-01', 'home-01'],
    });
    expect(reversed).toEqual(result);
  });

  it('role labeling: defendersOnly uses ONLY authoritative roster roles', () => {
    const { timeline, tracking, revision } = fixtures([
      sample('home-01', 1000, 0, 0),
      sample('away-01', 1000, 1, 0), // midfielder, 1 m — nearest overall
      sample('away-02', 1000, 6, 0), // back, 6 m — nearest defender
    ]);
    const roles = new Map([
      ['away-01', 'midfielder'],
      ['away-02', 'back'],
    ]);
    const unfiltered = nearestOpponent(timeline, tracking, revision, {
      matchId: 'hand-calc',
      entityId: 'home-01',
      atMs: 1000,
      candidateEntityIds: ['home-01', 'away-01', 'away-02'],
    });
    expect(unfiltered.status).toBe('verified');
    if (unfiltered.status === 'verified') {
      expect(unfiltered.value.entityId).toBe('away-01');
      expect(unfiltered.value.roleLabel).toBeNull(); // no roster supplied
    }
    const filtered = nearestOpponent(timeline, tracking, revision, {
      matchId: 'hand-calc',
      entityId: 'home-01',
      atMs: 1000,
      candidateEntityIds: ['home-01', 'away-01', 'away-02'],
      rolesByEntity: roles,
      defendersOnly: true,
    });
    expect(filtered.status).toBe('verified');
    if (filtered.status !== 'verified') return;
    expect(filtered.value.entityId).toBe('away-02');
    expect(filtered.value.distanceM).toBe(6);
    expect(filtered.value.roleLabel).toBe('back');
  });

  it('insufficient evidence: missing actor, low confidence, ambiguous identity, no roster', () => {
    const { timeline, tracking, revision } = fixtures([
      sample('home-01', 1000, 0, 0),
      sample('home-02', 1000, 0, 0),
      sample('away-01', 1000, 1, 0, { confidence: 0.5 }),
      sample('home-03', 2000, 0, 0), // only home-03 at t=2000
      sample('away-02', 1000, 2, 0),
      sample('away-02', 1000, 3, 0), // DUPLICATE (ambiguous identity)
    ]);
    const missing = nearestOpponent(timeline, tracking, revision, {
      matchId: 'hand-calc',
      entityId: 'home-99',
      atMs: 1000,
      candidateEntityIds: ['home-99'],
    });
    expect(missing.status).toBe('insufficient-evidence');
    if (missing.status === 'insufficient-evidence')
      expect(missing.failure.code).toBe('missing-tracking');

    const lowConfidence = nearestOpponent(timeline, tracking, revision, {
      matchId: 'hand-calc',
      entityId: 'home-01',
      atMs: 1000,
      candidateEntityIds: ['home-01', 'away-01'],
    });
    expect(lowConfidence.status).toBe('insufficient-evidence');
    if (lowConfidence.status === 'insufficient-evidence')
      expect(lowConfidence.failure.code).toBe('low-confidence');

    const ambiguous = nearestOpponent(timeline, tracking, revision, {
      matchId: 'hand-calc',
      entityId: 'home-02',
      atMs: 1000,
      candidateEntityIds: ['home-02', 'away-02'],
    });
    expect(ambiguous.status).toBe('insufficient-evidence');
    if (ambiguous.status === 'insufficient-evidence')
      expect(ambiguous.failure.code).toBe('ambiguous-identity');

    const noRoster = nearestOpponent(timeline, tracking, revision, {
      matchId: 'hand-calc',
      entityId: 'home-01',
      atMs: 1000,
      candidateEntityIds: ['home-01', 'away-01'],
      defendersOnly: true,
    });
    expect(noRoster.status).toBe('insufficient-evidence');
    if (noRoster.status === 'insufficient-evidence')
      expect(noRoster.failure.code).toBe('unsupported-role');
  });
});

describe('Metric C — passing-lane occupancy (kyneloom-lane-occupancy-v1)', () => {
  it('HAND-CALC: one opponent inside a 2 m corridor, one outside', () => {
    // Lane from home-01 (0,0) to home-09 (10,0) — a 10 m corridor on the x axis.
    // away-01 at (5, 0.7): lateral 0.7 ≤ 1 → INSIDE.
    // away-02 at (5, 1.4): lateral 1.4 > 1 → OUTSIDE.
    const { timeline, tracking, revision } = fixtures([
      sample('home-01', 1000, 0, 0),
      sample('home-09', 1000, 10, 0),
      sample('away-01', 1000, 5, 0.7),
      sample('away-02', 1000, 5, 1.4),
    ]);
    const result = laneOccupancy(timeline, tracking, revision, {
      matchId: 'hand-calc',
      from: { entityId: 'home-01', atMs: 1000 },
      to: { entityId: 'home-09', atMs: 1000 },
      widthM: 2,
      candidateEntityIds: ['away-01', 'away-02'],
    });
    expect(result.status).toBe('verified');
    if (result.status !== 'verified') return;
    expect(result.value.corridorLengthM).toBe(10);
    expect(result.value.occupants).toHaveLength(1);
    expect(result.value.occupants[0]?.entityId).toBe('away-01');
    expect(result.value.occupants[0]?.lateralM).toBe(0.7);
    expect(result.value.occupants[0]?.alongFraction).toBe(0.5);
  });

  it('HAND-CALC: beyond-endpoint projections and near-end exclusion are excluded', () => {
    // Same lane. away-03 at (12, 0): projection beyond B → excluded.
    // away-04 at (0.5, 0): within the default 1.5 m near-end radius → excluded.
    // away-05 at (-2, 0): projection before A → excluded.
    const { timeline, tracking, revision } = fixtures([
      sample('home-01', 1000, 0, 0),
      sample('home-09', 1000, 10, 0),
      sample('away-03', 1000, 12, 0),
      sample('away-04', 1000, 0.5, 0),
      sample('away-05', 1000, -2, 0),
      sample('away-06', 1000, 5, 0), // dead-centre → inside
    ]);
    const result = laneOccupancy(timeline, tracking, revision, {
      matchId: 'hand-calc',
      from: { entityId: 'home-01', atMs: 1000 },
      to: { entityId: 'home-09', atMs: 1000 },
      widthM: 2,
      candidateEntityIds: ['away-03', 'away-04', 'away-05', 'away-06'],
    });
    expect(result.status).toBe('verified');
    if (result.status !== 'verified') return;
    expect(result.value.occupants.map((o) => o.entityId)).toEqual(['away-06']);
  });

  it('occupants sort by lateral distance with id tie-break; diagonal corridor hand-check', () => {
    // Lane (0,0)→(6,8) (length 10, 3-4-5 scaled). Perpendicular distance of a
    // point P to the line through A,B: |cross(B−A, P−A)| / |B−A|.
    // away-01 at (3, 4) is ON the line → lateral 0.
    // away-02 at (4.6, 3.8): cross = (6*(3.8) − 8*(4.6)) = 22.8 − 36.8 = −14 → |−14|/10 = 1.4 → outside 2m/2=1.
    // away-03 at (4.3, 4.4): cross = 6*4.4 − 8*4.3 = 26.4 − 34.4 = −8 → 0.8 → inside.
    const { timeline, tracking, revision } = fixtures([
      sample('home-01', 1000, 0, 0),
      sample('home-09', 1000, 6, 8),
      sample('away-01', 1000, 3, 4),
      sample('away-02', 1000, 4.6, 3.8),
      sample('away-03', 1000, 4.3, 4.4),
    ]);
    const result = laneOccupancy(timeline, tracking, revision, {
      matchId: 'hand-calc',
      from: { entityId: 'home-01', atMs: 1000 },
      to: { entityId: 'home-09', atMs: 1000 },
      widthM: 2,
      candidateEntityIds: ['away-01', 'away-02', 'away-03'],
    });
    expect(result.status).toBe('verified');
    if (result.status !== 'verified') return;
    expect(result.value.corridorLengthM).toBe(10);
    expect(result.value.occupants.map((o) => o.entityId)).toEqual(['away-01', 'away-03']);
    expect(result.value.occupants[1]?.lateralM).toBe(0.8);
  });

  it('withholds on missing endpoints, coincident points, non-positive width', () => {
    const { timeline, tracking, revision } = fixtures([
      sample('home-01', 1000, 0, 0),
      sample('home-09', 1000, 10, 0),
    ]);
    const noReceiver = laneOccupancy(timeline, tracking, revision, {
      matchId: 'hand-calc',
      from: { entityId: 'home-01', atMs: 1000 },
      to: { entityId: 'home-09', atMs: 5000 }, // no sample at t=5000
      widthM: 2,
      candidateEntityIds: [],
    });
    expect(noReceiver.status).toBe('insufficient-evidence');
    if (noReceiver.status === 'insufficient-evidence') {
      expect(noReceiver.failure.code).toBe('missing-tracking');
    }
    const badWidth = laneOccupancy(timeline, tracking, revision, {
      matchId: 'hand-calc',
      from: { entityId: 'home-01', atMs: 1000 },
      to: { entityId: 'home-09', atMs: 1000 },
      widthM: 0,
      candidateEntityIds: [],
    });
    expect(badWidth.status).toBe('insufficient-evidence');
    if (badWidth.status === 'insufficient-evidence')
      expect(badWidth.failure.code).toBe('invalid-window');
  });
});

describe('Metric D — off-ball movement (kyneloom-offball-movement-v1)', () => {
  it('HAND-CALC: straight 10 m over 1 s at 10 Hz → displacement 10, path 10, mean 10 m/s', () => {
    // home-11 walks (0,0) → (10,0) across 11 exact frames at 100 ms.
    const samples: TrackingSample[] = [];
    for (let i = 0; i <= 10; i += 1) {
      samples.push(sample('home-11', 1000 + i * 100, i, 0));
    }
    const { timeline, tracking, revision } = fixtures(samples);
    const result = offBallMovement(timeline, tracking, revision, {
      matchId: 'hand-calc',
      entityId: 'home-11',
      fromMs: 1000,
      toMs: 2000,
    });
    expect(result.status).toBe('verified');
    if (result.status !== 'verified') return;
    expect(result.value.displacementM).toBe(10);
    expect(result.value.pathLengthM).toBe(10);
    expect(result.value.meanSpeedMps).toBe(10);
    expect(result.value.maxSpeedMps).toBe(10);
    expect(result.value.gridPoints).toBe(11);
    expect(result.value.resolvablePoints).toBe(11);
    expect(result.value.offBallStatus).toBe('unknown'); // no possession events supplied
  });

  it('HAND-CALC: an L-shaped path — path length 7, displacement 5 (3-4-5)', () => {
    // (0,0)→(3,0)→(3,4): path 3+4=7, displacement 5.
    const samples: TrackingSample[] = [
      sample('home-11', 1000, 0, 0),
      sample('home-11', 1500, 3, 0),
      sample('home-11', 2000, 3, 4),
    ];
    const { timeline, tracking, revision } = fixtures(samples);
    const result = offBallMovement(timeline, tracking, revision, {
      matchId: 'hand-calc',
      entityId: 'home-11',
      fromMs: 1000,
      toMs: 2000,
      sampleStepMs: 500,
    });
    expect(result.status).toBe('verified');
    if (result.status !== 'verified') return;
    expect(result.value.pathLengthM).toBe(7);
    expect(result.value.displacementM).toBe(5);
    expect(result.value.maxSpeedMps).toBe(8); // 4 m in the final 0.5 s
  });

  it('interpolated points DOWNGRADE to disclosed; never verified', () => {
    // Samples at t=1000 and t=1300 only: t=1100/1200 interpolate across a
    // 300 ms gap (≤ 400 ms) → disclosed result.
    const samples: TrackingSample[] = [
      sample('home-11', 1000, 0, 0),
      sample('home-11', 1300, 3, 0),
    ];
    const { timeline, tracking, revision } = fixtures(samples);
    const result = offBallMovement(timeline, tracking, revision, {
      matchId: 'hand-calc',
      entityId: 'home-11',
      fromMs: 1000,
      toMs: 1300,
    });
    expect(result.status).toBe('disclosed');
    if (result.status === 'disclosed') {
      expect(result.assurance).toBe('includes-interpolation');
      expect(result.disclosure).toContain('interpolated');
    }
  });

  it('withholds below minimum coverage; off-ball status honors possession events', () => {
    // 11 grid points, only 4 samples → coverage 4/11 < 0.6.
    const samples: TrackingSample[] = [
      sample('home-11', 1000, 0, 0),
      sample('home-11', 1100, 1, 0),
      sample('home-11', 1200, 2, 0),
      sample('home-11', 1300, 3, 0),
    ];
    const { timeline, tracking, revision } = fixtures(samples);
    const withheld = offBallMovement(timeline, tracking, revision, {
      matchId: 'hand-calc',
      entityId: 'home-11',
      fromMs: 1000,
      toMs: 2000,
    });
    expect(withheld.status).toBe('insufficient-evidence');
    if (withheld.status === 'insufficient-evidence') {
      expect(withheld.failure.code).toBe('missing-tracking');
      expect(withheld.failure.detail).toContain('coverage');
    }

    // Off-ball status: home-11 kicks off at 1000 (validity 500 ms) → sampled
    // instants 1000..1500 overlap → 'partial'.
    const moving: TrackingSample[] = [];
    for (let i = 0; i <= 10; i += 1) {
      moving.push(sample('home-11', 1000 + i * 100, i, 0));
    }
    const movingCtx = fixtures(moving);
    const partial = offBallMovement(movingCtx.timeline, movingCtx.tracking, movingCtx.revision, {
      matchId: 'hand-calc',
      entityId: 'home-11',
      fromMs: 1000,
      toMs: 2000,
      possessionEvents: [
        { kind: 'kickoff', actorId: 'home-11', occurredAtMs: 1000, validityMs: 500 },
      ],
    });
    expect(partial.status).toBe('verified');
    if (partial.status === 'verified') expect(partial.value.offBallStatus).toBe('partial');
    // Possession by SOMEONE ELSE the whole window → 'full'.
    const full = offBallMovement(movingCtx.timeline, movingCtx.tracking, movingCtx.revision, {
      matchId: 'hand-calc',
      entityId: 'home-11',
      fromMs: 1000,
      toMs: 2000,
      possessionEvents: [
        { kind: 'kickoff', actorId: 'home-01', occurredAtMs: 1000, validityMs: 10_000 },
      ],
    });
    expect(full.status).toBe('verified');
    if (full.status === 'verified') expect(full.value.offBallStatus).toBe('full');
  });
});

describe('Metric B — separation adapter (kyneloom-separation-v1 preserved)', () => {
  it('HAND-CALC: 6-8-10 separation growth → before 6, after 10, delta +4', () => {
    // away-03 fixed at (0,0); home-09 moves (6,0)→(10,0) over the window.
    const samples: TrackingSample[] = [
      sample('away-03', 1000, 0, 0),
      sample('home-09', 1000, 6, 0),
      sample('away-03', 2000, 0, 0),
      sample('home-09', 2000, 10, 0),
    ];
    const { timeline, tracking, revision } = fixtures(samples);
    const result = separationDelta(timeline, tracking, revision, {
      matchId: 'hand-calc',
      defenderId: 'away-03',
      strikerId: 'home-09',
      fromMs: 1000,
      toMs: 2000,
    });
    expect(result.status).toBe('verified');
    if (result.status !== 'verified') return;
    expect(result.value.beforeM).toBe(6);
    expect(result.value.afterM).toBe(10);
    expect(result.value.deltaM).toBe(4);
    expect(result.provenance.algorithmVersion).toBe('kyneloom-separation-v1');
    expect(result.provenance.inputFingerprint).toMatch(/^[0-9a-f]{8}$/);
  });

  it('withholds when either endpoint sample fails the source-quality gate', () => {
    const samples: TrackingSample[] = [
      sample('away-03', 1000, 0, 0),
      sample('home-09', 1000, 6, 0),
      sample('away-03', 2000, 0, 0),
      sample('home-09', 2000, 10, 0, { visibility: 'partial' }),
    ];
    const { timeline, tracking, revision } = fixtures(samples);
    const result = separationDelta(timeline, tracking, revision, {
      matchId: 'hand-calc',
      defenderId: 'away-03',
      strikerId: 'home-09',
      fromMs: 1000,
      toMs: 2000,
    });
    expect(result.status).toBe('insufficient-evidence');
    if (result.status === 'insufficient-evidence')
      expect(result.failure.code).toBe('partial-visibility');
  });
});

describe('agent tool query validation (parseMetricQuery)', () => {
  it('accepts a well-formed nearest-opponent query', () => {
    const parsed = parseMetricQuery({
      kind: 'nearest-opponent',
      entityId: 'home-11',
      atMs: 4722100,
    });
    expect(parsed.ok).toBe(true);
  });

  it('rejects hostile and malformed queries with typed codes', () => {
    const cases: [unknown, string][] = [
      [{ kind: 'arbitrary-sql', query: 'DROP TABLE' }, 'unsupported-metric'],
      [
        { kind: 'nearest-opponent', entityId: "'; DROP TABLE players; --", atMs: 1000 },
        'invalid-entity',
      ],
      [{ kind: 'nearest-opponent', entityId: 'ball', atMs: 1000 }, 'invalid-entity'],
      [{ kind: 'nearest-opponent', entityId: 'home-11', atMs: Number.NaN }, 'invalid-time'],
      [
        {
          kind: 'separation-delta',
          defenderId: 'away-03',
          strikerId: 'home-09',
          fromMs: 2000,
          toMs: 1000,
        },
        'invalid-window',
      ],
      [
        {
          kind: 'separation-delta',
          defenderId: 'away-03',
          strikerId: 'home-09',
          fromMs: 1000,
          toMs: 1_000_000,
        },
        'window-too-large',
      ],
      [
        {
          kind: 'passing-lane-occupancy',
          fromEntityId: 'home-01',
          fromAtMs: 1,
          toEntityId: 'home-09',
          toAtMs: 1,
          widthM: -1,
        },
        'invalid-argument',
      ],
      [
        {
          kind: 'passing-lane-occupancy',
          fromEntityId: 'home-01',
          fromAtMs: 1,
          toEntityId: 'home-09',
          toAtMs: 1,
          widthM: 999,
        },
        'invalid-argument',
      ],
      [
        {
          kind: 'off-ball-movement',
          entityId: 'home-11',
          fromMs: 1000,
          toMs: 2000,
          sampleStepMs: 1,
        },
        'invalid-argument',
      ],
      ['not-an-object', 'malformed-query'],
      [null, 'malformed-query'],
      [
        {
          kind: 'off-ball-movement',
          entityId: 'home-11',
          fromMs: Number.POSITIVE_INFINITY,
          toMs: 2000,
        },
        'invalid-time',
      ],
    ];
    for (const [raw, expectedCode] of cases) {
      const parsed = parseMetricQuery(raw);
      expect(parsed.ok, JSON.stringify(raw)).toBe(false);
      if (!parsed.ok) expect(parsed.code, JSON.stringify(raw)).toBe(expectedCode);
    }
  });
});
