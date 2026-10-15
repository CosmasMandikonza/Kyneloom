import { describe, expect, it } from 'vitest';
import { generateMatchFixture, type FixtureBundle } from './simulate';
import { GOLDEN_ACTORS } from './teams';

/**
 * The golden narrative "The Invisible Assist" (docs/15): every assertion
 * here reads the GENERATED data — none of these numbers are injected into
 * the UI or duplicated from the scenario script.
 */

const bundle: FixtureBundle = generateMatchFixture({ seed: 24017 });

function sampleAt(tMs: number, entityId: string) {
  const s = bundle.tracking.find((x) => x.sampleTimeMs === tMs && x.entityId === entityId);
  expect(s, `${entityId}@${tMs}`).toBeDefined();
  return s!;
}

function distance(a: { xM: number; yM: number }, b: { xM: number; yM: number }): number {
  return Math.hypot(a.xM - b.xM, a.yM - b.yM);
}

describe('the decoy run and its measurable consequence', () => {
  const { decoyRun } = bundle.metadata.golden;

  it('metadata separation numbers are derived from the emitted samples, not declared', () => {
    const startFrame = nearestEmittedFrame(decoyRun.fromMs);
    const endFrame = nearestEmittedFrame(decoyRun.toMs);
    const before = distance(
      sampleAt(startFrame, decoyRun.drawnDefender),
      sampleAt(startFrame, decoyRun.striker),
    );
    const after = distance(
      sampleAt(endFrame, decoyRun.drawnDefender),
      sampleAt(endFrame, decoyRun.striker),
    );
    expect(before).toBeCloseTo(decoyRun.separationBeforeM, 2);
    expect(after).toBeCloseTo(decoyRun.separationAfterM, 2);
  });

  it('the defender is drawn away: separation opens by more than two meters', () => {
    expect(decoyRun.separationDeltaM).toBeGreaterThan(2);
    expect(decoyRun.separationAfterM).toBeGreaterThan(decoyRun.separationBeforeM);
  });

  it('the winger actually sprints during the decoy window', () => {
    expect(decoyRun.wingerTopSpeedMps).toBeGreaterThan(6);
  });

  it('at the checkpoint (4722100) the run is in flight and the defender is following', () => {
    const cp = bundle.metadata.goldenCheckpointMs;
    const winger = sampleAt(cp, decoyRun.winger);
    const defender = sampleAt(cp, decoyRun.drawnDefender);
    // The defender is between his mark zone and the winger's short-run path.
    expect(distance(defender, winger)).toBeLessThan(
      distance(sampleAt(nearestEmittedFrame(decoyRun.fromMs), decoyRun.drawnDefender), winger),
    );
  });
});

describe('pass coherence (ball, passer and receiver agree at event times)', () => {
  const { pass } = bundle.metadata.golden;

  it('at pass_attempted the ball is at the passer position', () => {
    const ball = sampleAt(pass.attemptedMs, 'ball');
    const passer = sampleAt(pass.attemptedMs, pass.from);
    expect(distance(ball, passer)).toBeLessThan(1.2);
  });

  it('at pass_completed the ball is at the receiver position', () => {
    const ball = sampleAt(pass.completedMs, 'ball');
    const receiver = sampleAt(pass.completedMs, pass.to);
    expect(distance(ball, receiver)).toBeLessThan(1.2);
  });

  it('during the flight the ball travels from passer toward receiver at pass speed', () => {
    expect(pass.speedMps).toBeLessThanOrEqual(16);
    const mid = sampleAt((pass.attemptedMs + pass.completedMs) / 2, 'ball');
    const start = sampleAt(pass.attemptedMs, 'ball');
    const end = sampleAt(pass.completedMs, 'ball');
    // Mid-flight ball sits between the endpoints (parametrized straight line).
    const projected = distance(start, mid) + distance(mid, end) - distance(start, end);
    expect(projected).toBeLessThan(0.6);
    // The loft rises mid-flight.
    expect(mid.zM).toBeGreaterThan(0.5);
  });

  it('the golden pass keeps the canonical event id evt-0042', () => {
    const event = bundle.events.find((e) => e.eventId === 'evt-0042');
    expect(event?.kind).toBe('pass_completed');
    expect(event?.occurredAtMs).toBe(pass.completedMs);
    expect(event?.actorId).toBe(pass.from);
    expect(event?.attributes?.['target_player_id']).toBe(pass.to);
  });
});

describe('shot and goal coherence', () => {
  const { shot } = bundle.metadata.golden;

  it('the shot leaves from the striker position within the speed envelope', () => {
    const ball = sampleAt(shot.atMs, 'ball');
    const striker = sampleAt(shot.atMs, shot.by);
    expect(distance(ball, striker)).toBeLessThan(1.2);
    expect(shot.speedMps).toBeGreaterThan(15);
    expect(shot.speedMps).toBeLessThanOrEqual(30);
  });

  it('the ball crosses the goal line inside the goal mouth at the goal moment', () => {
    const ball = sampleAt(shot.goalMs, 'ball');
    expect(ball.xM).toBeCloseTo(52.4, 1);
    expect(Math.abs(ball.yM)).toBeLessThan(3.66); // goal mouth half-width
    expect(ball.zM).toBeLessThan(2.44); // crossbar height
    expect(ball.zM).toBeGreaterThanOrEqual(0.11); // rolling radius at the line
  });

  it('the away goal (first half) shows the same coherence', () => {
    const awayGoal = bundle.events.find((e) => e.kind === 'goal' && e.teamId === 'away')!;
    const ball = sampleAt(awayGoal.occurredAtMs, 'ball');
    expect(ball.xM).toBeCloseTo(52.4, 1);
    expect(Math.abs(ball.yM)).toBeLessThan(3.66);
    // The away striker is within a plausible shooting radius.
    const shooter = sampleAt(awayGoal.occurredAtMs - 400, awayGoal.actorId ?? 'away-10');
    expect(distance(ball, shooter)).toBeLessThan(15);
  });
});

describe('celebration and post-goal state', () => {
  it('after the goal the ball settles in the net and players decelerate', () => {
    const settle = sampleAt(bundle.metadata.sampling.goldenWindowMs[1], 'ball');
    expect(settle.xM).toBeGreaterThan(52);
    const strikerTrack = bundle.tracking.filter(
      (s) =>
        s.entityId === GOLDEN_ACTORS.scorer &&
        s.sampleTimeMs >= 4728300 &&
        s.sampleTimeMs <= 4731000,
    );
    expect(strikerTrack.length).toBeGreaterThan(10);
    const last = strikerTrack[strikerTrack.length - 1]!;
    // Celebration: short controlled movement, no full sprint.
    expect(distance(last, sampleAt(4728300, GOLDEN_ACTORS.scorer))).toBeLessThan(10);
  });
});

function nearestEmittedFrame(tMs: number): number {
  let best = bundle.tracking[0]!.sampleTimeMs;
  let bestDelta = Infinity;
  for (const s of bundle.tracking) {
    const delta = Math.abs(s.sampleTimeMs - tMs);
    if (delta < bestDelta) {
      bestDelta = delta;
      best = s.sampleTimeMs;
    }
  }
  return best;
}
