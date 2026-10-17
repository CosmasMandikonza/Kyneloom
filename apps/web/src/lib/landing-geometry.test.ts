import { describe, expect, it } from 'vitest';
import {
  buildLandingField,
  fragmentBudget,
  mulberry32,
  type LandingFieldInput,
} from './landing-geometry';
import { pitchToThree } from '@kyneloom/contracts';

/**
 * KYN-09 — the fragment field is deterministic and built ONLY from real
 * fixture geometry: outline points sit on the 105×68 m pitch bounds,
 * trajectories map 1:1 through pitchToThree, and the same seed always
 * rebuilds the identical field.
 */

const INPUT: LandingFieldInput = {
  checkpointPlayers: [
    { entityId: 'home-01', xM: -40, yM: 20 },
    { entityId: 'away-03', xM: 25.046, yM: -3.046 },
    { entityId: 'home-09', xM: 23.509, yM: 3.07 },
  ],
  checkpointBall: { xM: 21.241, yM: -2.172 },
  trajectories: [
    {
      entityId: 'away-03',
      role: 'measured',
      pointsM: [
        { xM: 25.046, yM: -3.046 },
        { xM: 20, yM: -4 },
        { xM: 12.29, yM: -5.834 },
      ],
    },
    {
      entityId: 'home-11',
      role: 'runner',
      pointsM: [
        { xM: -5, yM: 25 },
        { xM: 0, yM: 18 },
        { xM: 6, yM: 10 },
      ],
    },
  ],
  fragmentCount: 120,
  seed: 24017,
};

describe('buildLandingField', () => {
  it('is deterministic: same seed → byte-identical field', () => {
    const a = buildLandingField(INPUT);
    const b = buildLandingField(INPUT);
    expect(a).toEqual(b);
  });

  it('produces exactly the requested fragment count with finite values', () => {
    const field = buildLandingField(INPUT);
    expect(field.fragments).toHaveLength(120);
    for (const f of field.fragments) {
      for (const v of [...f.origin, ...f.target, ...f.control]) {
        expect(Number.isFinite(v)).toBe(true);
      }
      expect(f.delayMs).toBeGreaterThanOrEqual(0);
      expect(f.durationMs).toBeGreaterThan(0);
      expect(f.sizeM).toBeGreaterThan(0);
    }
  });

  it('outline points lie on the regulation pitch boundary (105 × 68 m)', () => {
    const field = buildLandingField(INPUT);
    expect(field.pitchOutline.length).toBeGreaterThan(50);
    for (const [x, y, z] of field.pitchOutline) {
      expect(y).toBe(0);
      expect(Math.abs(x)).toBeLessThanOrEqual(52.5 + 1e-6);
      expect(Math.abs(z)).toBeLessThanOrEqual(34 + 1e-6);
      const onBoundary = Math.abs(Math.abs(x) - 52.5) < 1e-3 || Math.abs(Math.abs(z) - 34) < 1e-3;
      expect(onBoundary).toBe(true);
    }
  });

  it('trajectories map 1:1 through the canonical pitchToThree transform', () => {
    const field = buildLandingField(INPUT);
    const runner = field.trajectories.find((t) => t.entityId === 'home-11')!;
    expect(runner.role).toBe('runner');
    const [x, , z] = pitchToThree({ xM: -5, yM: 25, zM: 0 });
    expect(runner.points[0]![0]).toBeCloseTo(x, 6);
    expect(runner.points[0]![1]).toBeCloseTo(0.06, 6); // zM 0.06 ground lift
    expect(runner.points[0]![2]).toBeCloseTo(z, 6);
  });

  it('checkpoint markers include every player plus the ball at exact positions', () => {
    const field = buildLandingField(INPUT);
    expect(field.checkpointMarkers).toHaveLength(4);
    const ball = field.checkpointMarkers.find((m) => m.entityId === 'ball')!;
    const [bx, , bz] = pitchToThree({ xM: 21.241, yM: -2.172, zM: 0 });
    expect(ball.position[0]).toBeCloseTo(bx, 6);
    expect(ball.position[2]).toBeCloseTo(bz, 6);
  });

  it('every fragment target is one of the real geometry points (never invented)', () => {
    const field = buildLandingField(INPUT);
    const realTargets = new Set(
      [
        ...field.pitchOutline,
        ...field.halfwayLine,
        ...field.centreCircle,
        ...field.trajectories.flatMap((t) => t.points),
        ...field.checkpointMarkers.map((m) => m.position),
      ].map((p) => `${p[0].toFixed(6)},${p[1].toFixed(6)},${p[2].toFixed(6)}`),
    );
    for (const f of field.fragments) {
      expect(
        realTargets.has(
          `${f.target[0].toFixed(6)},${f.target[1].toFixed(6)},${f.target[2].toFixed(6)}`,
        ),
      ).toBe(true);
    }
  });

  it('different seeds produce different fields (no accidental constant)', () => {
    const a = buildLandingField(INPUT);
    const b = buildLandingField({ ...INPUT, seed: 999 });
    expect(a.fragments).not.toEqual(b.fragments);
  });

  it('handles the empty-fixture fallback without throwing', () => {
    const field = buildLandingField({
      checkpointPlayers: [],
      checkpointBall: null,
      trajectories: [],
      fragmentCount: 10,
      seed: 1,
    });
    expect(field.fragments).toHaveLength(10); // fall back to outline targets
    expect(field.checkpointMarkers).toHaveLength(0);
  });
});

describe('fragmentBudget (device budgets, review gate 4)', () => {
  it('phone widths get the mobile budget even with a FINE pointer', () => {
    // The exact regression: 375×812 with a desktop-pointer emulation.
    expect(fragmentBudget(375, false)).toBe(320);
    expect(fragmentBudget(390, false)).toBe(320);
    expect(fragmentBudget(479, false)).toBe(320);
  });

  it('coarse pointers get the mobile budget at any width', () => {
    expect(fragmentBudget(1440, true)).toBe(320);
    expect(fragmentBudget(430, true)).toBe(320);
  });

  it('tablet widths cap at the mid budget; desktop gets the full field', () => {
    expect(fragmentBudget(480, false)).toBe(600);
    expect(fragmentBudget(1023, false)).toBe(600);
    expect(fragmentBudget(1024, false)).toBe(900);
    expect(fragmentBudget(1440, false)).toBe(900);
  });
});

describe('mulberry32', () => {
  it('reproduces its sequence for a seed', () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    const seqA = [a(), a(), a()];
    const seqB = [b(), b(), b()];
    expect(seqA).toEqual(seqB);
  });
});
