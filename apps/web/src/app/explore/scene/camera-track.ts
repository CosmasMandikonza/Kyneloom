import * as THREE from 'three';
import type { ThreeCameraTrack } from '@kyneloom/scene-renderer';

/**
 * Manifest-directed camera playback (KYN-07, docs/06 + docs/08).
 *
 * CLOCK LAW — converted exactly once: the manifest and `ThreeCameraTrack`
 * keep camera times as OFFSETS from the start of the moment window
 * (`timeRangeMs[0]`, the same axis law as every scene offset). This module
 * converts each offset to an absolute match-relative millisecond exactly
 * once, in `toAbsoluteTrack`; everything downstream (rig sampling, QA
 * assertions) works purely on the absolute match clock — the same clock as
 * `playheadMs`, events and tracking samples. Mixing the two axes is a
 * category error the contract itself rejects.
 *
 * SPACE: keyframe positions/targets arrive already converted to Three space
 * through the one shared `pitchToThree` (inside `cameraTrackToThree`); this
 * module never re-swaps axes.
 *
 * TRUTH: invalid or unusable tracks are REJECTED (`isUsableTrack`), never
 * repaired into fabricated camera poses. Sampling is a pure, deterministic
 * function of (track, playhead): keyframes land exactly on their authored
 * poses, and between them the camera follows a Catmull-Rom spline through
 * the authored positions/targets (the smooth C1 path Issue #7 asks for —
 * exact at knots by construction, deterministic everywhere).
 */

export interface AbsoluteCameraKeyframe {
  /** Absolute match-relative ms (offset + window start). */
  readonly absMs: number;
  readonly position: THREE.Vector3;
  readonly target: THREE.Vector3;
  readonly fovDeg: number;
}

export interface AbsoluteCameraTrack {
  readonly id: string;
  readonly startAbsMs: number;
  readonly endAbsMs: number;
  readonly keyframes: readonly AbsoluteCameraKeyframe[];
  /** Catmull-Rom through the authored positions (and targets). */
  readonly positionCurve: THREE.CatmullRomCurve3;
  readonly targetCurve: THREE.CatmullRomCurve3;
}

export const CAMERA_FOV_LIMITS = { min: 20, max: 120 } as const;

/**
 * Runtime usability gate. `parseManifestCameras` already enforces all of
 * this contract-side; this guard exists so a corrupted/hand-edited payload
 * that somehow reaches the rig is disabled rather than rendered as
 * fabricated camera geometry.
 */
export function isUsableTrack(track: ThreeCameraTrack): boolean {
  const kfs = track.keyframes;
  if (kfs === undefined || kfs.length < 2) return false;
  if (!Number.isFinite(track.startMs) || !Number.isFinite(track.endMs)) return false;
  if (track.endMs < track.startMs) return false;
  let previousT = Number.NEGATIVE_INFINITY;
  for (const kf of kfs) {
    if (!Number.isFinite(kf.tMs) || kf.tMs <= previousT) return false;
    previousT = kf.tMs;
    if (kf.position.some((v) => !Number.isFinite(v))) return false;
    if (kf.target.some((v) => !Number.isFinite(v))) return false;
    if (!Number.isFinite(kf.fovDeg)) return false;
    if (kf.fovDeg < CAMERA_FOV_LIMITS.min || kf.fovDeg > CAMERA_FOV_LIMITS.max) return false;
    // pitchToThree puts height on index 1; a camera below the plane is
    // unusable (the contract floor is 0.5 m in pitch space).
    if (kf.position[1] < 0.5 || kf.target[1] < 0) return false;
  }
  return true;
}

/** Convert a validated track's offset clock to the absolute match clock. */
export function toAbsoluteTrack(
  track: ThreeCameraTrack,
  windowStartMs: number,
): AbsoluteCameraTrack {
  const keyframes: AbsoluteCameraKeyframe[] = track.keyframes.map((kf) => ({
    absMs: windowStartMs + kf.tMs,
    position: new THREE.Vector3(...kf.position),
    target: new THREE.Vector3(...kf.target),
    fovDeg: kf.fovDeg,
  }));
  return {
    id: track.id,
    startAbsMs: windowStartMs + track.startMs,
    endAbsMs: windowStartMs + track.endMs,
    keyframes,
    positionCurve: new THREE.CatmullRomCurve3(
      keyframes.map((kf) => kf.position),
      false,
      'catmullrom',
      0.5,
    ),
    targetCurve: new THREE.CatmullRomCurve3(
      keyframes.map((kf) => kf.target),
      false,
      'catmullrom',
      0.5,
    ),
  };
}

export interface SampledCameraPose {
  readonly position: THREE.Vector3;
  readonly target: THREE.Vector3;
  readonly fovDeg: number;
}

/**
 * Deterministic track sample at an ABSOLUTE match time. Outside the track's
 * interval the nearest end pose is held (no extrapolation, no invention).
 * At a keyframe time the authored pose is returned exactly; between
 * keyframes the Catmull-Rom parameter maps linearly across knot indices
 * (authored knots are hit exactly; interior pacing follows the spline).
 */
export function sampleCameraTrack(
  track: AbsoluteCameraTrack,
  playheadMs: number,
): SampledCameraPose {
  const kfs = track.keyframes;
  const first = kfs[0]!;
  const last = kfs[kfs.length - 1]!;
  if (playheadMs <= first.absMs)
    return { position: first.position.clone(), target: first.target.clone(), fovDeg: first.fovDeg };
  if (playheadMs >= last.absMs)
    return { position: last.position.clone(), target: last.target.clone(), fovDeg: last.fovDeg };

  let index = 0;
  for (let i = 0; i < kfs.length - 1; i += 1) {
    if (playheadMs >= kfs[i]!.absMs && playheadMs <= kfs[i + 1]!.absMs) {
      index = i;
      break;
    }
  }
  const a = kfs[index]!;
  const b = kfs[index + 1]!;
  const u = (playheadMs - a.absMs) / (b.absMs - a.absMs);
  // Global curve parameter: knot i sits exactly at i/(n-1).
  const g = (index + u) / (kfs.length - 1);
  const position = track.positionCurve.getPoint(g, new THREE.Vector3());
  const target = track.targetCurve.getPoint(g, new THREE.Vector3());
  const fovDeg = a.fovDeg + (b.fovDeg - a.fovDeg) * u;
  return { position, target, fovDeg };
}
