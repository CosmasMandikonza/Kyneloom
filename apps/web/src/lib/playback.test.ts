import { describe, expect, it } from 'vitest';
import { formatMatchClockTenths } from './clock';
import {
  advancePlayhead,
  clampPlayhead,
  eventAtPlayhead,
  fractionToPlayhead,
  isPlaybackSpeed,
  PLAYBACK_SPEEDS,
  playheadFraction,
  resetPlayhead,
  stepFrame,
} from './playback';

/**
 * KYN-06 transport semantics: explicit millisecond units everywhere, pure
 * functions only, deterministic seek/reset, no fraction/percent confusion.
 */

const WINDOW = { startMs: 4_717_000, endMs: 4_731_000 } as const;
const FOCUS_MS = 4_722_100;

describe('playhead transport', () => {
  it('clamps out-of-range and non-finite input to the window', () => {
    expect(clampPlayhead(4_716_000, WINDOW)).toBe(WINDOW.startMs);
    expect(clampPlayhead(5_000_000, WINDOW)).toBe(WINDOW.endMs);
    expect(clampPlayhead(Number.NaN, WINDOW)).toBe(WINDOW.startMs);
  });

  it('resets deterministically to the confirmed checkpoint', () => {
    expect(resetPlayhead(WINDOW, FOCUS_MS)).toBe(4_722_100);
    expect(resetPlayhead(WINDOW, 4_722_100)).toBe(4_722_100);
  });

  it('advances by real time × speed and reports the window end exactly once', () => {
    const half = advancePlayhead(4_722_100, 1000, 0.5, WINDOW);
    expect(half.playheadMs).toBe(4_722_600);
    expect(half.atEnd).toBe(false);

    const doubled = advancePlayhead(4_722_100, 1000, 2, WINDOW);
    expect(doubled.playheadMs).toBe(4_724_100);

    const end = advancePlayhead(4_730_500, 1000, 1, WINDOW);
    expect(end).toEqual({ playheadMs: WINDOW.endMs, atEnd: true });

    const clamped = advancePlayhead(WINDOW.endMs, 1000, 1, WINDOW);
    expect(clamped.atEnd).toBe(true);
  });

  it('frame-steps on the fixture 100 ms grid anchored at the window start', () => {
    expect(stepFrame(4_722_100, 1, WINDOW)).toBe(4_722_200);
    expect(stepFrame(4_722_100, -1, WINDOW)).toBe(4_722_000);
    // Off-grid input snaps onto the grid.
    expect(stepFrame(4_722_150, 1, WINDOW)).toBe(4_722_200);
    // Clamped at both ends.
    expect(stepFrame(WINDOW.endMs, 1, WINDOW)).toBe(WINDOW.endMs);
    expect(stepFrame(WINDOW.startMs, -1, WINDOW)).toBe(WINDOW.startMs);
  });

  it('converts between ms and slider fraction without unit confusion', () => {
    const fraction = playheadFraction(4_722_100, WINDOW);
    expect(fraction).toBeCloseTo((4_722_100 - 4_717_000) / (4_731_000 - 4_717_000), 12);
    expect(fractionToPlayhead(fraction, WINDOW)).toBe(4_722_100);
    expect(fractionToPlayhead(0, WINDOW)).toBe(WINDOW.startMs);
    expect(fractionToPlayhead(1, WINDOW)).toBe(WINDOW.endMs);
    // Out-of-range fractions clamp to real times, never negative ms.
    expect(fractionToPlayhead(1.5, WINDOW)).toBe(WINDOW.endMs);
    expect(fractionToPlayhead(-0.5, WINDOW)).toBe(WINDOW.startMs);
  });

  it('exposes exactly the four required speeds', () => {
    expect([...PLAYBACK_SPEEDS]).toEqual([0.25, 0.5, 1, 2]);
    expect(isPlaybackSpeed(0.25)).toBe(true);
    expect(isPlaybackSpeed(0.75)).toBe(false);
  });

  it('formats the broadcast clock with tenths for slow motion', () => {
    expect(formatMatchClockTenths(4_722_100)).toBe('78:42.1');
    expect(formatMatchClockTenths(4_717_000)).toBe('78:37.0');
  });
});

describe('event-at-playhead chip', () => {
  const events = [
    { occurredAtMs: 4_724_000, label: 'Pass released', kind: 'pass_attempted' },
    { occurredAtMs: 4_726_200, label: 'Pass received', kind: 'pass_completed' },
    { occurredAtMs: 4_727_800, label: 'Shot', kind: 'shot_attempted' },
    { occurredAtMs: 4_728_300, label: 'GOAL', kind: 'goal' },
  ];

  it('reports the active event within tolerance', () => {
    const active = eventAtPlayhead(4_728_450, events);
    expect(active?.phase).toBe('active');
    expect(active?.event.kind).toBe('goal');
    expect(active?.event.isGoal).toBe(true);
  });

  it('reports the next upcoming event before it happens', () => {
    const upcoming = eventAtPlayhead(4_722_100, events);
    expect(upcoming?.phase).toBe('upcoming');
    expect(upcoming?.event.occurredAtMs).toBe(4_724_000);
    expect(upcoming?.event.isGoal).toBe(false);
  });

  it('returns null after the last event when nothing is near', () => {
    expect(eventAtPlayhead(4_730_800, events)).toBeNull();
  });
});
