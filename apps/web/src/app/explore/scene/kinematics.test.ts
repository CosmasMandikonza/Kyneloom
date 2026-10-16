import { describe, expect, it } from 'vitest';
import { buildTrajectory, dampFactor, distanceAt, headingAt } from './kinematics';

/**
 * Pure playhead-domain kinematics (KYN-06 review fixes): trajectory lookups
 * and the frame-rate-independent camera damping factor. Everything must be a
 * pure function of the query time — the same playhead, the same answer, no
 * matter what frames were rendered before.
 */

function fixtureTrack(): { t: number[]; xyz: number[] } {
  // A runner: 1 m/s along +x for 1 s (10 samples @100 ms), then a 90° turn
  // to +y for 1 s. 0.1 m of travel per 100 ms step.
  const t: number[] = [];
  const xyz: number[] = [];
  for (let i = 0; i <= 10; i += 1) {
    t.push(1000 + i * 100);
    xyz.push(i / 10, 0, 0);
  }
  for (let i = 1; i <= 10; i += 1) {
    t.push(2000 + i * 100);
    xyz.push(1, i / 10, 0);
  }
  return { t, xyz };
}

describe('buildTrajectory + distanceAt', () => {
  it('accumulates ground-path length and interpolates between samples', () => {
    const traj = buildTrajectory('home-11', fixtureTrack());
    expect(distanceAt(traj, 1000)).toBe(0);
    expect(distanceAt(traj, 1500)).toBeCloseTo(0.5, 6);
    expect(distanceAt(traj, 2000)).toBeCloseTo(1, 6);
    // Mid-turn through the corner sample: path length is the polyline sum.
    expect(distanceAt(traj, 2200)).toBeCloseTo(1.2, 6);
    expect(distanceAt(traj, 3000)).toBeCloseTo(2, 6);
  });

  it('clamps outside the sampled span — no extrapolated travel', () => {
    const traj = buildTrajectory('home-11', fixtureTrack());
    expect(distanceAt(traj, 0)).toBe(0);
    expect(distanceAt(traj, 999_999)).toBeCloseTo(2, 6);
  });

  it('is pure: repeated and out-of-order queries agree', () => {
    const traj = buildTrajectory('home-11', fixtureTrack());
    const a = distanceAt(traj, 1730);
    expect(distanceAt(traj, 2500)).toBeCloseTo(1.5, 6);
    expect(distanceAt(traj, 1730)).toBeCloseTo(a, 12);
  });
});

describe('headingAt', () => {
  it('returns the motion direction inside a segment run', () => {
    const traj = buildTrajectory('home-11', fixtureTrack());
    expect(headingAt(traj, 1400, 50)).toBeCloseTo(0, 6); // moving +x
    expect(headingAt(traj, 2500, 50)).toBeCloseTo(Math.PI / 2, 6); // moving +y
  });

  it('vector-averages the trailing window across a turn', () => {
    const traj = buildTrajectory('home-11', fixtureTrack());
    // At t=2100 a 150 ms window holds one +x segment end and one +y segment
    // end: the vector average is exactly the 45° bisector.
    expect(headingAt(traj, 2100, 150)).toBeCloseTo(Math.PI / 4, 6);
    // A wider window weights the straight legs too — still a pure average.
    expect(headingAt(traj, 2100, 220)).toBeCloseTo(Math.atan2(1, 2), 6);
  });

  it('is deterministic regardless of query history', () => {
    const traj = buildTrajectory('home-11', fixtureTrack());
    const first = headingAt(traj, 1450, 150);
    headingAt(traj, 2900, 150);
    headingAt(traj, 1000, 150);
    expect(headingAt(traj, 1450, 150)).toBeCloseTo(first, 12);
  });

  it('falls back to the nearest earlier motion during rest, deterministically', () => {
    const t = [0, 100, 200, 300, 400, 500];
    const xyz = [0, 0, 0, 5, 0, 0, 5, 0, 0, 5, 0, 0, 5, 0, 0, 5, 0, 0]; // move then rest
    const traj = buildTrajectory('resting', { t, xyz });
    expect(headingAt(traj, 200)).toBeCloseTo(0, 6); // during motion
    expect(headingAt(traj, 500)).toBeCloseTo(0, 6); // resting: nearest earlier motion
    // Fully stationary track: facing +x by convention, still pure.
    const flat = buildTrajectory('flat', { t: [0, 100], xyz: [3, 3, 0, 3, 3, 0] });
    expect(headingAt(flat, 50)).toBe(0);
    expect(headingAt(flat, 50)).toBe(headingAt(flat, 50));
  });
});

describe('dampFactor', () => {
  it('closes exactly DAMPING per 60 fps frame', () => {
    expect(dampFactor(1 / 60, 0.075)).toBeCloseTo(0.075, 10);
  });

  it('is frame-rate independent and bounded', () => {
    // 30 frames of 1/30 s ≈ 60 frames of 1/60 s in remaining-distance terms.
    let remaining60 = 1;
    for (let i = 0; i < 60; i += 1) remaining60 *= 1 - dampFactor(1 / 60, 0.075);
    let remaining30 = 1;
    for (let i = 0; i < 30; i += 1) remaining30 *= 1 - dampFactor(2 / 60, 0.075);
    expect(remaining30).toBeCloseTo(remaining60, 6);
    expect(dampFactor(0, 0.075)).toBe(0);
    expect(dampFactor(5, 0.075)).toBeLessThan(1);
    expect(dampFactor(Number.NaN, 0.075)).toBe(0);
  });

  it('converges at real frame rates (the review-5 regression)', () => {
    // The bug divided SECONDS by 16.6667 → per-frame factor ~0.000078.
    // A correct 1-second transition at 60 fps must close > 98%.
    let remaining = 1;
    for (let i = 0; i < 60; i += 1) remaining *= 1 - dampFactor(1 / 60, 0.075);
    expect(1 - remaining).toBeGreaterThan(0.98);
  });
});
