'use client';

import { useFrame } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import * as THREE from 'three';
import { useSceneRuntime, type CameraMode } from './scene-context';

/**
 * Camera system (KYN-06, docs/08): broadcast, overhead tactical, player
 * follow and free orbit. Cameras are PRESENTATION ONLY — they never touch
 * player or ball coordinates; the world snapshot at time t is identical in
 * every mode (asserted by the Playwright QA hook). Transitions are damped
 * lerps; reduced motion snaps.
 */

const PITCH_WIDTH_M = 68;
const DAMPING = 0.075;

const DESIRED = new THREE.Vector3();
const TARGET = new THREE.Vector3();
const MOTION = new THREE.Vector3();
const SMOOTHED_TARGET = new THREE.Vector3(0, 0, 0);

export function CameraRig({ mode }: { mode: CameraMode }) {
  const { scene, engine, getFrame, selected } = useSceneRuntime();
  useFrame((state, deltaMs) => {
    if (mode === 'orbit') return; // OrbitControls drives the camera.
    const camera = state.camera;
    const snapshot = getFrame(engine.playheadMs);
    const ball = snapshot.positions.get(scene.ballEntityId);
    const followId = selected.entityId ?? 'home-11'; // the decoy winger by default
    const follower = snapshot.positions.get(followId) ?? ball;

    if (mode === 'overhead') {
      TARGET.set(0, 0, 0);
      DESIRED.set(0, 92, 0.001); // 68 m width + margin under a 46° vertical FOV
    } else if (mode === 'broadcast') {
      const bx = ball?.xM ?? 0;
      const bz = ball ? -ball.yM : 0;
      TARGET.set(bx * 0.85, 0.5, bz * 0.6);
      DESIRED.set(bx * 0.72, 19.5, bz * 0.28 + PITCH_WIDTH_M * 0.95);
    } else if (mode === 'follow' && follower !== undefined) {
      const heading = snapshot.headingsRad.get(followId) ?? 0;
      // Pitch motion (dx, dy) = (cos h, sin h) → three-space (dx, 0, −dy).
      MOTION.set(Math.cos(heading), 0, -Math.sin(heading));
      DESIRED.set(follower.xM - MOTION.x * 7.2, 4.4, -follower.yM - MOTION.z * 7.2);
      TARGET.set(follower.xM + MOTION.x * 6, 1.3, -follower.yM + MOTION.z * 6);
    } else {
      TARGET.set(0, 0, 0);
      DESIRED.set(0, 38, 52);
    }

    if (engine.reducedMotion) {
      camera.position.copy(DESIRED);
      SMOOTHED_TARGET.copy(TARGET);
      camera.lookAt(SMOOTHED_TARGET);
      return;
    }
    const t = 1 - Math.pow(1 - DAMPING, deltaMs / 16.6667);
    camera.position.lerp(DESIRED, t);
    SMOOTHED_TARGET.lerp(TARGET, t);
    camera.lookAt(SMOOTHED_TARGET);
  });

  return (
    <OrbitControls
      enabled={mode === 'orbit'}
      enableDamping={!engine.reducedMotion}
      maxPolarAngle={Math.PI / 2 - 0.04}
      minDistance={10}
      maxDistance={180}
      makeDefault
    />
  );
}
