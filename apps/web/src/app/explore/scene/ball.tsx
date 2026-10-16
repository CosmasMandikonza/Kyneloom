'use client';

import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useFrame } from '@react-three/fiber';
import { pitchToThree } from '@kyneloom/contracts';
import { useSceneRuntime } from './scene-context';
import { buildTrajectory, distanceAt, headingAt } from './kinematics';
import { registerVisualProbe } from './visual-debug';

/**
 * The match ball (KYN-06). A regulation-size sphere (r = 0.11 m) with a
 * generated panel texture. Its world position is EXACTLY the authoritative
 * sample mapped through pitchToThree — the fixture's zM already is the ball
 * center height (0.11 m resting), so no extra lift is applied. Spin is a
 * pure function of the playhead: total ground-path length divided by the
 * radius around the current motion axis, recomputed absolutely every frame —
 * pause, duplicate frames, reverse and seek all yield the identical pose.
 */

const BALL_RADIUS_M = 0.11;

function drawBallTexture(): THREE.CanvasTexture {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#f2f8f6';
  ctx.fillRect(0, 0, size, size);
  // Classic panel suggestion: dark rounded patches on a white body.
  ctx.fillStyle = '#101e27';
  const spots: [number, number, number][] = [
    [64, 64, 22],
    [160, 48, 18],
    [224, 96, 20],
    [40, 152, 18],
    [128, 140, 24],
    [208, 184, 18],
    [80, 216, 20],
    [16, 224, 14],
    [168, 232, 16],
    [236, 236, 12],
    [12, 24, 14],
    [120, 16, 16],
  ];
  for (const [x, y, r] of spots) {
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.strokeStyle = '#2a414b';
  ctx.lineWidth = 3;
  for (const [x, y, r] of spots) {
    ctx.beginPath();
    ctx.arc(x, y, r + 5, 0, Math.PI * 2);
    ctx.stroke();
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

export function Ball() {
  const { engine, getFrame, scene } = useSceneRuntime();
  const meshRef = useRef<THREE.Mesh>(null);
  const shadowRef = useRef<THREE.Mesh>(null);
  const texture = useMemo(() => drawBallTexture(), []);
  const axis = useMemo(() => new THREE.Vector3(), []);

  // Pure ground-path trajectory from the scene's own samples.
  const trajectory = useMemo(() => {
    const track = scene.tracks.find((candidate) => candidate.entityId === scene.ballEntityId);
    return track === undefined ? null : buildTrajectory(track.entityId, track);
  }, [scene.tracks, scene.ballEntityId]);

  useEffect(() => {
    if (trajectory === null) return;
    return registerVisualProbe('ball', {
      ballWorldPosition: () => {
        const mesh = meshRef.current;
        return mesh === null || !mesh.visible
          ? null
          : ([mesh.position.x, mesh.position.y, mesh.position.z] as const);
      },
      ballQuaternion: () => {
        const mesh = meshRef.current;
        return mesh === null || !mesh.visible
          ? null
          : ([mesh.quaternion.x, mesh.quaternion.y, mesh.quaternion.z, mesh.quaternion.w] as const);
      },
    });
  }, [trajectory]);

  useFrame(() => {
    const mesh = meshRef.current;
    const shadow = shadowRef.current;
    if (mesh === null || shadow === null) return;
    const sample = getFrame(engine.playheadMs).positions.get(scene.ballEntityId);
    if (sample === undefined) {
      mesh.visible = false;
      shadow.visible = false;
      return;
    }
    mesh.visible = true;
    shadow.visible = true;
    const [x, y, z] = pitchToThree({ xM: sample.xM, yM: sample.yM, zM: sample.zM });
    // zM IS the authoritative ball-center height — transform verbatim.
    mesh.position.set(x, y, z);
    shadow.position.set(x, 0.015, z);
    const shadowScale = THREE.MathUtils.clamp(1.25 - y * 0.18, 0.45, 1.25);
    shadow.scale.setScalar(shadowScale);

    // Deterministic roll: angle = ground-path distance / radius, axis =
    // up × motion direction. Both are pure lookups at the playhead, so the
    // same timestamp always produces the identical quaternion.
    if (trajectory !== null) {
      const t = engine.playheadMs;
      const heading = headingAt(trajectory, t);
      // Pitch motion (cos h, sin h) → three-space direction (cos h, 0, −sin h);
      // rolling axis = up × direction.
      axis.set(-Math.sin(heading), 0, -Math.cos(heading)).normalize();
      mesh.quaternion.setFromAxisAngle(axis, distanceAt(trajectory, t) / BALL_RADIUS_M);
    }
  });

  return (
    <group>
      <mesh ref={meshRef} castShadow>
        <sphereGeometry args={[BALL_RADIUS_M, 24, 20]} />
        <meshStandardMaterial map={texture} roughness={0.42} metalness={0.02} />
      </mesh>
      <mesh ref={shadowRef} rotation={[-Math.PI / 2, 0, 0]}>
        <circleGeometry args={[BALL_RADIUS_M * 2.4, 20]} />
        <meshBasicMaterial color="#071319" transparent opacity={0.34} depthWrite={false} />
      </mesh>
    </group>
  );
}
