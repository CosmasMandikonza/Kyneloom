/**
 * Canonical pitch geometry, transcribed from docs/05-data-and-event-contracts.md.
 *
 * Coordinate system: ground-plane origin at pitch center, `+x` towards the
 * designated attacking right goal, `+y` towards the upper touchline, `+z`
 * vertically upward. All units are meters. Team attacking direction is stored
 * per half by the (future) event contract; it is never inferred from colors.
 */

/** Identifier of the canonical coordinate system, referenced by scene code. */
export const PITCH_COORDINATE_SYSTEM = 'pitch-meters-center-origin-v1' as const;

/** Synthetic default pitch size: 105 m × 68 m (docs/05). */
export const DEFAULT_PITCH_LENGTH_M = 105 as const;
export const DEFAULT_PITCH_WIDTH_M = 68 as const;

export interface PitchDimensions {
  readonly coordinateSystem: typeof PITCH_COORDINATE_SYSTEM;
  /** Touchline-to-touchline length in meters along x. */
  readonly lengthM: number;
  /** Goal-line-to-goal-line width in meters along y. */
  readonly widthM: number;
}

export interface PitchPoint {
  readonly xM: number;
  readonly yM: number;
}

/**
 * Build validated pitch dimensions. Rejects non-finite and non-positive sizes
 * rather than clamping silently, so bad fixture data fails loudly at the seam.
 */
export function createPitchDimensions(
  input: { lengthM?: number; widthM?: number } = {},
): PitchDimensions {
  const lengthM = input.lengthM ?? DEFAULT_PITCH_LENGTH_M;
  const widthM = input.widthM ?? DEFAULT_PITCH_WIDTH_M;
  if (!Number.isFinite(lengthM) || lengthM <= 0) {
    throw new RangeError(`pitch lengthM must be a positive finite number, got ${String(lengthM)}`);
  }
  if (!Number.isFinite(widthM) || widthM <= 0) {
    throw new RangeError(`pitch widthM must be a positive finite number, got ${String(widthM)}`);
  }
  return { coordinateSystem: PITCH_COORDINATE_SYSTEM, lengthM, widthM };
}

/**
 * Whether a point lies inside the playing area, optionally allowing a margin
 * in meters (players can legitimately step slightly outside the lines).
 */
export function isInsidePitch(
  point: PitchPoint,
  pitch: PitchDimensions,
  options: { marginM?: number } = {},
): boolean {
  const marginM = options.marginM ?? 0;
  if (!Number.isFinite(marginM) || marginM < 0) {
    throw new RangeError(`marginM must be a non-negative finite number, got ${String(marginM)}`);
  }
  if (!Number.isFinite(point.xM) || !Number.isFinite(point.yM)) {
    return false;
  }
  const halfLength = pitch.lengthM / 2 + marginM;
  const halfWidth = pitch.widthM / 2 + marginM;
  return (
    point.xM >= -halfLength &&
    point.xM <= halfLength &&
    point.yM >= -halfWidth &&
    point.yM <= halfWidth
  );
}
