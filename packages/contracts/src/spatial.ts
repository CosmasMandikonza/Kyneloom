import { z } from 'zod';

/**
 * Canonical spatial vocabulary (docs/05, docs/08).
 *
 * ALL Kyneloom spatial data — tracking samples, match state, and every
 * position/target inside a MomentManifest — lives in **pitch meters**:
 * origin at pitch center, +x towards the designated attacking right goal,
 * +y towards the upper touchline, +z vertically up. Three.js conversion
 * happens in exactly one place: {@link pitchToThree} below. Nothing else in
 * any package may swap axes independently.
 */

export const PITCH_COORDINATE_SYSTEM = 'pitch-meters-center-origin-v1' as const;

export type PitchCoordinateSystem = typeof PITCH_COORDINATE_SYSTEM;

/** Ground-plane position in pitch meters (events carry 2D positions). */
export const vec2M = z
  .strictObject({
    xM: z.number(),
    yM: z.number(),
  })
  .describe('pitch meters, center origin, +x attacking right, +y upper touchline');

export type Vec2M = z.infer<typeof vec2M>;

/** Full 3D position in pitch meters, +z up. */
export const vec3M = z
  .strictObject({
    xM: z.number(),
    yM: z.number(),
    zM: z.number(),
  })
  .describe('pitch meters, center origin, +z up');

export type Vec3M = z.infer<typeof vec3M>;

/** Tuple form used by manifest camera keyframes (pitch meters, z up). */
export const vec3TupleM = z
  .tuple([z.number(), z.number(), z.number()])
  .describe('[x, y, z] pitch meters, z up — converted to Three.js space only via pitchToThree');
export type Vec3TupleM = z.infer<typeof vec3TupleM>;

/** A position in Three.js world space: x right, y up, z towards the viewer. */
export type ThreeVec3 = readonly [number, number, number];

/**
 * The single source-to-Three.js transform (docs/08): Three.js is y-up while
 * canonical pitch space is z-up, so (x, y, z)_pitch → (x, z, -y)_three.
 * Hand-checkable example: the right-goal corner flag at pitch (52.5, 34, 0)
 * maps to Three.js (52.5, 0, -34); a ball two meters above center maps to
 * (0, 2, 0).
 */
export function pitchToThree(p: Vec3M | Vec3TupleM): ThreeVec3 {
  const [x, y, z] = Array.isArray(p) ? p : [p.xM, p.yM, p.zM];
  // `+ 0` normalizes negative zero so round-trips are representation-stable.
  return [x, z, -y + 0];
}

/** Inverse of {@link pitchToThree}; used by editor picking, never by replay truth. */
export function threeToPitch(t: ThreeVec3): Vec3TupleM {
  const [x, y, z] = t;
  // three (x, y_up, z_depth) → pitch (x, y_width, z_up): pitch.y = -three.z, pitch.z = three.y.
  return [x, -z + 0, y];
}

/**
 * Safe bounds used across contracts: coordinates beyond this radius from the
 * origin are rejected outright (a camera may be outside the pitch, but not
 * kilometers away).
 */
export const MAX_ABS_COORDINATE_M = 500;
