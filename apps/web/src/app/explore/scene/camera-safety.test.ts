import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  clampCameraPose,
  DEFAULT_CAMERA_BOUNDS,
  poseSatisfiesConstraints,
  poseWithinBounds,
} from './camera-safety';

/**
 * KYN-07 acceptance: no camera mode, track, transition or user gesture can
 * put the lens underground, outside the stadium, or inside a player. Bounds
 * and player clearance must hold SIMULTANEOUSLY (review round 2), the
 * resolver is deterministic, and impossible layouts get the safe lift
 * fallback — player geometry is never moved.
 */

const noPlayers: THREE.Vector3[] = [];

describe('clampCameraPose — box bounds', () => {
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

  it('keeps the look target inside the stadium box and above the pitch', () => {
    const pos = new THREE.Vector3(0, 10, 0);
    const target = new THREE.Vector3(999, -5, -999);
    clampCameraPose(pos, target, noPlayers);
    expect(target.x).toBe(DEFAULT_CAMERA_BOUNDS.halfExtentXZM);
    expect(target.z).toBe(-DEFAULT_CAMERA_BOUNDS.halfExtentXZM);
    expect(target.y).toBe(0);
  });
});

describe('clampCameraPose — player clearance', () => {
  it('pushes a low camera away from a player it would clip through', () => {
    const player = new THREE.Vector3(10, 0, 5);
    const pos = new THREE.Vector3(10.5, 1.0, 5.2); // ~0.54 m away, lens at body height
    const target = new THREE.Vector3(30, 1, 5);
    clampCameraPose(pos, target, [player]);
    const distance = Math.hypot(pos.x - player.x, pos.z - player.z);
    expect(distance).toBeGreaterThanOrEqual(DEFAULT_CAMERA_BOUNDS.minPlayerClearanceM - 1e-6);
    expect(poseSatisfiesConstraints(pos, [player])).toBe(true);
  });

  it('is deterministic: same inputs, same result', () => {
    const players = [new THREE.Vector3(10, 0, 5), new THREE.Vector3(12, 0, 5.5)];
    const a = new THREE.Vector3(10.5, 1.0, 5.2);
    const b = new THREE.Vector3(10.5, 1.0, 5.2);
    clampCameraPose(a, new THREE.Vector3(30, 1, 5), players);
    clampCameraPose(b, new THREE.Vector3(30, 1, 5), players);
    expect(b.equals(a)).toBe(true);
  });

  it('leaves a high camera untouched (flyover clearance is fine)', () => {
    const pos = new THREE.Vector3(10, 30, 5);
    const before = pos.clone();
    clampCameraPose(pos, new THREE.Vector3(0, 0, 0), [new THREE.Vector3(10, 0, 5)]);
    expect(pos.equals(before)).toBe(true);
  });

  it('handles a camera exactly on a player with a deterministic push', () => {
    const player = new THREE.Vector3(4, 0, 4);
    const pos = new THREE.Vector3(4, 1.0, 4);
    clampCameraPose(pos, new THREE.Vector3(0, 0, 0), [player]);
    expect(poseSatisfiesConstraints(pos, [player])).toBe(true);
  });
});

describe('clampCameraPose — bounds + clearance resolve together (review round 2)', () => {
  it('the documented boundary case: player adjacent to the wall, camera at the bound', () => {
    // Review example: position (82, 1, 0), player (81.7, 0, 0). A naive push
    // moves x to ≈83.1 — outside the supposedly hard bound.
    const player = new THREE.Vector3(81.7, 0, 0);
    const pos = new THREE.Vector3(82, 1.0, 0);
    const target = new THREE.Vector3(0, 1, 0);
    clampCameraPose(pos, target, [player]);
    // The naive push would move x to ≈83.1 (out of bounds). The resolver
    // takes the mirrored in-bounds clearing point instead: x = 81.7 − 1.4,
    // body height unchanged — BOTH constraints hold simultaneously.
    expect(poseWithinBounds(pos)).toBe(true);
    expect(poseSatisfiesConstraints(pos, [player])).toBe(true);
    expect(pos.x).toBeCloseTo(80.3, 5);
    expect(pos.y).toBe(1.0);
  });

  it('a near-wall collision slides to the in-bounds clearing point (mirror)', () => {
    // Player 1.0 m from the wall, camera pushed radially INTO the wall: the
    // radial target (82.4) is out of bounds, so the resolver takes the
    // mirrored in-bounds clearing point instead of lifting or breaking the
    // bound.
    const player = new THREE.Vector3(81.0, 0, 0);
    const pos = new THREE.Vector3(81.6, 1.0, 0); // 0.6 m from player, body height
    const target = new THREE.Vector3(0, 1, 0);
    clampCameraPose(pos, target, [player]);
    expect(poseWithinBounds(pos)).toBe(true);
    expect(Math.hypot(pos.x - player.x, pos.z - player.z)).toBeGreaterThanOrEqual(
      DEFAULT_CAMERA_BOUNDS.minPlayerClearanceM - 1e-6,
    );
    expect(pos.y).toBe(1.0); // no lift when an in-bounds clearing point exists
    expect(pos.x).toBeCloseTo(79.6, 5); // mirrored side of the player
  });

  it('multiple nearby players converge with every constraint satisfied', () => {
    // Sandwich: camera between two players 1.5 m apart (clearance 1.4 m each
    // cannot hold between them at body height without leaving the pair).
    const players = [new THREE.Vector3(10, 0, 0), new THREE.Vector3(11.5, 0, 0)];
    const pos = new THREE.Vector3(10.75, 1.0, 0);
    const target = new THREE.Vector3(0, 1, 0);
    clampCameraPose(pos, target, players);
    expect(poseSatisfiesConstraints(pos, players)).toBe(true);
    // Player geometry is never moved.
    expect(players[0]!.x).toBe(10);
    expect(players[1]!.x).toBe(11.5);
  });

  it('sequential pushes cannot reintroduce a previous collision', () => {
    // Chain of players: each push must not land the camera inside the next.
    const players = [
      new THREE.Vector3(0, 0, 0),
      new THREE.Vector3(1.3, 0, 0.1),
      new THREE.Vector3(2.6, 0, -0.1),
      new THREE.Vector3(3.9, 0, 0.05),
    ];
    const pos = new THREE.Vector3(0.2, 1.0, 0);
    const target = new THREE.Vector3(0, 1, 0);
    clampCameraPose(pos, target, players);
    expect(poseSatisfiesConstraints(pos, players)).toBe(true);
    // Deterministic across repeated runs.
    const pos2 = new THREE.Vector3(0.2, 1.0, 0);
    clampCameraPose(
      pos2,
      new THREE.Vector3(0, 1, 0),
      players.map((p) => p.clone()),
    );
    expect(pos2.equals(pos)).toBe(true);
  });

  it('corner-adjacent player: camera stays in bounds and clear (mirrored)', () => {
    // Player ON the corner diagonal: both constraints must still hold.
    const h = DEFAULT_CAMERA_BOUNDS.halfExtentXZM;
    const player = new THREE.Vector3(h - 0.2, 0, -(h - 0.2));
    const pos = new THREE.Vector3(h, 0.9, -h);
    const target = new THREE.Vector3(0, 1, 0);
    clampCameraPose(pos, target, [player]);
    expect(poseWithinBounds(pos)).toBe(true);
    expect(poseSatisfiesConstraints(pos, [player])).toBe(true);
  });

  it('the lift fallback fires when no in-bounds clearing point exists (sandwich)', () => {
    // Two players 1.5 m apart: 1.4 m clearance cannot hold between them at
    // body height in-bounds — the guaranteed terminator lifts the lens
    // above the body band, satisfying every constraint.
    const players = [new THREE.Vector3(10, 0, 0), new THREE.Vector3(11.5, 0, 0)];
    const pos = new THREE.Vector3(10.75, 1.0, 0);
    clampCameraPose(pos, new THREE.Vector3(0, 1, 0), players);
    expect(poseWithinBounds(pos)).toBe(true);
    expect(poseSatisfiesConstraints(pos, players)).toBe(true);
    expect(pos.y).toBeGreaterThanOrEqual(DEFAULT_CAMERA_BOUNDS.playerClearanceBelowM);
  });
});
