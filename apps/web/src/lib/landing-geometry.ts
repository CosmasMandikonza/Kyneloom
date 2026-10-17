/**
 * KYN-09 — deterministic fragment-field geometry for the orb→pitch morph.
 *
 * Every fragment flies from the orb's screen-space epicenter to a REAL
 * target: the IFAB pitch outline, the halfway line and centre circle, the
 * measured trajectories of the three story actors (defender away-03,
 * striker home-09, decoy runner home-11 — the same entities Evidence X-Ray
 * measures), or the 22 checkpoint player positions themselves. Targets are
 * defined in canonical pitch meters and converted through the ONE shared
 * `pitchToThree` transform — the landing can never imply geometry the real
 * scene does not have (Issue #9: "fragment targets defined mathematically,
 * deterministic transitions").
 *
 * Determinism: a seeded mulberry32 PRNG (fixed seed) drives jitter, delays
 * and sizes, so the same fixture always produces byte-identical fields —
 * asserted by tests.
 */

import { pitchToThree } from '@kyneloom/contracts';
import { createPitchDimensions } from '@kyneloom/match-core';

const PITCH = createPitchDimensions();
const HALF_LENGTH = PITCH.lengthM / 2; // 52.5
const HALF_WIDTH = PITCH.widthM / 2; // 34
const CENTRE_CIRCLE_RADIUS_M = 9.15;

/**
 * Device-tuned fragment budget (review gate 4): narrow screens AND coarse
 * pointers both drop to the mobile budget, so a desktop-pointer emulation
 * at phone width (the QA case that produced 900 fragments at 375×812) can
 * never reach the desktop particle count. Pure + unit-tested.
 */
export function fragmentBudget(viewportWidthPx: number, coarsePointer: boolean): number {
  if (coarsePointer || viewportWidthPx < 480) return 320;
  if (viewportWidthPx < 1024) return 600;
  return 900;
}

/** mulberry32 — tiny deterministic PRNG (no dependency). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type Vec3 = readonly [number, number, number];

export interface TrajectoryRole {
  readonly entityId: string;
  /** 'measured' = mint (the separation story), 'runner' = amber (hypothesis). */
  readonly role: 'measured' | 'runner';
  /** Pitch-meter polyline inside the golden window, downsampled. */
  readonly pointsM: readonly { xM: number; yM: number }[];
}

export interface LandingFieldInput {
  /** Checkpoint player poses in pitch meters (22 + optionally the ball). */
  readonly checkpointPlayers: readonly { entityId: string; xM: number; yM: number }[];
  readonly checkpointBall: { xM: number; yM: number } | null;
  /** Story trajectories from the accepted tracking inside the window. */
  readonly trajectories: readonly TrajectoryRole[];
  /** Fragment count (device budget). */
  readonly fragmentCount: number;
  /** PRNG seed — fixed for production determinism. */
  readonly seed: number;
}

export interface FragmentSeed {
  /** Start position in three-space (on the orb's world-space epicenter shell). */
  readonly origin: Vec3;
  /** Real pitch target in three-space (y-up world). */
  readonly target: Vec3;
  /** Quadratic-bezier control point — arcs the flight over the pitch. */
  readonly control: Vec3;
  readonly delayMs: number;
  readonly durationMs: number;
  /** Linear-RGB tint; roles map to mint / amber / quiet line tones. */
  readonly color: readonly [number, number, number];
  readonly sizeM: number;
}

export interface LandingFieldSpec {
  readonly fragments: readonly FragmentSeed[];
  /** Pitch outline loop in three-space (for the reveal line work). */
  readonly pitchOutline: readonly Vec3[];
  /** Halfway line + centre circle sampled points. */
  readonly halfwayLine: readonly Vec3[];
  readonly centreCircle: readonly Vec3[];
  /** Story trajectories in three-space with their display role. */
  readonly trajectories: readonly {
    entityId: string;
    role: 'measured' | 'runner';
    points: readonly Vec3[];
  }[];
  /** Checkpoint markers (players + ball) in three-space. */
  readonly checkpointMarkers: readonly { entityId: string; position: Vec3 }[];
}

// Brand tones as linear-ish RGB (materials use these directly).
const MINT: readonly [number, number, number] = [0.318, 0.843, 0.741]; // #51D7BD
const MINT_SOFT: readonly [number, number, number] = [0.62, 0.92, 0.84];
const AMBER: readonly [number, number, number] = [0.965, 0.729, 0.467]; // #F6BA77
const LINE_TONE: readonly [number, number, number] = [0.4, 0.55, 0.58];

/** The orb's world-space epicenter the fragments erupt from (matches the
 * composed right-of-center orb anchor; see orb-field uCenter). */
const EPICENTER: Vec3 = [11, 8, 30];
const EPICENTER_RADIUS_M = 7.5;

export function buildLandingField(input: LandingFieldInput): LandingFieldSpec {
  const rng = mulberry32(input.seed);

  // ---- Real target sets, all through pitchToThree ----------------------
  const outline: Vec3[] = [];
  const corners: readonly (readonly [number, number])[] = [
    [-HALF_LENGTH, -HALF_WIDTH],
    [HALF_LENGTH, -HALF_WIDTH],
    [HALF_LENGTH, HALF_WIDTH],
    [-HALF_LENGTH, HALF_WIDTH],
  ];
  for (let i = 0; i < 4; i += 1) {
    const a = corners[i]!;
    const b = corners[(i + 1) % 4]!;
    const steps = 14;
    for (let s = 0; s < steps; s += 1) {
      const t = s / steps;
      const [x, , z] = pitchToThree({
        xM: a[0] + (b[0] - a[0]) * t,
        yM: a[1] + (b[1] - a[1]) * t,
        zM: 0,
      });
      outline.push([x, 0, z]);
    }
  }

  const halfwayLine: Vec3[] = [];
  for (let s = 0; s <= 12; s += 1) {
    const t = s / 12;
    const [x, , z] = pitchToThree({ xM: 0, yM: -HALF_WIDTH + PITCH.widthM * t, zM: 0 });
    halfwayLine.push([x, 0, z]);
  }

  const centreCircle: Vec3[] = [];
  for (let s = 0; s <= 40; s += 1) {
    const angle = (s / 40) * Math.PI * 2;
    const [x, , z] = pitchToThree({
      xM: Math.cos(angle) * CENTRE_CIRCLE_RADIUS_M,
      yM: Math.sin(angle) * CENTRE_CIRCLE_RADIUS_M,
      zM: 0,
    });
    centreCircle.push([x, 0, z]);
  }

  const trajectories = input.trajectories.map((trajectory) => ({
    entityId: trajectory.entityId,
    role: trajectory.role,
    points: trajectory.pointsM.map((p) => {
      const [x, , z] = pitchToThree({ xM: p.xM, yM: p.yM, zM: 0.06 });
      return [x, 0.06, z] as Vec3;
    }),
  }));

  const checkpointMarkers = [
    ...input.checkpointPlayers.map((player) => {
      const [x, , z] = pitchToThree({ xM: player.xM, yM: player.yM, zM: 0 });
      return { entityId: player.entityId, position: [x, 0.05, z] as Vec3 };
    }),
    ...(input.checkpointBall !== null
      ? [
          (() => {
            const [x, , z] = pitchToThree({
              xM: input.checkpointBall.xM,
              yM: input.checkpointBall.yM,
              zM: 0,
            });
            return { entityId: 'ball', position: [x, 0.05, z] as Vec3 };
          })(),
        ]
      : []),
  ];

  // ---- Fragment assignment --------------------------------------------
  // Weighted target pools: outline is the armature, markings tighten it,
  // trajectories carry the story, checkpoint markers seed the players.
  interface Pool {
    pick(): Vec3;
    color: readonly [number, number, number];
    sizeM: [number, number];
  }
  const pickFrom = (points: readonly Vec3[]): (() => Vec3) => {
    return () => points[Math.floor(rng() * points.length)] ?? points[0]!;
  };
  const runnerPoints: Vec3[] = [
    ...trajectories.filter((t) => t.role === 'runner').flatMap((t) => t.points),
  ];
  const measuredPoints: Vec3[] = [
    ...trajectories.filter((t) => t.role === 'measured').flatMap((t) => t.points),
  ];
  const markerPoints: Vec3[] = checkpointMarkers.map((m) => m.position);

  const pools: readonly { weight: number; pool: Pool }[] = [
    {
      weight: 0.42,
      pool: { pick: pickFrom(outline), color: MINT, sizeM: [0.4, 0.7] },
    },
    {
      weight: 0.16,
      pool: {
        pick: () =>
          rng() < 0.45
            ? (halfwayLine[Math.floor(rng() * halfwayLine.length)] ?? halfwayLine[0]!)
            : (centreCircle[Math.floor(rng() * centreCircle.length)] ?? centreCircle[0]!),
        color: MINT_SOFT,
        sizeM: [0.3, 0.55],
      },
    },
    {
      weight: 0.2,
      pool: {
        pick: () =>
          measuredPoints.length > 0
            ? (measuredPoints[Math.floor(rng() * measuredPoints.length)] ?? measuredPoints[0]!)
            : (outline[Math.floor(rng() * outline.length)] ?? outline[0]!),
        color: MINT_SOFT,
        sizeM: [0.26, 0.48],
      },
    },
    {
      weight: 0.12,
      pool: {
        pick: () =>
          runnerPoints.length > 0
            ? (runnerPoints[Math.floor(rng() * runnerPoints.length)] ?? runnerPoints[0]!)
            : (outline[Math.floor(rng() * outline.length)] ?? outline[0]!),
        color: AMBER,
        sizeM: [0.3, 0.52],
      },
    },
    {
      weight: 0.1,
      pool: {
        pick: () =>
          markerPoints.length > 0
            ? (markerPoints[Math.floor(rng() * markerPoints.length)] ?? markerPoints[0]!)
            : (outline[Math.floor(rng() * outline.length)] ?? outline[0]!),
        color: LINE_TONE,
        sizeM: [0.32, 0.58],
      },
    },
  ];

  const fragments: FragmentSeed[] = [];
  for (let i = 0; i < input.fragmentCount; i += 1) {
    // Deterministic sphere-shell origin (golden-angle spiral + jitter).
    const phi = Math.acos(1 - 2 * ((i + 0.5) / input.fragmentCount));
    const theta = Math.PI * (1 + Math.sqrt(5)) * i;
    const shellR = EPICENTER_RADIUS_M * (0.55 + rng() * 0.45);
    const origin: Vec3 = [
      EPICENTER[0] + Math.sin(phi) * Math.cos(theta) * shellR,
      EPICENTER[1] + Math.cos(phi) * shellR * 0.7,
      EPICENTER[2] + Math.sin(phi) * Math.sin(theta) * shellR * 0.6,
    ];

    const roll = rng();
    let acc = 0;
    let chosen = pools[0]!.pool;
    for (const { weight, pool } of pools) {
      acc += weight;
      if (roll <= acc) {
        chosen = pool;
        break;
      }
    }
    const target = chosen.pick();
    const color: readonly [number, number, number] = [
      Math.min(1, chosen.color[0] * (0.85 + rng() * 0.3)),
      Math.min(1, chosen.color[1] * (0.85 + rng() * 0.3)),
      Math.min(1, chosen.color[2] * (0.85 + rng() * 0.3)),
    ];

    // Arc control point: over the pitch, biased along the flight.
    const control: Vec3 = [
      (origin[0] + target[0]) / 2 + (rng() - 0.5) * 22,
      10 + rng() * 26,
      (origin[2] + target[2]) / 2 + (rng() - 0.5) * 16,
    ];

    fragments.push({
      origin,
      target,
      control,
      delayMs: Math.floor(rng() * 420),
      durationMs: 900 + Math.floor(rng() * 800),
      color,
      sizeM: chosen.sizeM[0] + rng() * (chosen.sizeM[1] - chosen.sizeM[0]),
    });
  }

  return {
    fragments,
    pitchOutline: outline,
    halfwayLine,
    centreCircle,
    trajectories,
    checkpointMarkers,
  };
}
