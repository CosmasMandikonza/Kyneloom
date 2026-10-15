import {
  parseMomentManifest,
  pitchToThree,
  type CameraKeyframe,
  type CameraTrack,
  type ContractValidationError,
  type MomentManifest,
  type ThreeVec3,
} from '@kyneloom/contracts';

/**
 * Contract consumption seam for the future R3F renderer (KYN-06/KYN-07):
 * frontend code parses the canonical manifest and converts camera geometry
 * through the single shared pitch→Three transform. No axis is ever swapped
 * locally (docs/08), and manifest-relative time offsets are preserved
 * verbatim — the playhead owner applies them.
 */

export interface ThreeCameraKeyframe {
  /** Offset from moment start, milliseconds — unchanged from the manifest. */
  readonly tMs: number;
  readonly position: ThreeVec3;
  readonly target: ThreeVec3;
  readonly fovDeg: number;
}

export interface ThreeCameraTrack {
  readonly id: string;
  readonly mode: CameraTrack['mode'];
  readonly startMs: number;
  readonly endMs: number;
  readonly keyframes: readonly ThreeCameraKeyframe[];
}

function keyframeToThree(kf: CameraKeyframe): ThreeCameraKeyframe {
  return {
    tMs: kf.tMs,
    position: pitchToThree(kf.position),
    target: pitchToThree(kf.target),
    fovDeg: kf.fovDeg,
  };
}

/** Convert one validated camera track into Three.js world space. */
export function cameraTrackToThree(track: CameraTrack): ThreeCameraTrack {
  return {
    id: track.id,
    mode: track.mode,
    startMs: track.startMs,
    endMs: track.endMs,
    keyframes: track.keyframes.map(keyframeToThree),
  };
}

/**
 * Parse a manifest document and convert every camera track to Three space in
 * one step — the shape the future <CameraRig> will subscribe to. Returns
 * contract errors verbatim on invalid input.
 */
export function parseManifestCameras(
  input: unknown,
):
  | { ok: true; manifest: MomentManifest; tracks: readonly ThreeCameraTrack[] }
  | { ok: false; errors: ContractValidationError[] } {
  const result = parseMomentManifest(input);
  if (!result.ok) {
    return { ok: false, errors: result.errors };
  }
  return {
    ok: true,
    manifest: result.data,
    tracks: result.data.scene.cameraTracks.map(cameraTrackToThree),
  };
}
