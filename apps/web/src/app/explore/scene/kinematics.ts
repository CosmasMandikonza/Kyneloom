/**
 * Pure playhead-domain kinematics (KYN-06 review fixes).
 *
 * Everything here is a PURE function of the scene's own sample arrays and
 * the query time — no render history, no accumulation, no per-frame state.
 * Calling any function twice with the same playhead always yields the same
 * answer regardless of how many frames were drawn, paused or seeked in
 * between. The 3D actors use these lookups so their presentation state is
 * deterministic under pause/scrub/replay by construction.
 */

export interface TrajectorySource {
  readonly t: readonly number[];
  readonly xyz: readonly number[];
}

export interface EntityTrajectory {
  readonly entityId: string;
  /** Ascending sample times (verbatim from the scene payload). */
  readonly times: readonly number[];
  /** Cumulative ground-path length in meters through sample i. */
  readonly cumulativeM: readonly number[];
  /**
   * Motion direction in canonical pitch radians (atan2(dy, dx)) of the
   * segment ENDING at sample i; NaN when the segment is stationary or i=0.
   */
  readonly headingsRad: readonly number[];
}

const STATIONARY_EPSILON_M2 = 1e-8;

export function buildTrajectory(entityId: string, track: TrajectorySource): EntityTrajectory {
  const count = track.t.length;
  const cumulativeM = new Array<number>(count);
  const headingsRad = new Array<number>(count);
  let total = 0;
  cumulativeM[0] = 0;
  headingsRad[0] = Number.NaN;
  for (let i = 1; i < count; i += 1) {
    // scene-client validation guarantees xyz.length === 3 × t.length, so the
    // non-null assertions cannot fabricate coordinates — they satisfy the
    // compiler's index-access check only.
    const dx = track.xyz[i * 3]! - track.xyz[(i - 1) * 3]!;
    const dy = track.xyz[i * 3 + 1]! - track.xyz[(i - 1) * 3 + 1]!;
    const d2 = dx * dx + dy * dy;
    total += Math.sqrt(d2);
    cumulativeM[i] = total;
    headingsRad[i] = d2 > STATIONARY_EPSILON_M2 ? Math.atan2(dy, dx) : Number.NaN;
  }
  return { entityId, times: [...track.t], cumulativeM, headingsRad };
}

function lowerBound(times: readonly number[], t: number): number {
  let lo = 0;
  let hi = times.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (times[mid]! <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo; // number of samples at or before t
}

/**
 * Ground-path length traveled by the entity through time t (linear
 * interpolation between bracketing samples; clamped at the track ends).
 */
export function distanceAt(traj: EntityTrajectory, t: number): number {
  const { times, cumulativeM } = traj;
  const at = lowerBound(times, t);
  if (at <= 0) return 0;
  if (at >= times.length) return cumulativeM[cumulativeM.length - 1]!;
  const i = at - 1;
  const span = times[at]! - times[i]!;
  if (span <= 0) return cumulativeM[i]!;
  const u = (t - times[i]!) / span;
  return cumulativeM[i]! + (cumulativeM[at]! - cumulativeM[i]!) * u;
}

/**
 * Smoothed motion direction at time t: vector average of the segment
 * headings whose ends lie within (t − windowMs, t], so turns blend over the
 * window instead of popping between 10 Hz samples — while remaining a pure
 * function of t. Stationary/edge fallbacks walk outward deterministically.
 */
export function headingAt(traj: EntityTrajectory, t: number, windowMs: number = 220): number {
  const { times, headingsRad } = traj;
  let sumX = 0;
  let sumY = 0;
  let used = 0;
  for (let i = 0; i < times.length; i += 1) {
    const time = times[i]!;
    if (time > t) break;
    if (t - time > windowMs) continue;
    const heading = headingsRad[i]!;
    if (!Number.isNaN(heading)) {
      sumX += Math.cos(heading);
      sumY += Math.sin(heading);
      used += 1;
    }
  }
  if (used > 0) return Math.atan2(sumY, sumX);
  // Stationary (or window precedes all motion): nearest earlier segment with
  // motion, else nearest later one, else facing +x. All data-derived and
  // order-deterministic.
  for (let i = times.length - 1; i >= 0; i -= 1) {
    const heading = headingsRad[i]!;
    if (times[i]! <= t && !Number.isNaN(heading)) return heading;
  }
  for (let i = 0; i < times.length; i += 1) {
    const heading = headingsRad[i]!;
    if (!Number.isNaN(heading)) return heading;
  }
  return 0;
}

/**
 * Frame-rate-independent exponential damping factor for camera easing.
 *
 * The intent is "lerp DAMPING of the remaining distance per 60 fps frame";
 * R3F's useFrame delta is SECONDS, so the per-frame exponent is
 * deltaSeconds × 60 (equivalently 1 − (1−DAMPING)^(dt·60) = 1 − e^(k·dt)).
 * Presentation only — never applied to world/source positions.
 */
export function dampFactor(deltaSeconds: number, dampingPerFrame: number): number {
  if (!Number.isFinite(deltaSeconds) || deltaSeconds <= 0) return 0;
  return 1 - Math.pow(1 - dampingPerFrame, deltaSeconds * 60);
}
