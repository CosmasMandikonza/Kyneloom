import type { MatchEvent, TrackingSample } from '@kyneloom/contracts';
import { SeededRng } from './rng';
import { attackDirection, GOLDEN_ACTORS, ROSTERS, type PlayerProfile } from './teams';
import {
  AWAY_GOAL_MOVES,
  AWAY_GOAL_MOVES_WINDOW_MS,
  BACKGROUND_EVENT_BEATS,
  FULL_TIME_BEAT,
  GOLDEN_CARRIER_PHASES,
  GOLDEN_CHECKPOINT_MS,
  GOLDEN_EVENT_BEATS,
  GOLDEN_FLIGHTS,
  GOLDEN_GOAL_MS,
  GOLDEN_MOVES,
  GOLDEN_WINDOW_MS,
  type ScriptedMove,
} from './scenario';

/**
 * Deterministic miniature match simulator (KYN-03). Produces the canonical
 * fixture bundle: event envelopes + tracking samples + metadata with derived
 * golden metrics. Simplified football physics by design — bounded speed,
 * acceleration and steering; no claims of professional match-physics
 * accuracy (docs/05 "physically plausible … explicitly synthetic").
 *
 * TWO-PASS DESIGN (coherence guarantee):
 *   Pass 1 simulates player movement (steering toward scripted/background
 *   targets, seeded jitter) and records every player's position per 100 ms
 *   tick. Pass 2 derives the BALL from those recorded tracks: a carried ball
 *   rides its recorded carrier, and a pass flies from the carrier's recorded
 *   release position to the receiver's recorded position at reception time.
 *   Ball–actor agreement at event timestamps is therefore exact by
 *   construction, never approximated.
 *
 * Determinism: fixed 100 ms ticks, seeded PRNG only, no wall clock, no
 * Math.random. Same seed + same simulator version ⇒ identical bundle.
 */

export const SIMULATOR_VERSION = 'fixture-engine-v1';
export const DEFAULT_MATCH_ID = 'synthetic-derby-01';
export const PROVIDER_ID = 'kyneloom-simulator';
export const TENANT_ID = 'demo-org';
const INGEST_BASE_MS = Date.parse('2026-10-12T14:00:00Z');
const INGEST_LAG_MS = 250;
const TICK_MS = 100;
const MAX_ACCEL_MPSS = 3.4;
const BOUND_MARGIN_M = 2;

/** Movement envelope actually enforced by the integrator (tested). */
export const MOVEMENT_ENVELOPE = {
  tickMs: TICK_MS,
  maxAccelMps2: MAX_ACCEL_MPSS,
  carriedBallOffsetM: 0.5,
  carriedBallZM: 0.11,
  maxPassSpeedMps: 16,
  maxShotSpeedMps: 30,
} as const;

export interface SimOptions {
  readonly seed: number;
  /** High-resolution sampling inside the golden window (default 10 Hz). */
  readonly goldenHz?: number;
  /** Low-resolution sampling for the surrounding context (default 1 Hz). */
  readonly backgroundHz?: number;
  readonly contextBeforeMs?: number;
  readonly contextAfterMs?: number;
  readonly pitchLengthM?: number;
  readonly pitchWidthM?: number;
}

export interface ScoreChange {
  readonly atMs: number;
  readonly score: string;
}

export interface GoldenMetrics {
  readonly checkpointMs: number;
  readonly decoyRun: {
    readonly winger: string;
    readonly drawnDefender: string;
    readonly striker: string;
    readonly fromMs: number;
    readonly toMs: number;
    readonly separationBeforeM: number;
    readonly separationAfterM: number;
    readonly separationDeltaM: number;
    readonly wingerTopSpeedMps: number;
  };
  readonly pass: {
    readonly from: string;
    readonly to: string;
    readonly attemptedMs: number;
    readonly completedMs: number;
    readonly distanceM: number;
    readonly speedMps: number;
  };
  readonly shot: {
    readonly by: string;
    readonly atMs: number;
    readonly goalMs: number;
    readonly distanceM: number;
    readonly speedMps: number;
  };
}

export interface FixtureMetadata {
  readonly matchId: string;
  readonly seed: number;
  readonly generatorVersion: string;
  readonly narrative: string;
  readonly pitch: {
    readonly lengthM: number;
    readonly widthM: number;
    readonly coordinateSystem: string;
  };
  readonly attackDirectionsPerHalf: {
    readonly first: { readonly home: string; readonly away: string };
    readonly second: { readonly home: string; readonly away: string };
  };
  readonly sampling: {
    readonly goldenHz: number;
    readonly backgroundHz: number;
    readonly goldenWindowMs: readonly [number, number];
    readonly contextBeforeMs: number;
    readonly contextAfterMs: number;
    readonly emittedFromMs: number;
    readonly emittedToMs: number;
    readonly frameCount: number;
    readonly sampleCount: number;
  };
  readonly eventCount: number;
  readonly goldenCheckpointMs: number;
  readonly scoreTimeline: readonly ScoreChange[];
  readonly golden: GoldenMetrics;
  readonly notes: readonly string[];
}

export interface FixtureBundle {
  readonly events: readonly MatchEvent[];
  readonly tracking: readonly TrackingSample[];
  readonly metadata: FixtureMetadata;
}

interface Vec2 {
  x: number;
  y: number;
}

interface PlayerRuntime {
  profile: PlayerProfile;
  pos: Vec2;
  vel: Vec2;
  jitterTarget: Vec2;
  jitterUntilMs: number;
}

interface BallRuntime {
  pos: { x: number; y: number; z: number };
  mode: 'carried' | 'flight' | 'loose';
  carrierId: string | null;
}

function halfOf(tMs: number): 'first' | 'second' {
  return tMs < 2_700_000 ? 'first' : 'second';
}

function dist2(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

function frameId(tMs: number): string {
  return `frame-${Math.round(tMs / 100)}`;
}

function ingestedAt(occurredAtMs: number): string {
  return new Date(INGEST_BASE_MS + occurredAtMs + INGEST_LAG_MS)
    .toISOString()
    .replace('.000Z', 'Z');
}

function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}

/** The scripted away-goal mini-sequence (first half, away attacks +x). */
const AWAY_GOAL_SEQ = {
  carrier: 'away-10',
  carryFromMs: 2_091_000,
  carryToMs: 2_095_000,
  goalTarget: [52.4, -2] as const,
  goalMs: 2_095_400,
};

interface Beat {
  atMs: number;
  kind: string;
  entityId: string | null;
  teamId: 'home' | 'away' | null;
  attributes: Record<string, string | number | boolean | null>;
  eventId: string;
}

export function generateMatchFixture(options: SimOptions): FixtureBundle {
  const seed = options.seed;
  const goldenHz = options.goldenHz ?? 10;
  const backgroundHz = options.backgroundHz ?? 1;
  const contextBefore = options.contextBeforeMs ?? 30_000;
  const contextAfter = options.contextAfterMs ?? 10_000;
  const pitchLength = options.pitchLengthM ?? 105;
  const pitchWidth = options.pitchWidthM ?? 68;
  if (!Number.isInteger(goldenHz) || goldenHz <= 0 || 1000 % goldenHz !== 0) {
    throw new RangeError(`goldenHz must divide 1000 (e.g. 10 or 20), got ${String(goldenHz)}`);
  }
  if (!Number.isInteger(backgroundHz) || backgroundHz <= 0 || 1000 % backgroundHz !== 0) {
    throw new RangeError(
      `backgroundHz must divide 1000 (e.g. 1 or 2), got ${String(backgroundHz)}`,
    );
  }
  if (backgroundHz > goldenHz) {
    throw new RangeError('backgroundHz must not exceed goldenHz');
  }

  const rng = new SeededRng(seed);
  const halfLengthM = pitchLength / 2;
  const halfWidthM = pitchWidth / 2;
  const goldenStart = GOLDEN_WINDOW_MS.start;
  const goldenEnd = GOLDEN_WINDOW_MS.end;
  const simEnd = goldenEnd + contextAfter;

  const players: PlayerRuntime[] = [...ROSTERS.home, ...ROSTERS.away].map((profile) => {
    const dir = attackDirection(profile.teamId, 'first');
    const start = { x: profile.anchor.x * dir, y: profile.anchor.y };
    return {
      profile,
      pos: { ...start },
      vel: { x: 0, y: 0 },
      jitterTarget: { ...start },
      jitterUntilMs: 0,
    };
  });
  const byId = new Map(players.map((p) => [p.profile.entityId, p]));

  // Ball used by pass 1 as a steering/context proxy; pass 2 re-derives the
  // emitted ball from the recorded player tracks.
  const proxyBall: BallRuntime = {
    pos: { x: 0, y: 0, z: 0.11 },
    mode: 'carried',
    carrierId: 'home-07',
  };

  // Background possession machine state.
  let bgPossession: 'home' | 'away' = 'home';
  let bgNextDecisionMs = 8000;
  let bgFlight: { fromMs: number; toMs: number; from: Vec2; to: Vec2; toId: string } | null = null;

  // ---------------- event beats (built first for position snapshots) --------------
  const beats: Beat[] = [];
  let autoId = 1;
  for (const b of BACKGROUND_EVENT_BEATS) {
    beats.push({ ...b, eventId: `evt-${String(autoId++).padStart(4, '0')}` });
  }
  for (const b of GOLDEN_EVENT_BEATS) {
    beats.push({ ...b, eventId: `evt-${String(autoId++).padStart(4, '0')}` });
  }
  beats.push({ ...FULL_TIME_BEAT, eventId: `evt-${String(autoId).padStart(4, '0')}` });
  const passCompletedBeat = beats.find((b) => b.kind === 'pass_completed' && b.atMs === 4726200);
  if (passCompletedBeat) passCompletedBeat.eventId = 'evt-0042';
  beats.sort((a, b) => a.atMs - b.atMs || (a.eventId < b.eventId ? -1 : 1));
  const beatsByTime = new Map<number, Beat[]>();
  for (const beat of beats) {
    const list = beatsByTime.get(beat.atMs) ?? [];
    list.push(beat);
    beatsByTime.set(beat.atMs, list);
  }

  // ---------------- emission frame plan ----------------
  const frames = new Set<number>();
  const goldenStep = 1000 / goldenHz;
  for (let t = goldenStart; t <= goldenEnd; t += goldenStep) frames.add(t);
  const bgStep = 1000 / backgroundHz;
  for (let t = goldenStart - contextBefore; t <= simEnd; t += bgStep) {
    if (t >= 0) frames.add(t);
  }
  for (const beat of BACKGROUND_EVENT_BEATS) {
    for (let t = beat.atMs - 4000; t <= beat.atMs + 4000; t += bgStep) {
      if (t >= 0 && t <= simEnd) frames.add(t);
    }
  }
  const frameTimes = [...frames].sort((a, b) => a - b);

  // ---------------- pass 1: players (+ proxy ball) ----------------
  const tickCount = Math.floor(simEnd / TICK_MS) + 1;
  const recordedPos = new Map<string, Float64Array>();
  const recordedHeading = new Map<string, Float64Array>();
  for (const p of players) {
    recordedPos.set(p.profile.entityId, new Float64Array(tickCount * 2));
    recordedHeading.set(p.profile.entityId, new Float64Array(tickCount * 2));
  }
  const proxyBallPath = new Float64Array(tickCount * 3);
  const eventPositions = new Map<string, { xM: number; yM: number }>();

  const inAwayGoalSeq = (t: number): boolean =>
    t >= AWAY_GOAL_SEQ.carryFromMs - 4000 && t <= AWAY_GOAL_SEQ.goalMs + 2000;
  const inGolden = (t: number): boolean => t >= goldenStart && t <= goldenEnd;

  function scriptedMoveFor(entityId: string, t: number): ScriptedMove | null {
    // Golden moves also cover the 3 s before the emitted window so every
    // actor converges from formation anchors before high-res sampling begins.
    const candidates =
      t >= goldenStart - 3000 && t <= goldenEnd
        ? GOLDEN_MOVES
        : t >= AWAY_GOAL_MOVES_WINDOW_MS.start && t <= AWAY_GOAL_MOVES_WINDOW_MS.end
          ? AWAY_GOAL_MOVES
          : [];
    let best: ScriptedMove | null = null;
    for (const move of candidates) {
      if (move.entityId !== entityId) continue;
      if (t >= move.fromMs && t <= move.toMs) {
        if (!best || move.fromMs >= best.fromMs) best = move;
      }
    }
    return best;
  }

  function playerTarget(p: PlayerRuntime, t: number, half: 'first' | 'second'): Vec2 {
    const scripted = scriptedMoveFor(p.profile.entityId, t);
    if (scripted) {
      // Sprint segments use linear target motion so the actual position
      // tracks the scripted path closely (no easing-induced lag).
      const span = scripted.toMs - scripted.fromMs;
      const u = span === 0 ? 1 : clamp((t - scripted.fromMs) / span, 0, 1);
      return {
        x: scripted.from[0] + (scripted.to[0] - scripted.from[0]) * u,
        y: scripted.from[1] + (scripted.to[1] - scripted.from[1]) * u,
      };
    }

    const dir = attackDirection(p.profile.teamId, half);
    const ballLine = proxyBall.pos.x * dir; // ball position in attack frame
    const shift = clamp(ballLine * 0.35, -10, 14) * (bgPossession === p.profile.teamId ? 1 : 0.6);
    let tx = p.profile.anchor.x * dir + shift;
    let ty = p.profile.anchor.y;

    if (p.profile.role === 'goalkeeper') {
      const goalX = -dir * (halfLengthM - 2.5);
      tx = goalX + clamp(proxyBall.pos.x - goalX, -4, 4);
      ty = clamp(proxyBall.pos.y * 0.25, -6, 6);
    }

    if (t >= p.jitterUntilMs) {
      p.jitterTarget = { x: rng.jitter(4), y: rng.jitter(4) };
      p.jitterUntilMs = t + rng.int(2000, 4000);
    }
    tx = clamp(tx + p.jitterTarget.x, -halfLengthM - BOUND_MARGIN_M, halfLengthM + BOUND_MARGIN_M);
    ty = clamp(ty + p.jitterTarget.y, -halfWidthM - BOUND_MARGIN_M, halfWidthM + BOUND_MARGIN_M);
    return { x: tx, y: ty };
  }

  function steer(p: PlayerRuntime, target: Vec2, dt: number): void {
    const toTarget = { x: target.x - p.pos.x, y: target.y - p.pos.y };
    const distance = Math.hypot(toTarget.x, toTarget.y);
    const maxSpeed = p.profile.maxSpeedMps;
    // Braking-distance arrival: the speed from which the player can still
    // stop at the target given MAX_ACCEL_MPSS. Without this, players charge
    // at full sprint into slow targets and overshoot by meters.
    const desiredSpeed = Math.min(maxSpeed, Math.sqrt(2 * MAX_ACCEL_MPSS * distance));
    const desired =
      distance === 0
        ? { x: 0, y: 0 }
        : { x: (toTarget.x / distance) * desiredSpeed, y: (toTarget.y / distance) * desiredSpeed };
    const dvx = desired.x - p.vel.x;
    const dvy = desired.y - p.vel.y;
    const dv = Math.hypot(dvx, dvy);
    const maxDv = MAX_ACCEL_MPSS * dt;
    const scale = dv === 0 || dv <= maxDv ? 1 : maxDv / dv;
    p.vel.x += dvx * scale;
    p.vel.y += dvy * scale;
    const speed = Math.hypot(p.vel.x, p.vel.y);
    if (speed > maxSpeed) {
      p.vel.x = (p.vel.x / speed) * maxSpeed;
      p.vel.y = (p.vel.y / speed) * maxSpeed;
    }
    p.pos.x = clamp(
      p.pos.x + p.vel.x * dt,
      -halfLengthM - BOUND_MARGIN_M,
      halfLengthM + BOUND_MARGIN_M,
    );
    p.pos.y = clamp(
      p.pos.y + p.vel.y * dt,
      -halfWidthM - BOUND_MARGIN_M,
      halfWidthM + BOUND_MARGIN_M,
    );
  }

  function proxyCarriedBall(id: string): void {
    const carrier = byId.get(id);
    if (!carrier) throw new Error(`unknown carrier ${id}`);
    const speedNorm = Math.hypot(carrier.vel.x, carrier.vel.y);
    const heading =
      speedNorm > 0.5
        ? { x: carrier.vel.x / speedNorm, y: carrier.vel.y / speedNorm }
        : { x: 1, y: 0 };
    proxyBall.pos = {
      x: carrier.pos.x + heading.x * MOVEMENT_ENVELOPE.carriedBallOffsetM,
      y: carrier.pos.y + heading.y * MOVEMENT_ENVELOPE.carriedBallOffsetM,
      z: MOVEMENT_ENVELOPE.carriedBallZM,
    };
    proxyBall.mode = 'carried';
    proxyBall.carrierId = id;
  }

  function updateProxyBall(t: number): void {
    if (inGolden(t)) {
      const phase = GOLDEN_CARRIER_PHASES.find((p) => t >= p.fromMs && t <= p.toMs);
      if (phase) {
        proxyCarriedBall(phase.entityId);
        return;
      }
      const flight = GOLDEN_FLIGHTS.find((f) => t >= f.fromMs && t <= f.toMs);
      if (flight) {
        proxyBall.mode = 'flight';
        proxyBall.carrierId = null;
        return; // pass 2 derives the actual flight path from recorded tracks
      }
      if (t > GOLDEN_GOAL_MS) {
        proxyBall.mode = 'loose';
        proxyBall.carrierId = null;
        return;
      }
      proxyCarriedBall(GOLDEN_ACTORS.passer);
      return;
    }
    if (inAwayGoalSeq(t)) {
      if (t >= AWAY_GOAL_SEQ.carryFromMs && t <= AWAY_GOAL_SEQ.carryToMs) {
        proxyCarriedBall(AWAY_GOAL_SEQ.carrier);
        return;
      }
      if (t > AWAY_GOAL_SEQ.carryToMs && t <= AWAY_GOAL_SEQ.goalMs) {
        proxyBall.mode = 'flight';
        proxyBall.carrierId = null;
        return;
      }
      // Post-goal restart: the ball rolls out to the home goalkeeper (who
      // defends this goal) instead of teleporting to the center circle.
      if (t <= AWAY_GOAL_SEQ.goalMs + 2000) {
        proxyBall.mode = 'loose';
        proxyBall.carrierId = null;
        return;
      }
      proxyCarriedBall('home-01');
      bgPossession = 'home';
      bgNextDecisionMs = t + 6000;
      return;
    }
    // Background possession machine.
    if (t < bgNextDecisionMs && proxyBall.mode === 'carried' && proxyBall.carrierId) {
      proxyCarriedBall(proxyBall.carrierId);
      return;
    }
    if (proxyBall.mode === 'carried') {
      const team = bgPossession;
      const mates = ROSTERS[team].filter((p) => p.role !== 'goalkeeper');
      // Short passes to one of the three nearest teammates keep the path continuous.
      const fromId = proxyBall.carrierId ?? mates[0]!.entityId;
      const from = { ...byId.get(fromId)!.pos };
      const nearest = mates
        .map((m) => ({ m, d: dist2(byId.get(m.entityId)!.pos, from) }))
        .sort((a, b) => a.d - b.d)
        .slice(0, 3);
      const pick = nearest[rng.int(0, nearest.length - 1)]!;
      const to = { ...byId.get(pick.m.entityId)!.pos };
      // Flight duration derives from distance at a realistic pass speed
      // (~11 m/s); a 35 m switch of play must not cross in half a second.
      const flightDistance = Math.hypot(to.x - from.x, to.y - from.y);
      const flightMs = Math.max(400, Math.round((flightDistance / 11) * 1000));
      bgFlight = { fromMs: t, toMs: t + flightMs, from, to, toId: pick.m.entityId };
      proxyBall.mode = 'flight';
      proxyBall.carrierId = null;
      return;
    }
    if (proxyBall.mode === 'flight' && bgFlight) {
      const span = bgFlight.toMs - bgFlight.fromMs;
      const u = span === 0 ? 1 : clamp((t - bgFlight.fromMs) / span, 0, 1);
      proxyBall.pos = {
        x: bgFlight.from.x + (bgFlight.to.x - bgFlight.from.x) * u,
        y: bgFlight.from.y + (bgFlight.to.y - bgFlight.from.y) * u,
        z: MOVEMENT_ENVELOPE.carriedBallZM,
      };
      if (u >= 1) {
        // The pass is collected by the player it was aimed at. If they moved
        // away from the landing point, the ball rolls on to them — the ball
        // never snaps to a different player (no teleports).
        const receiverId = bgFlight.toId;
        const receiverPos = byId.get(receiverId)!.pos;
        const gap = dist2(receiverPos, proxyBall.pos);
        if (gap > 4) {
          const rollMs = Math.max(200, Math.round((gap / 11) * 1000));
          bgFlight = {
            fromMs: t,
            toMs: t + rollMs,
            from: { ...proxyBall.pos },
            to: { ...receiverPos },
            toId: receiverId,
          };
          return;
        }
        const team = bgPossession;
        proxyCarriedBall(receiverId);
        bgPossession = rng.next() < 0.25 ? (team === 'home' ? 'away' : 'home') : team;
        bgNextDecisionMs = t + rng.int(6000, 16000);
        bgFlight = null;
      }
      return;
    }
    // Loose ball (e.g., after a scripted sequence ends): the nearest player
    // of the possessing team collects it — never a teleport to a fixed
    // midfielder across the pitch.
    const team = bgPossession;
    const mates = ROSTERS[team].filter(
      (p) =>
        p.role !== 'goalkeeper' ||
        Math.hypot(
          proxyBall.pos.x - byId.get(p.entityId)!.pos.x,
          proxyBall.pos.y - byId.get(p.entityId)!.pos.y,
        ) < 6,
    );
    let nearest = mates[0]!;
    let best = Infinity;
    for (const mate of mates) {
      const d = dist2(byId.get(mate.entityId)!.pos, proxyBall.pos);
      if (d < best) {
        best = d;
        nearest = mate;
      }
    }
    proxyCarriedBall(nearest.entityId);
    bgNextDecisionMs = t + rng.int(4000, 8000);
  }

  let lastT = -TICK_MS;
  for (let tick = 0, t = 0; t <= simEnd; t += TICK_MS, tick += 1) {
    const half = halfOf(t);
    const dt = (t - lastT) / 1000;
    lastT = t;

    updateProxyBall(t);
    for (const p of players) {
      steer(p, playerTarget(p, t, half), dt);
    }

    for (const p of players) {
      const pos = recordedPos.get(p.profile.entityId)!;
      const head = recordedHeading.get(p.profile.entityId)!;
      pos[tick * 2] = p.pos.x;
      pos[tick * 2 + 1] = p.pos.y;
      const speedNorm = Math.hypot(p.vel.x, p.vel.y);
      head[tick * 2] = speedNorm > 0.5 ? p.vel.x / speedNorm : 1;
      head[tick * 2 + 1] = speedNorm > 0.5 ? p.vel.y / speedNorm : 0;
    }
    proxyBallPath[tick * 3] = proxyBall.pos.x;
    proxyBallPath[tick * 3 + 1] = proxyBall.pos.y;
    proxyBallPath[tick * 3 + 2] = proxyBall.pos.z;

    for (const beat of beatsByTime.get(t) ?? []) {
      if (beat.entityId) {
        const actor = byId.get(beat.entityId);
        if (actor)
          eventPositions.set(beat.eventId, { xM: round3(actor.pos.x), yM: round3(actor.pos.y) });
      }
    }
  }

  const tickIndex = (tMs: number): number => Math.round(tMs / TICK_MS);
  const recordedPlayerPos = (entityId: string, tMs: number): Vec2 => {
    const idx = clamp(tickIndex(tMs), 0, tickCount - 1);
    const pos = recordedPos.get(entityId)!;
    return { x: pos[idx * 2]!, y: pos[idx * 2 + 1]! };
  };
  const recordedPlayerHeading = (entityId: string, tMs: number): Vec2 => {
    const idx = clamp(tickIndex(tMs), 0, tickCount - 1);
    const head = recordedHeading.get(entityId)!;
    return { x: head[idx * 2]!, y: head[idx * 2 + 1]! };
  };

  // ---------------- pass 2: emit samples with the derived ball ----------------
  const samples: TrackingSample[] = [];
  const sampleAt = (tMs: number, entityId: string, p: Vec2, zM: number): void => {
    samples.push({
      schemaVersion: '1.0',
      matchId: DEFAULT_MATCH_ID,
      sampleTimeMs: tMs,
      entityId,
      xM: round3(p.x),
      yM: round3(p.y),
      zM: round3(zM),
      origin: 'synthetic_ground_truth',
      confidence: 1,
      visibility: 'tracked',
      sourceFrameId: frameId(tMs),
    });
  };

  /** Pass-2 ball: anchored to recorded player tracks inside scripted windows. */
  const derivedBall = (tMs: number): { x: number; y: number; z: number } => {
    if (inGolden(tMs)) {
      const phase = GOLDEN_CARRIER_PHASES.find((p) => tMs >= p.fromMs && tMs <= p.toMs);
      if (phase) {
        const carrier = recordedPlayerPos(phase.entityId, tMs);
        const heading = recordedPlayerHeading(phase.entityId, tMs);
        return {
          x: carrier.x + heading.x * MOVEMENT_ENVELOPE.carriedBallOffsetM,
          y: carrier.y + heading.y * MOVEMENT_ENVELOPE.carriedBallOffsetM,
          z: MOVEMENT_ENVELOPE.carriedBallZM,
        };
      }
      const flight = GOLDEN_FLIGHTS.find((f) => tMs >= f.fromMs && tMs <= f.toMs);
      if (flight) {
        const from = recordedPlayerPos(
          flight.kind === 'pass' ? GOLDEN_ACTORS.passer : GOLDEN_ACTORS.scorer,
          flight.fromMs,
        );
        const to: Vec2 =
          flight.kind === 'pass'
            ? recordedPlayerPos(GOLDEN_ACTORS.scorer, flight.toMs)
            : { x: AWAY_GOAL_SEQ.goalTarget[0], y: AWAY_GOAL_SEQ.goalTarget[1] };
        const span = flight.toMs - flight.fromMs;
        const u = clamp((tMs - flight.fromMs) / span, 0, 1);
        return {
          x: from.x + (to.x - from.x) * u,
          y: from.y + (to.y - from.y) * u,
          z: flight.apexZM * 4 * u * (1 - u) + MOVEMENT_ENVELOPE.carriedBallZM,
        };
      }
      if (tMs > GOLDEN_GOAL_MS) {
        // Settling in the net after the goal.
        const crossing = { x: AWAY_GOAL_SEQ.goalTarget[0], y: AWAY_GOAL_SEQ.goalTarget[1] };
        const u = clamp((tMs - GOLDEN_GOAL_MS) / 3600, 0, 1);
        const eased = 1 - Math.pow(1 - u, 2);
        return {
          x: crossing.x + 0.8 * eased,
          y: crossing.y + 0.2 * eased,
          z: MOVEMENT_ENVELOPE.carriedBallZM,
        };
      }
      const carrier = recordedPlayerPos(GOLDEN_ACTORS.passer, tMs);
      const heading = recordedPlayerHeading(GOLDEN_ACTORS.passer, tMs);
      return {
        x: carrier.x + heading.x * MOVEMENT_ENVELOPE.carriedBallOffsetM,
        y: carrier.y + heading.y * MOVEMENT_ENVELOPE.carriedBallOffsetM,
        z: MOVEMENT_ENVELOPE.carriedBallZM,
      };
    }

    if (tMs >= AWAY_GOAL_SEQ.carryFromMs && tMs <= AWAY_GOAL_SEQ.goalMs) {
      if (tMs <= AWAY_GOAL_SEQ.carryToMs) {
        const carrier = recordedPlayerPos(AWAY_GOAL_SEQ.carrier, tMs);
        const heading = recordedPlayerHeading(AWAY_GOAL_SEQ.carrier, tMs);
        return {
          x: carrier.x + heading.x * MOVEMENT_ENVELOPE.carriedBallOffsetM,
          y: carrier.y + heading.y * MOVEMENT_ENVELOPE.carriedBallOffsetM,
          z: MOVEMENT_ENVELOPE.carriedBallZM,
        };
      }
      const from = recordedPlayerPos(AWAY_GOAL_SEQ.carrier, AWAY_GOAL_SEQ.carryToMs);
      const to = { x: AWAY_GOAL_SEQ.goalTarget[0], y: AWAY_GOAL_SEQ.goalTarget[1] };
      const span = AWAY_GOAL_SEQ.goalMs - AWAY_GOAL_SEQ.carryToMs;
      const u = clamp((tMs - AWAY_GOAL_SEQ.carryToMs) / span, 0, 1);
      return {
        x: from.x + (to.x - from.x) * u,
        y: from.y + (to.y - from.y) * u,
        z: 0.8 * 4 * u * (1 - u) + MOVEMENT_ENVELOPE.carriedBallZM,
      };
    }

    if (tMs > AWAY_GOAL_SEQ.goalMs && tMs <= AWAY_GOAL_SEQ.goalMs + 2000) {
      // Roll from the crossing point toward the home GK over two seconds.
      const from = { x: AWAY_GOAL_SEQ.goalTarget[0], y: AWAY_GOAL_SEQ.goalTarget[1] };
      const to = recordedPlayerPos('home-01', AWAY_GOAL_SEQ.goalMs + 2000);
      const u = clamp((tMs - AWAY_GOAL_SEQ.goalMs) / 2000, 0, 1);
      const eased = u * u * (3 - 2 * u);
      return {
        x: from.x + (to.x - from.x) * eased,
        y: from.y + (to.y - from.y) * eased,
        z: MOVEMENT_ENVELOPE.carriedBallZM,
      };
    }

    // Everywhere else the proxy ball path is already continuous; reuse it.
    const idx = clamp(tickIndex(tMs), 0, tickCount - 1);
    return {
      x: proxyBallPath[idx * 3]!,
      y: proxyBallPath[idx * 3 + 1]!,
      z: proxyBallPath[idx * 3 + 2]!,
    };
  };

  for (const t of frameTimes) {
    for (const p of players) {
      sampleAt(t, p.profile.entityId, recordedPlayerPos(p.profile.entityId, t), 0);
    }
    const ballPos = derivedBall(t);
    sampleAt(t, 'ball', ballPos, ballPos.z);
  }

  // ---------------- events ----------------
  const events: MatchEvent[] = beats.map((beat, index) => ({
    schemaVersion: '1.0',
    eventId: beat.eventId,
    providerId: PROVIDER_ID,
    tenantId: TENANT_ID,
    matchId: DEFAULT_MATCH_ID,
    fixtureSeed: seed,
    sourceRevision: 1,
    kind: beat.kind as MatchEvent['kind'],
    occurredAtMs: beat.atMs,
    ingestedAt: ingestedAt(beat.atMs),
    sequence: index + 1,
    actorId: beat.entityId,
    teamId: beat.teamId,
    position: eventPositions.get(beat.eventId),
    attributes: beat.attributes,
    provenance: {
      origin: 'synthetic_ground_truth',
      generatorVersion: SIMULATOR_VERSION,
      licenseRef: 'synthetic-internal',
      confidence: 1,
    },
    correctionOf: null,
  }));

  // ---------------- derived golden metrics (from emitted samples) ----------------
  const golden = deriveGoldenMetrics();

  const metadata: FixtureMetadata = {
    matchId: DEFAULT_MATCH_ID,
    seed,
    generatorVersion: SIMULATOR_VERSION,
    narrative: 'The Invisible Assist — decoy run, opened lane, threaded pass, equalizer (docs/15)',
    pitch: {
      lengthM: pitchLength,
      widthM: pitchWidth,
      coordinateSystem: 'pitch-meters-center-origin-v1',
    },
    attackDirectionsPerHalf: {
      first: { home: '-x', away: '+x' },
      second: { home: '+x', away: '-x' },
    },
    sampling: {
      goldenHz,
      backgroundHz,
      goldenWindowMs: [goldenStart, goldenEnd],
      contextBeforeMs: contextBefore,
      contextAfterMs: contextAfter,
      emittedFromMs: frameTimes[0] ?? 0,
      emittedToMs: frameTimes[frameTimes.length - 1] ?? 0,
      frameCount: frameTimes.length,
      sampleCount: samples.length,
    },
    eventCount: events.length,
    goldenCheckpointMs: GOLDEN_CHECKPOINT_MS,
    scoreTimeline: [
      { atMs: 0, score: '0-0' },
      { atMs: AWAY_GOAL_SEQ.goalMs, score: '0-1' },
      { atMs: GOLDEN_GOAL_MS, score: '1-1' },
    ],
    golden,
    notes: [
      'Simplified football: bounded speed/acceleration steering, scripted narrative beats; not a physics-accurate simulation.',
      'Background possession transitions are movement-coherent but not event-logged; only listed events are canonical.',
      `Full-time event at ${FULL_TIME_BEAT.atMs} ms intentionally has no tracking frames: absent data is explicit absence.`,
      'Frame ids follow frame-<sampleTimeMs/100>; every event time is on the tick grid, so each event has an exact frame.',
      'Two-pass derivation: the ball rides recorded player tracks, so ball/actor agreement at event timestamps is exact.',
    ],
  };

  return { events, tracking: samples, metadata };

  function nearestFrame(tMs: number): number {
    let best = frameTimes[0] ?? 0;
    let bestDelta = Infinity;
    for (const f of frameTimes) {
      const delta = Math.abs(f - tMs);
      if (delta < bestDelta) {
        bestDelta = delta;
        best = f;
      }
    }
    return best;
  }

  function sampleOf(tMs: number, entityId: string): TrackingSample | undefined {
    return samples.find((s) => s.sampleTimeMs === tMs && s.entityId === entityId);
  }

  function deriveGoldenMetrics(): GoldenMetrics {
    const runStartFrame = nearestFrame(4720500);
    const runEndFrame = nearestFrame(4724000);
    const defenderStart = sampleOf(runStartFrame, GOLDEN_ACTORS.drawnDefender);
    const strikerStart = sampleOf(runStartFrame, GOLDEN_ACTORS.scorer);
    const defenderEnd = sampleOf(runEndFrame, GOLDEN_ACTORS.drawnDefender);
    const strikerEnd = sampleOf(runEndFrame, GOLDEN_ACTORS.scorer);
    if (!defenderStart || !strikerStart || !defenderEnd || !strikerEnd) {
      throw new Error('golden frames missing for metric derivation');
    }
    const before = Math.hypot(
      defenderStart.xM - strikerStart.xM,
      defenderStart.yM - strikerStart.yM,
    );
    const after = Math.hypot(defenderEnd.xM - strikerEnd.xM, defenderEnd.yM - strikerEnd.yM);

    let wingerTop = 0;
    let prev: TrackingSample | undefined;
    for (const s of samples) {
      if (s.entityId !== GOLDEN_ACTORS.winger) continue;
      if (s.sampleTimeMs < 4720500 || s.sampleTimeMs > 4724000) continue;
      if (prev) {
        const dtS = (s.sampleTimeMs - prev.sampleTimeMs) / 1000;
        const v = Math.hypot(s.xM - prev.xM, s.yM - prev.yM) / dtS;
        if (v > wingerTop) wingerTop = v;
      }
      prev = s;
    }

    const pass = GOLDEN_FLIGHTS[0]!;
    const passFrom = recordedPlayerPos(GOLDEN_ACTORS.passer, pass.fromMs);
    const passTo = recordedPlayerPos(GOLDEN_ACTORS.scorer, pass.toMs);
    const passDistance = Math.hypot(passTo.x - passFrom.x, passTo.y - passFrom.y);
    const shot = GOLDEN_FLIGHTS[1]!;
    const shotFrom = recordedPlayerPos(GOLDEN_ACTORS.scorer, shot.fromMs);
    const shotDistance = Math.hypot(
      AWAY_GOAL_SEQ.goalTarget[0] - shotFrom.x,
      AWAY_GOAL_SEQ.goalTarget[1] - shotFrom.y,
    );

    return {
      checkpointMs: GOLDEN_CHECKPOINT_MS,
      decoyRun: {
        winger: GOLDEN_ACTORS.winger,
        drawnDefender: GOLDEN_ACTORS.drawnDefender,
        striker: GOLDEN_ACTORS.scorer,
        fromMs: 4720500,
        toMs: 4724000,
        separationBeforeM: round3(before),
        separationAfterM: round3(after),
        separationDeltaM: round3(after - before),
        wingerTopSpeedMps: round3(wingerTop),
      },
      pass: {
        from: GOLDEN_ACTORS.passer,
        to: GOLDEN_ACTORS.scorer,
        attemptedMs: pass.fromMs,
        completedMs: pass.toMs,
        distanceM: round3(passDistance),
        speedMps: round3(passDistance / ((pass.toMs - pass.fromMs) / 1000)),
      },
      shot: {
        by: GOLDEN_ACTORS.scorer,
        atMs: shot.fromMs,
        goalMs: GOLDEN_GOAL_MS,
        distanceM: round3(shotDistance),
        speedMps: round3(shotDistance / ((shot.toMs - shot.fromMs) / 1000)),
      },
    };
  }
}

/** ISO helper exported for CLI/metadata consumers needing audit timestamps. */
export function auditTimestamp(ms: number): string {
  return new Date(ms).toISOString().replace('.000Z', 'Z');
}
