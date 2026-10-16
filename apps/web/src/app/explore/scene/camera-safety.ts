import * as THREE from 'three';

/**
 * Camera pose safety (KYN-07, docs/08): every camera mode's pose — including
 * free orbit, where OrbitControls drives the lens — passes through these
 * constraints, so no mode, track, transition or user gesture can put the
 * camera underground, outside the stadium, or inside a player's body.
 * Presentation-only — clamps never touch player, ball or event data.
 *
 * Resolution is a bounded deterministic fixed-point: clamp to the stadium
 * box, push out of players, re-clamp, repeat a fixed number of rounds in
 * the player order given. If the configuration is impossible (a player
 * hugs the boundary wall so no in-bounds point clears the body band), the
 * resolver falls back to lifting the lens above the body-height band,
 * which satisfies every constraint without moving anything else.
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

/** Fixed-point rounds; each round is O(players). Deterministic, bounded. */
const MAX_RESOLUTION_ROUNDS = 8;

function clampToBox(v: THREE.Vector3, bounds: CameraBounds): void {
  v.y = THREE.MathUtils.clamp(v.y, bounds.groundClearanceM, bounds.maxHeightM);
  v.x = THREE.MathUtils.clamp(v.x, -bounds.halfExtentXZM, bounds.halfExtentXZM);
  v.z = THREE.MathUtils.clamp(v.z, -bounds.halfExtentXZM, bounds.halfExtentXZM);
}

function clearOfPlayers(
  position: THREE.Vector3,
  playerPositions: readonly THREE.Vector3[],
  bounds: CameraBounds,
): boolean {
  if (position.y >= bounds.playerClearanceBelowM) return true;
  for (const player of playerPositions) {
    if (
      Math.hypot(position.x - player.x, position.z - player.z) <
      bounds.minPlayerClearanceM - 1e-6
    ) {
      return false;
    }
  }
  return true;
}

/** True when a camera position respects bounds AND player clearance. */
export function poseSatisfiesConstraints(
  position: THREE.Vector3,
  playerPositions: readonly THREE.Vector3[],
  bounds: CameraBounds = DEFAULT_CAMERA_BOUNDS,
): boolean {
  return poseWithinBounds(position, bounds) && clearOfPlayers(position, playerPositions, bounds);
}

/** True when a camera position respects the box bounds (tests + QA). */
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

/**
 * Clamp a camera pose in place. Deterministic and order-stable. The look
 * target is clamped into the same stadium box with y ≥ 0 (pan cannot carry
 * interest outside the venue); the position resolves bounds and player
 * clearance together, lifting above the body band only when no in-bounds
 * clearing point exists.
 */
export function clampCameraPose(
  position: THREE.Vector3,
  target: THREE.Vector3,
  playerPositions: readonly THREE.Vector3[],
  bounds: CameraBounds = DEFAULT_CAMERA_BOUNDS,
): void {
  target.y = THREE.MathUtils.clamp(target.y, 0, bounds.maxHeightM);
  target.x = THREE.MathUtils.clamp(target.x, -bounds.halfExtentXZM, bounds.halfExtentXZM);
  target.z = THREE.MathUtils.clamp(target.z, -bounds.halfExtentXZM, bounds.halfExtentXZM);

  clampToBox(position, bounds);

  for (let round = 0; round < MAX_RESOLUTION_ROUNDS; round += 1) {
    if (clearOfPlayers(position, playerPositions, bounds)) return;
    let pushed = false;
    for (const player of playerPositions) {
      const dx = position.x - player.x;
      const dz = position.z - player.z;
      const horizontal = Math.hypot(dx, dz);
      if (horizontal >= bounds.minPlayerClearanceM) continue;
      let dirX: number;
      let dirZ: number;
      if (horizontal > 1e-6) {
        dirX = dx / horizontal;
        dirZ = dz / horizontal;
      } else {
        // Directly on top of a player: deterministic fixed direction.
        dirX = 1;
        dirZ = 0;
      }
      // Radial push; when it would leave the stadium box (player hugging
      // the boundary wall), prefer the mirrored in-bounds clearing point.
      let toX = player.x + dirX * bounds.minPlayerClearanceM;
      let toZ = player.z + dirZ * bounds.minPlayerClearanceM;
      if (Math.abs(toX) > bounds.halfExtentXZM || Math.abs(toZ) > bounds.halfExtentXZM) {
        const mirrorX = player.x - dirX * bounds.minPlayerClearanceM;
        const mirrorZ = player.z - dirZ * bounds.minPlayerClearanceM;
        if (
          Math.abs(mirrorX) <= bounds.halfExtentXZM &&
          Math.abs(mirrorZ) <= bounds.halfExtentXZM
        ) {
          toX = mirrorX;
          toZ = mirrorZ;
        }
      }
      position.x = toX;
      position.z = toZ;
      pushed = true;
    }
    // Pushes may leave the stadium box or land in another player — bounds
    // and clearance resolve together, so re-clamp and iterate.
    clampToBox(position, bounds);
    if (!pushed) return;
  }

  // Impossible layout (player against the boundary wall): lift the lens
  // above the body-height band. Above it, player clearance does not apply,
  // and the box clamp already holds — every constraint is satisfied.
  position.y = Math.max(position.y, bounds.playerClearanceBelowM);
  clampToBox(position, bounds);
}
