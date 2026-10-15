import { describe, expect, it } from 'vitest';
import { formatMatchClock, loadGoldenMatch } from './match-fixture';

/**
 * KYN-05 — the server-side seam the cinematic surfaces read match facts
 * through. These tests pin the contract the UI depends on: the committed
 * golden fixture projects cleanly through the reducer, checkpoint state is
 * DERIVED (not stored), and a missing fixture degrades to a truthful
 * unavailable status — never invented data.
 */

describe('formatMatchClock', () => {
  it('formats absolute match ms as a zero-padded MM:SS broadcast clock', () => {
    expect(formatMatchClock(0)).toBe('00:00');
    expect(formatMatchClock(59_999)).toBe('00:59');
    expect(formatMatchClock(4_722_100)).toBe('78:42');
    expect(formatMatchClock(3_600_000)).toBe('60:00');
  });
});

describe('loadGoldenMatch (committed fixture seam)', () => {
  it('projects the committed golden fixture through the authoritative reducer', async () => {
    const golden = await loadGoldenMatch();
    expect(golden.ok).toBe(true);
    if (!golden.ok) return;

    expect(golden.data.matchId).toBe('synthetic-derby-01');
    expect(golden.data.seed).toBe(24017);
    expect(golden.data.generatorVersion).toBe('fixture-engine-v1');
    expect(golden.data.eventCount).toBe(11);
    expect(golden.data.sampleCount).toBe(5129);
    expect(golden.data.goldenWindowMs).toEqual([4_717_000, 4_731_000]);
    expect(golden.data.checkpointMs).toBe(4_722_100);

    // Checkpoint state is reducer-derived at request time, not stored JSON.
    // Possession is source-verified-only: at the checkpoint no possession
    // event identifies a carrier (proximity never grants possession); the
    // measured possession starts later in the window.
    const state = golden.data.stateAtCheckpoint;
    expect(state.period).toBe('second_half');
    expect(state.players).toHaveLength(22);
    expect(state.ball.possessorEntityId).toBeNull();
    expect(golden.data.projected.matchStateAt(4_726_300).ball.possessorEntityId).toBe('home-09');

    // Final score comes only from accepted goal events (0-1 away, then 1-1).
    expect(golden.data.finalScore).toEqual({ home: 1, away: 1 });

    // The projected match carries the accepted events the timeline renders.
    expect(golden.data.projected.acceptedEvents.length).toBeGreaterThan(0);
  });

  it('degrades truthfully when the fixtures directory is missing', async () => {
    const previous = process.env['KYNELOOM_FIXTURES_DIR'];
    process.env['KYNELOOM_FIXTURES_DIR'] = 'Q:/kyneloom-missing-fixtures';
    try {
      const missing = await loadGoldenMatch();
      expect(missing.ok).toBe(false);
      if (missing.ok) return;
      expect(missing.reason).toBe('unavailable');
      expect(missing.message).toMatch(/not found/i);
      expect(missing.message).not.toMatch(/error/i);
    } finally {
      if (previous === undefined) {
        delete process.env['KYNELOOM_FIXTURES_DIR'];
      } else {
        process.env['KYNELOOM_FIXTURES_DIR'] = previous;
      }
    }
  });
});
