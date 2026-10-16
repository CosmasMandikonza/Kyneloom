'use client';

import { useEffect, useMemo, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import * as THREE from 'three';
import { pitchToThree } from '@kyneloom/contracts';
import { useSceneRuntime, type CameraMode } from './scene-context';
import { dampFactor } from './kinematics';
import { registerVisualProbe } from './visual-debug';
import { clampCameraPose } from './camera-safety';
import {
  isUsableTrack,
  sampleCameraTrack,
  toAbsoluteTrack,
  type AbsoluteCameraTrack,
} from './camera-track';

/**
 * Elastic cinematic camera rig (KYN-07, docs/08): broadcast, overhead,
 * player follow, goalkeeper, free orbit and manifest-directed — exactly ONE
 * active driver per frame. Cameras are PRESENTATION ONLY: they never touch
 * player/ball coordinates; the world snapshot at time t is identical in
 * every mode (asserted by the Playwright QA hook).
 *
 * Motion: frame-rate-independent damping in the seconds domain for
 * position, target AND fov; reduced motion snaps. Every final pose passes
 * the safety clamps (never underground, inside the stadium, clear of
 * players). Entering free orbit hands the camera to OrbitControls at the
 * current look-target; leaving any mode resumes the spring exactly where
 * the camera is — interruption is inherent, never a teleport.
 */

const PITCH_WIDTH_M = 68;
/** Fraction of the remaining distance closed per 60 fps frame. */
const DAMPING = 0.075;

/** Base fov per mode (authored tracks override it per keyframe). */
const MODE_FOV: Record<Exclude<CameraMode, 'orbit'>, number> = {
  broadcast: 46,
  overhead: 46,
  follow: 50,
  goalkeeper: 44,
  directed: 46,
};

/** Last applied look-target (any mode) — read by the visual QA probe. */
const LAST_TARGET = new THREE.Vector3(0, 0, 0);

const DESIRED = new THREE.Vector3();
const TARGET = new THREE.Vector3();
const MOTION = new THREE.Vector3();
const SMOOTHED_TARGET = new THREE.Vector3(0, 0, 0);
const KEEPER_POS = new THREE.Vector3();
const BALL_POS = new THREE.Vector3();

export function CameraRig({ mode }: { mode: CameraMode }) {
  const { scene, engine, getFrame, selected } = useSceneRuntime();
  const camera = useThree((state) => state.camera) as THREE.PerspectiveCamera;
  const controlsRef = useRef<React.ComponentRef<typeof OrbitControls>>(null);
  const fovRef = useRef(46);

  // Directed playback: convert the validated track's offset clock to the
  // absolute match clock exactly once per loaded scene.
  const directedTrack = useMemo<AbsoluteCameraTrack | null>(() => {
    const raw = scene.directedTrack;
    if (raw === null || !isUsableTrack(raw)) return null;
    return toAbsoluteTrack(raw, scene.windowMs[0]);
  }, [scene.directedTrack, scene.windowMs]);

  const goalkeepers = useMemo(
    () => scene.players.filter((player) => player.isGoalkeeper).map((player) => player.entityId),
    [scene.players],
  );

  useEffect(
    () =>
      registerVisualProbe('camera', {
        cameraWorldPosition: () =>
          [camera.position.x, camera.position.y, camera.position.z] as const,
        cameraFov: () => camera.fov,
        cameraLookTarget: () => [LAST_TARGET.x, LAST_TARGET.y, LAST_TARGET.z] as const,
      }),
    [camera],
  );

  // Entering free orbit: pivot the controls at the current look-target so
  // the handoff is seamless (no jump), and let OrbitControls own the camera.
  useEffect(() => {
    if (mode === 'orbit' && controlsRef.current !== null) {
      controlsRef.current.target.copy(SMOOTHED_TARGET);
      controlsRef.current.update();
    }
  }, [mode]);

  useFrame((state, deltaSeconds) => {
    const camera = state.camera as THREE.PerspectiveCamera;
    const snapshot = getFrame(engine.playheadMs);

    // Player roots (scratch pool, zero per-frame allocation) — shared by
    // every mode's safety pass, orbit included.
    const players = snapshot.positions;
    const scratch = playerScratch(players.size);
    let count = 0;
    for (const sample of players.values()) {
      if (sample.entityId === scene.ballEntityId) continue;
      const v = scratch[count]!;
      v.set(sample.xM, sample.zM, -sample.yM); // pitchToThree, inlined for the hot loop
      count += 1;
    }
    const playerRoots = scratch.slice(0, count);

    if (mode === 'orbit') {
      // OrbitControls remains the single active driver; the rig enforces
      // the SAME safety contract on its camera position and pan target —
      // drag/zoom/touch keep working, the lens just cannot leave the
      // stadium, go underground or enter a player. drei updates the
      // controls at useFrame priority -1, i.e. BEFORE this callback, so
      // this clamp is the FINAL write of the frame (never call update()
      // here — re-applying residual damping deltas would push the camera
      // back out of bounds after the clamp).
      const controls = controlsRef.current;
      if (controls !== null) {
        clampCameraPose(camera.position, controls.target, playerRoots);
        LAST_TARGET.copy(controls.target);
      }
      return;
    }

    const ball = snapshot.positions.get(scene.ballEntityId);
    const followId = selected.entityId ?? 'home-11'; // the decoy winger by default

    let desiredFov = MODE_FOV[mode as Exclude<CameraMode, 'orbit'>] ?? 46;

    if (mode === 'overhead') {
      TARGET.set(0, 0, 0);
      DESIRED.set(0, 92, 0.001); // 68 m width + margin under a 46° vertical FOV
    } else if (mode === 'broadcast') {
      const bx = ball?.xM ?? 0;
      const bz = ball ? -ball.yM : 0;
      TARGET.set(bx * 0.85, 0.5, bz * 0.6);
      DESIRED.set(bx * 0.72, 19.5, bz * 0.28 + PITCH_WIDTH_M * 0.95);
    } else if (mode === 'follow') {
      const follower = snapshot.positions.get(followId) ?? ball;
      if (follower !== undefined) {
        const heading = snapshot.headingsRad.get(followId) ?? 0;
        // Pitch motion (dx, dy) = (cos h, sin h) → three-space (dx, 0, −dy).
        MOTION.set(Math.cos(heading), 0, -Math.sin(heading));
        DESIRED.set(follower.xM - MOTION.x * 7.2, 4.4, -follower.yM - MOTION.z * 7.2);
        TARGET.set(follower.xM + MOTION.x * 6, 1.3, -follower.yM + MOTION.z * 6);
      } else {
        TARGET.set(0, 0, 0);
        DESIRED.set(0, 38, 52);
      }
    } else if (mode === 'goalkeeper') {
      // Frame from the ENGAGED keeper's actual location: whichever keeper is
      // nearest the ball. Position sits just behind/above that keeper,
      // looking at the ball — never fabricated geometry.
      let keeperId: string | null = null;
      let keeperDist = Number.POSITIVE_INFINITY;
      for (const candidate of goalkeepers) {
        const pos = snapshot.positions.get(candidate);
        if (pos === undefined || ball === undefined) continue;
        const dist = Math.hypot(pos.xM - ball.xM, pos.yM - ball.yM);
        if (dist < keeperDist) {
          keeperDist = dist;
          keeperId = candidate;
        }
      }
      const keeper = keeperId !== null ? snapshot.positions.get(keeperId) : undefined;
      if (keeper !== undefined) {
        const [kx, ky, kz] = pitchToThree({ xM: keeper.xM, yM: keeper.yM, zM: keeper.zM });
        KEEPER_POS.set(kx, ky, kz);
        if (ball !== undefined) {
          const [bx, by, bz] = pitchToThree({ xM: ball.xM, yM: ball.yM, zM: ball.zM });
          BALL_POS.set(bx, by, bz);
        } else {
          BALL_POS.set(0, 0.5, 0);
        }
        MOTION.subVectors(BALL_POS, KEEPER_POS);
        MOTION.y = 0;
        if (MOTION.lengthSq() < 1e-6) MOTION.set(1, 0, 0);
        MOTION.normalize();
        DESIRED.copy(KEEPER_POS).addScaledVector(MOTION, -2.2);
        DESIRED.y = 2.8;
        TARGET.copy(BALL_POS);
        TARGET.y = Math.max(TARGET.y, 0.6);
      } else {
        TARGET.set(0, 0, 0);
        DESIRED.set(0, 38, 52);
      }
    } else if (mode === 'directed' && directedTrack !== null) {
      const pose = sampleCameraTrack(directedTrack, engine.playheadMs);
      DESIRED.copy(pose.position);
      TARGET.copy(pose.target);
      desiredFov = pose.fovDeg;
    } else {
      TARGET.set(0, 0, 0);
      DESIRED.set(0, 38, 52);
    }

    if (engine.reducedMotion) {
      camera.position.copy(DESIRED);
      SMOOTHED_TARGET.copy(TARGET);
      fovRef.current = desiredFov;
    } else {
      // useFrame's delta is SECONDS; dampFactor converts it to the
      // frame-rate-independent "close DAMPING per 60 fps frame" lerp.
      const t = dampFactor(deltaSeconds, DAMPING);
      camera.position.lerp(DESIRED, t);
      SMOOTHED_TARGET.lerp(TARGET, t);
      fovRef.current += (desiredFov - fovRef.current) * t;
    }

    // Safety last: no mode/track/transition can end underground, outside
    // the stadium or inside a player.
    clampCameraPose(camera.position, SMOOTHED_TARGET, playerRoots);
    LAST_TARGET.copy(SMOOTHED_TARGET);

    if (Math.abs(camera.fov - fovRef.current) > 0.01) {
      camera.fov = fovRef.current;
      camera.updateProjectionMatrix();
    }
    camera.lookAt(SMOOTHED_TARGET);
  });

  return (
    <OrbitControls
      ref={controlsRef}
      enabled={mode === 'orbit'}
      enableDamping={!engine.reducedMotion}
      maxPolarAngle={Math.PI / 2 - 0.04}
      minDistance={2}
      maxDistance={180}
      makeDefault
    />
  );
}

/** Scratch vectors reused across frames — zero per-frame allocation. */
const SCRATCH_POOL: THREE.Vector3[] = [];
function playerScratch(count: number): THREE.Vector3[] {
  while (SCRATCH_POOL.length < count) SCRATCH_POOL.push(new THREE.Vector3());
  return SCRATCH_POOL;
}
