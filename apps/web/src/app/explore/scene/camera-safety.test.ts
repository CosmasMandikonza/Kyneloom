import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { clampCameraPose, DEFAULT_CAMERA_BOUNDS, poseWithinBounds } from './camera-safety';

/**
 * KYN-07 acceptance: no camera mode, track or transition can put the lens
 * underground, outside the stadium, or inside a player. Clamps are
 * deterministic and presentation-only.
 */

const noPlayers: THREE.Vector3[] = [];

describe('clampCameraPose', () => {
  it('lifts an underground camera to the ground clearance', () => {
    const pos = new THREE.Vector3(0, -3, 0);
    const target = new THREE.Vector3(0, 0, 0);
    clampCameraPose(pos, target, noPlayers);
    expect(pos.y).toBe(DEFAULT_CAMERA_BOUNDS.groundClearanceM);
  });

  it('caps height and horizontal extent inside the stadium bounds', () => {
    const pos = new THREE.Vector3(5000, 9000, -5000);
    const target = new THREE.Vector3(0, 0, 0);
    clampCameraPose(pos, target, noPlayers);
    expect(poseWithinBounds(pos)).toBe(true);
    expect(pos.x).toBe(DEFAULT_CAMERA_BOUNDS.halfExtentXZM);
    expect(pos.z).toBe(-DEFAULT_CAMERA_BOUNDS.halfExtentXZM);
    expect(pos.y).toBe(DEFAULT_CAMERA_BOUNDS.maxHeightM);
  });

  it('keeps the look target at or above the pitch plane', () => {
    const pos = new THREE.Vector3(0, 10, 0);
    const target = new THREE.Vector3(0, -5, 0);
    clampCameraPose(pos, target, noPlayers);
    expect(target.y).toBe(0);
  });

  it('pushes a low camera away from a player it would clip through', () => {
    const player = new THREE.Vector3(10, 0, 5);
    const pos = new THREE.Vector3(10.5, 1.0, 5.2); // ~0.54 m away, lens at body height
    const target = new THREE.Vector3(30, 1, 5);
    clampCameraPose(pos, target, [player]);
    const distance = Math.hypot(pos.x - player.x, pos.z - player.z);
    expect(distance).toBeGreaterThanOrEqual(DEFAULT_CAMERA_BOUNDS.minPlayerClearanceM - 1e-6);
    // Deterministic: same inputs, same result.
    const pos2 = new THREE.Vector3(10.5, 1.0, 5.2);
    clampCameraPose(pos2, new THREE.Vector3(30, 1, 5), [new THREE.Vector3(10, 0, 5)]);
    expect(pos2.equals(pos)).toBe(true);
  });

  it('leaves a high camera untouched (flyover clearance is fine)', () => {
    const pos = new THREE.Vector3(10, 30, 5);
    const before = pos.clone();
    clampCameraPose(pos, new THREE.Vector3(0, 0, 0), [new THREE.Vector3(10, 0, 5)]);
    expect(pos.equals(before)).toBe(true);
  });

  it('handles a camera exactly on a player with a deterministic push', () => {
    const pos = new THREE.Vector3(4, 1.0, 4);
    clampCameraPose(pos, new THREE.Vector3(0, 0, 0), [new THREE.Vector3(4, 0, 4)]);
    expect(Number.isFinite(pos.x)).toBe(true);
    expect(Math.hypot(pos.x - 4, pos.z - 4)).toBeGreaterThanOrEqual(
      DEFAULT_CAMERA_BOUNDS.minPlayerClearanceM - 1e-6,
    );
  });
});
