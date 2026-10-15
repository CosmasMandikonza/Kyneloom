import { describe, expect, it } from 'vitest';
import { parseTrackingSample, type TrackingSample } from './tracking-sample';
import { parseMatchState, type MatchState } from './match-state';

const validSample = {
  schemaVersion: '1.0',
  matchId: 'synthetic-derby-01',
  sampleTimeMs: 4722100,
  entityId: 'away-04',
  xM: 4.35,
  yM: -8.2,
  zM: 0,
  origin: 'synthetic_ground_truth',
  confidence: 1,
  visibility: 'tracked',
  sourceFrameId: 'frame-47221',
};

describe('parseTrackingSample', () => {
  it('accepts the canonical docs/05 player sample', () => {
    const result = parseTrackingSample(validSample);
    expect(result.ok).toBe(true);
  });

  it('accepts ball samples on the same schema (explicit ball handling)', () => {
    const result = parseTrackingSample({
      ...validSample,
      entityId: 'ball',
      zM: 12.5,
      sourceFrameId: 'frame-47222',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.entityId).toBe('ball');
    expect(result.data.zM).toBe(12.5);
  });

  it('accepts disclosed interpolation with a method', () => {
    const result = parseTrackingSample({
      ...validSample,
      origin: 'interpolated',
      visibility: 'partial',
      confidence: 0.8,
      reconstruction: { method: 'linear-between-frames-47220-47224' },
    });
    expect(result.ok).toBe(true);
  });

  it('accepts disclosed extrapolation with a method and uncertainty horizon', () => {
    const result = parseTrackingSample({
      ...validSample,
      origin: 'extrapolated',
      visibility: 'untracked',
      confidence: 0.4,
      reconstruction: { method: 'constant-velocity', uncertaintyHorizonMs: 400 },
    });
    expect(result.ok).toBe(true);
  });

  it('rejects "tracked" visibility with a non-factual origin', () => {
    const result = parseTrackingSample({ ...validSample, origin: 'interpolated' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.some((e) => e.fieldPath === 'origin')).toBe(true);
  });

  it('rejects reconstructed origins without a disclosure', () => {
    const result = parseTrackingSample({
      ...validSample,
      origin: 'interpolated',
      visibility: 'partial',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.some((e) => e.fieldPath === 'reconstruction')).toBe(true);
  });

  it('rejects extrapolation without an uncertainty horizon', () => {
    const result = parseTrackingSample({
      ...validSample,
      origin: 'extrapolated',
      visibility: 'untracked',
      reconstruction: { method: 'constant-velocity' },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.some((e) => e.fieldPath === 'reconstruction.uncertaintyHorizonMs')).toBe(
      true,
    );
  });

  it('rejects factual origins carrying a reconstruction disclosure', () => {
    const result = parseTrackingSample({
      ...validSample,
      reconstruction: { method: 'should-not-be-here' },
    });
    expect(result.ok).toBe(false);
  });

  it('rejects hypothesis origin (samples are physical, never interpretation)', () => {
    expect(parseTrackingSample({ ...validSample, origin: 'hypothesis' }).ok).toBe(false);
  });

  it('rejects NaN/Infinity coordinates and out-of-bounds coordinates', () => {
    for (const patch of [{ xM: Number.NaN }, { yM: Number.POSITIVE_INFINITY }, { zM: 10_000 }]) {
      expect(parseTrackingSample({ ...validSample, ...patch }).ok, JSON.stringify(patch)).toBe(
        false,
      );
    }
  });

  it('rejects negative and non-integer sample times', () => {
    expect(parseTrackingSample({ ...validSample, sampleTimeMs: -1 }).ok).toBe(false);
    expect(parseTrackingSample({ ...validSample, sampleTimeMs: 4722100.5 }).ok).toBe(false);
  });

  it('rejects unknown entity ids and unknown fields', () => {
    expect(parseTrackingSample({ ...validSample, entityId: 'referee-1' }).ok).toBe(false);
    const result = parseTrackingSample({ ...validSample, velocity: [1, 2] });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.some((e) => e.code === 'unrecognized_key')).toBe(true);
  });

  it('rejects unsupported schema versions', () => {
    const result = parseTrackingSample({ ...validSample, schemaVersion: '9.9' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]?.code).toBe('unsupported_version');
  });

  it('types flow for downstream consumers', () => {
    const result = parseTrackingSample(validSample);
    if (!result.ok) throw new Error('fixture must parse');
    const sample: TrackingSample = result.data;
    expect(sample.entityId).toBe('away-04');
  });
});

const validState = {
  schemaVersion: '1.0',
  matchId: 'synthetic-derby-01',
  reducerRevision: 11,
  matchTimeMs: 4722100,
  period: 'second_half',
  score: { home: 1, away: 1 },
  ball: {
    entityId: 'ball',
    xM: 12.2,
    yM: -4.0,
    zM: 0.3,
    positionOrigin: 'synthetic_ground_truth',
    confidence: 1,
    possessorEntityId: 'home-08',
  },
  players: [
    {
      entityId: 'home-08',
      teamId: 'home',
      xM: 10.1,
      yM: -3.4,
      zM: 0,
      status: 'on_pitch',
      positionOrigin: 'synthetic_ground_truth',
      confidence: 1,
    },
    {
      entityId: 'away-04',
      teamId: 'away',
      xM: 4.35,
      yM: -8.2,
      zM: 0,
      status: 'on_pitch',
      positionOrigin: 'synthetic_ground_truth',
      confidence: 1,
    },
  ],
  lastAcceptedEventId: 'evt-0042',
  source: { providerId: 'kyneloom-simulator', acceptedEventCount: 414, latestSourceRevision: 1 },
};

describe('parseMatchState', () => {
  it('accepts a coherent projection', () => {
    const result = parseMatchState(validState);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const state: MatchState = result.data;
    expect(state.reducerRevision).toBe(11);
    expect(state.ball.possessorEntityId).toBe('home-08');
  });

  it('rejects a possessor who is not in players', () => {
    const result = parseMatchState({
      ...validState,
      ball: { ...validState.ball, possessorEntityId: 'home-99' },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.some((e) => e.fieldPath === 'ball.possessorEntityId')).toBe(true);
  });

  it('rejects duplicate player entity ids with a precise index path', () => {
    const dup = { ...validState.players[0]! };
    const result = parseMatchState({ ...validState, players: [...validState.players, dup] });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(
      result.errors.some(
        (e) => e.fieldPath === 'players[2].entityId' && e.message.includes('duplicate'),
      ),
    ).toBe(true);
  });

  it('rejects the ball appearing as a player', () => {
    const result = parseMatchState({
      ...validState,
      players: [...validState.players, { ...validState.players[0]!, entityId: 'ball' }],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(
      result.errors.some(
        (e) => e.fieldPath === 'players[2].entityId' && e.message.includes('not a player'),
      ),
    ).toBe(true);
  });

  it('rejects negative scores, unknown periods, and unknown fields', () => {
    expect(parseMatchState({ ...validState, score: { home: -1, away: 0 } }).ok).toBe(false);
    expect(parseMatchState({ ...validState, period: 'third_half' }).ok).toBe(false);
    const result = parseMatchState({ ...validState, tactics: '4-4-2' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.some((e) => e.code === 'unrecognized_key')).toBe(true);
  });

  it('rejects hypothesis as a position origin in the projection', () => {
    const result = parseMatchState({
      ...validState,
      players: [{ ...validState.players[0]!, positionOrigin: 'hypothesis' }],
    });
    expect(result.ok).toBe(false);
  });

  it('caps the players array at a safe bound', () => {
    const many = Array.from({ length: 31 }, (_, i) => ({
      ...validState.players[0]!,
      entityId: `home-${String(i).padStart(2, '0')}`,
    }));
    expect(parseMatchState({ ...validState, players: many }).ok).toBe(false);
  });
});
