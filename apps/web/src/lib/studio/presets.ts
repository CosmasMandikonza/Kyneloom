import type { CameraTrack } from '@kyneloom/contracts';
import type { SceneData } from '@/lib/scene-data';
import { sceneTimeline } from '@/lib/scene-client';
import { createFrameCache } from '@/app/explore/scene/scene-context';

/**
 * KYN-17 — deterministic shot presets (docs/06 camera grammar).
 *
 * A preset is a TYPED `CameraTrack` generator — never a new camera driver.
 * The renderer plays these through the existing directed rig (Catmull-Rom
 * through the authored knots), so switching a shot is an ordinary draft edit
 * that recompiles through the same compiler as everything else.
 *
 * Every preset grounds its geometry in one of two honest sources:
 * 1. AUTHORED cinematic poses (overhead establishing shot, the hero directed
 *    ride and the broadcast sweep — the same geometry as the KYN-16 corpus
 *    cuts, mirrored here with attribution because the corpus is compiler
 *    package-internal);
 * 2. THE TRUSTED MATCH STATE ITSELF — the winger-follow shot samples the
 *    entity's real accepted positions/headings through the SAME shared
 *    timeline sampler the stage renders from (`createTimeline`, one
 *    implementation in the repo). Baking live follow geometry into keyframes
 *    is deterministic, representable in the typed proposal, and never
 *    invents football truth — it photographs it.
 *
 * All coordinates are pitch meters, z up; all times are integer offsets from
 * the moment start (the manifest clock law).
 */

const FOLLOW_ENTITY_ID = 'home-11'; // the decoy winger — the fixture's protagonist run

/** Deterministic rounding: stable across machines, readable in the inspector. */
function m(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/** Static overhead tactical establishing shot (mirrors the Explore overhead rig pose). */
export function overheadTactical(windowMs: number): CameraTrack {
  const pose = {
    position: [0, -0.001, 92] as [number, number, number],
    target: [0, 0, 0] as [number, number, number],
    fovDeg: 46,
  };
  return {
    id: 'cam-overhead-tactical',
    mode: 'directed',
    startMs: 0,
    endMs: windowMs,
    keyframes: [
      { tMs: 0, ...pose },
      { tMs: windowMs, ...pose },
    ],
  };
}

/**
 * The hero cinematic ride (mirrors `heroCameraTrack` in
 * packages/moment-compiler/src/corpus.ts — the golden proposal's own shot).
 */
export function directedRide(windowMs: number): CameraTrack {
  return {
    id: 'cam-directed-ride',
    mode: 'directed',
    startMs: 0,
    endMs: windowMs,
    keyframes: [
      { tMs: 0, position: [-18, -30, 26], target: [10, -6, 0], fovDeg: 46 },
      {
        tMs: Math.round(windowMs * 0.28),
        position: [-4, -22, 17],
        target: [14, -8, 1],
        fovDeg: 42,
      },
      {
        tMs: Math.round(windowMs * 0.55),
        position: [8, -12, 12],
        target: [22, -6, 1],
        fovDeg: 40,
      },
      {
        tMs: Math.round(windowMs * 0.78),
        position: [28, -22, 12],
        target: [42, -8, 1],
        fovDeg: 38,
      },
      { tMs: windowMs, position: [38, -30, 15], target: [46, -5, 1.2], fovDeg: 44 },
    ],
  };
}

/** High wide broadcast sweep (mirrors `sweepCameraTrack` in the corpus). */
export function broadcastSweep(windowMs: number): CameraTrack {
  return {
    id: 'cam-broadcast-sweep',
    mode: 'directed',
    startMs: 0,
    endMs: windowMs,
    keyframes: [
      { tMs: 0, position: [-40, -18, 30], target: [4, -4, 0], fovDeg: 44 },
      {
        tMs: Math.round(windowMs * 0.5),
        position: [0, -26, 34],
        target: [18, -6, 0],
        fovDeg: 40,
      },
      { tMs: windowMs, position: [30, -34, 28], target: [44, -6, 0], fovDeg: 42 },
    ],
  };
}

/**
 * Winger-follow shot baked from the entity's REAL accepted samples: at a ~1 s
 * cadence the camera sits 7.2 m behind the run (along the sampled heading)
 * and looks 6 m ahead of it, 4.4 m up — the same geometry the live Follow
 * rig uses, authored as typed keyframes. Returns null (fail closed) when the
 * entity has no sampled positions — a follow shot is never fabricated.
 */
export function wingerFollow(
  scene: SceneData,
  windowMs: number,
  startAbsMs: number,
  entityId: string = FOLLOW_ENTITY_ID,
): CameraTrack | null {
  const timeline = sceneTimeline(scene);
  const getFrame = createFrameCache(timeline, scene.ballEntityId);
  const cadenceMs = 1000;
  const times: number[] = [];
  for (let t = 0; t <= windowMs; t += cadenceMs) times.push(t);
  if (times[times.length - 1] !== windowMs) times.push(windowMs);

  let heading = 0; // canonical +x attack; updated whenever the run moves
  const keyframes: CameraTrack['keyframes'] = [];
  for (const offset of times) {
    const frame = getFrame(startAbsMs + offset);
    const sample = frame.positions.get(entityId);
    if (sample === undefined) continue; // untracked instant: no keyframe invented
    const sampledHeading = frame.headingsRad.get(entityId);
    if (sampledHeading !== undefined) heading = sampledHeading;
    keyframes.push({
      tMs: offset,
      position: m3(sample.xM - Math.cos(heading) * 7.2, sample.yM - Math.sin(heading) * 7.2, 4.4),
      target: m3(sample.xM + Math.cos(heading) * 6, sample.yM + Math.sin(heading) * 6, 1.3),
      fovDeg: 44,
    });
  }
  if (keyframes.length < 2) return null;
  return {
    id: 'cam-winger-follow',
    mode: 'directed',
    startMs: 0,
    endMs: windowMs,
    keyframes,
  };
}

function m3(x: number, y: number, z: number): [number, number, number] {
  return [m(x), m(y), m(z)];
}

export interface ShotPresetCard {
  readonly id: string;
  readonly label: string;
  readonly description: string;
}

/** The preset registry the inspector offers (labels are UI copy, ids are stable). */
export const SHOT_PRESETS: readonly ShotPresetCard[] = [
  {
    id: 'cam-overhead-tactical',
    label: 'Overhead tactical',
    description: 'Static top-down establishing shot of the whole pitch.',
  },
  {
    id: 'cam-directed-ride',
    label: 'Directed ride',
    description: 'The hero pitch-level cinematic ride (the golden cut).',
  },
  {
    id: 'cam-winger-follow',
    label: 'Winger follow',
    description: 'Chase camera baked from the decoy run’s real samples.',
  },
  {
    id: 'cam-broadcast-sweep',
    label: 'Broadcast sweep',
    description: 'High wide sweep across the action (the sweep cut).',
  },
] as const;

/** Build a preset by id against this scene/moment; null when it cannot be grounded. */
export function buildShotPreset(
  presetId: string,
  scene: SceneData,
  windowMs: number,
  startAbsMs: number,
): CameraTrack | null {
  switch (presetId) {
    case 'cam-overhead-tactical':
      return overheadTactical(windowMs);
    case 'cam-directed-ride':
      return directedRide(windowMs);
    case 'cam-broadcast-sweep':
      return broadcastSweep(windowMs);
    case 'cam-winger-follow':
      return wingerFollow(scene, windowMs, startAbsMs);
    default:
      return null;
  }
}
