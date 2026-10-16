import * as THREE from 'three';

/**
 * Camera pose safety (KYN-07, docs/08): every camera mode's pose passes
 * through these bounds AFTER damping and BEFORE being written to the
 * camera, so no mode, track or transition can put the lens underground,
 * outside the stadium, or inside a player's body. Presentation-only —
 * clamps never touch player, ball or event data.
 */

export interface CameraBounds {
  /** Minimum lens height above the pitch plane (m). */
  readonly groundClearanceM: number;
  /** Maximum lens height (m). */
  readonly maxHeightM: number;
  /** Horizontal half-extents the camera may occupy (m, three-space x/z). */
  readonly halfExtentXZM: number;
  /** Minimum horizontal distance from a player root when the lens is low. */
  readonly minPlayerClearanceM: number;
  /** Player clearance only applies below this lens height (m). */
  readonly playerClearanceBelowM: number;
}

export const DEFAULT_CAMERA_BOUNDS: CameraBounds = {
  groundClearanceM: 0.65,
  maxHeightM: 165,
  halfExtentXZM: 82,
  minPlayerClearanceM: 1.4,
  playerClearanceBelowM: 2.3,
};

const HORIZONTAL = new THREE.Vector3();

/**
 * Clamp a camera pose in place. Deterministic and order-stable: bounds
 * first, then player clearance (players are only pushed away from, never
 * moved).
 */
export function clampCameraPose(
  position: THREE.Vector3,
  target: THREE.Vector3,
  playerPositions: readonly THREE.Vector3[],
  bounds: CameraBounds = DEFAULT_CAMERA_BOUNDS,
): void {
  position.y = THREE.MathUtils.clamp(position.y, bounds.groundClearanceM, bounds.maxHeightM);
  position.x = THREE.MathUtils.clamp(position.x, -bounds.halfExtentXZM, bounds.halfExtentXZM);
  position.z = THREE.MathUtils.clamp(position.z, -bounds.halfExtentXZM, bounds.halfExtentXZM);
  target.y = Math.max(target.y, 0);

  if (position.y < bounds.playerClearanceBelowM) {
    for (const player of playerPositions) {
      const dx = position.x - player.x;
      const dz = position.z - player.z;
      const horizontal = Math.hypot(dx, dz);
      if (horizontal < bounds.minPlayerClearanceM && horizontal > 1e-6) {
        const push = (bounds.minPlayerClearanceM - horizontal) / horizontal;
        position.x += dx * push;
        position.z += dz * push;
      } else if (horizontal <= 1e-6) {
        // Directly on top of a player: deterministic fixed-direction push.
        position.x += bounds.minPlayerClearanceM;
      }
    }
  }
  HORIZONTAL.set(0, 0, 0); // keep the scratch vector untouched for reuse
}

/** True when a camera position respects the bounds (for tests + QA). */
export function poseWithinBounds(
  position: THREE.Vector3,
  bounds: CameraBounds = DEFAULT_CAMERA_BOUNDS,
): boolean {
  return (
    position.y >= bounds.groundClearanceM - 1e-9 &&
    position.y <= bounds.maxHeightM + 1e-9 &&
    Math.abs(position.x) <= bounds.halfExtentXZM + 1e-9 &&
    Math.abs(position.z) <= bounds.halfExtentXZM + 1e-9
  );
}
