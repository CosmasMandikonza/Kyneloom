'use client';

import { useMemo } from 'react';
import * as THREE from 'three';
import { createPitchDimensions } from '@kyneloom/match-core';

/**
 * Procedural stadium (KYN-06): regulation 105 × 68 m pitch, accurate IFAB
 * markings drawn into a canvas texture, real goal frames, floodlights and a
 * restrained stands ring. No external assets; everything is generated from
 * the canonical pitch constants so measurements can never drift from
 * docs/05.
 */

const PITCH = createPitchDimensions();
const HALF_LENGTH = PITCH.lengthM / 2; // 52.5
const HALF_WIDTH = PITCH.widthM / 2; // 34

// IFAB measurements (laws of the game) in meters.
const GOAL_WIDTH_M = 7.32;
const GOAL_HEIGHT_M = 2.44;
const GOAL_POST_RADIUS_M = 0.06;
const PENALTY_AREA_DEPTH_M = 16.5;
const PENALTY_AREA_WIDTH_M = 40.32;
const GOAL_AREA_DEPTH_M = 5.5;
const GOAL_AREA_WIDTH_M = 18.32;
const CENTRE_CIRCLE_RADIUS_M = 9.15;
const PENALTY_SPOT_M = 11;
const CORNER_ARC_RADIUS_M = 1;

function drawPitchTexture(): THREE.CanvasTexture {
  // 20 px per meter — enough for crisp lines at broadcast distances.
  const pxPerM = 20;
  const w = (PITCH.lengthM + 8) * pxPerM;
  const h = (PITCH.widthM + 8) * pxPerM;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;

  const mx = (x: number) => (x + PITCH.lengthM / 2 + 4) * pxPerM;
  const my = (y: number) => (y + PITCH.widthM / 2 + 4) * pxPerM;

  // Mowed turf: alternating stripes along the length.
  const stripe = 8; // meters per stripe
  for (let i = 0; i < PITCH.lengthM / stripe; i++) {
    ctx.fillStyle = i % 2 === 0 ? '#1e5c33' : '#1a522d';
    ctx.fillRect(
      mx(-HALF_LENGTH + i * stripe),
      my(-HALF_WIDTH),
      stripe * pxPerM,
      PITCH.widthM * pxPerM,
    );
  }
  // Subtle vignette so the center isn't flat.
  const grad = ctx.createRadialGradient(w / 2, h / 2, h * 0.2, w / 2, h / 2, h * 0.85);
  grad.addColorStop(0, 'rgba(255,255,255,0.05)');
  grad.addColorStop(1, 'rgba(0,0,0,0.18)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, w, h);

  // Markings.
  ctx.strokeStyle = 'rgba(245,250,246,0.92)';
  ctx.lineWidth = 0.12 * pxPerM;
  const line = (x1: number, y1: number, x2: number, y2: number) => {
    ctx.beginPath();
    ctx.moveTo(mx(x1), my(y1));
    ctx.lineTo(mx(x2), my(y2));
    ctx.stroke();
  };
  const box = (x: number, dir: 1 | -1) => {
    // Touchline to goal line, both halves.
    line(-HALF_LENGTH, -HALF_WIDTH, -HALF_LENGTH, HALF_WIDTH);
    line(HALF_LENGTH, -HALF_WIDTH, HALF_LENGTH, HALF_WIDTH);
    // Penalty area.
    line(x, -(PENALTY_AREA_WIDTH_M / 2), x, PENALTY_AREA_WIDTH_M / 2);
    line(x, PENALTY_AREA_WIDTH_M / 2, x + dir * PENALTY_AREA_DEPTH_M, PENALTY_AREA_WIDTH_M / 2);
    line(
      x,
      -(PENALTY_AREA_WIDTH_M / 2),
      x + dir * PENALTY_AREA_DEPTH_M,
      -(PENALTY_AREA_WIDTH_M / 2),
    );
    // Goal area.
    line(x, -(GOAL_AREA_WIDTH_M / 2), x, GOAL_AREA_WIDTH_M / 2);
    line(x, GOAL_AREA_WIDTH_M / 2, x + dir * GOAL_AREA_DEPTH_M, GOAL_AREA_WIDTH_M / 2);
    line(x, -(GOAL_AREA_WIDTH_M / 2), x + dir * GOAL_AREA_DEPTH_M, -(GOAL_AREA_WIDTH_M / 2));
    // Penalty spot.
    ctx.fillStyle = 'rgba(245,250,246,0.92)';
    ctx.beginPath();
    ctx.arc(mx(x + dir * PENALTY_SPOT_M), my(0), 0.16 * pxPerM, 0, Math.PI * 2);
    ctx.fill();
    // Penalty arc.
    ctx.beginPath();
    const arcX = x + dir * PENALTY_SPOT_M;
    const start = dir === 1 ? Math.PI / 2 + 0.925 : -Math.PI / 2 + 0.925;
    ctx.arc(mx(arcX), my(0), CENTRE_CIRCLE_RADIUS_M * pxPerM, start, start + Math.PI - 1.85);
    ctx.stroke();
  };
  // Perimeter.
  line(-HALF_LENGTH, -HALF_WIDTH, HALF_LENGTH, -HALF_WIDTH);
  line(-HALF_LENGTH, HALF_WIDTH, HALF_LENGTH, HALF_WIDTH);
  box(-HALF_LENGTH, 1);
  box(HALF_LENGTH, -1);
  // Halfway line + centre circle + spot.
  line(0, -HALF_WIDTH, 0, HALF_WIDTH);
  ctx.beginPath();
  ctx.arc(mx(0), my(0), CENTRE_CIRCLE_RADIUS_M * pxPerM, 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(mx(0), my(0), 0.16 * pxPerM, 0, Math.PI * 2);
  ctx.fill();
  // Corner arcs.
  for (const [sx, sy] of [
    [-1, -1],
    [-1, 1],
    [1, -1],
    [1, 1],
  ] as const) {
    ctx.beginPath();
    ctx.arc(
      mx(sx * HALF_LENGTH),
      my(sy * HALF_WIDTH),
      CORNER_ARC_RADIUS_M * pxPerM,
      0,
      Math.PI * 2,
    );
    ctx.stroke();
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  return texture;
}

function Goal({ side }: { side: 1 | -1 }) {
  const postGeometry = useMemo(
    () => new THREE.CylinderGeometry(GOAL_POST_RADIUS_M, GOAL_POST_RADIUS_M, GOAL_HEIGHT_M, 12),
    [],
  );
  const crossbarGeometry = useMemo(
    () =>
      new THREE.CylinderGeometry(
        GOAL_POST_RADIUS_M,
        GOAL_POST_RADIUS_M,
        GOAL_WIDTH_M + GOAL_POST_RADIUS_M * 2,
        12,
      ),
    [],
  );
  const white = useMemo(
    () => new THREE.MeshStandardMaterial({ color: '#f2f8f6', roughness: 0.35, metalness: 0.1 }),
    [],
  );
  const x = side * HALF_LENGTH;
  return (
    <group position={[x, 0, 0]}>
      <mesh
        geometry={postGeometry}
        material={white}
        position={[0, GOAL_HEIGHT_M / 2, -GOAL_WIDTH_M / 2]}
        castShadow
      />
      <mesh
        geometry={postGeometry}
        material={white}
        position={[0, GOAL_HEIGHT_M / 2, GOAL_WIDTH_M / 2]}
        castShadow
      />
      <mesh
        geometry={crossbarGeometry}
        material={white}
        position={[0, GOAL_HEIGHT_M, 0]}
        rotation={[Math.PI / 2, 0, 0]}
        castShadow
      />
      {/* Net suggestion: translucent planes behind the frame. */}
      <mesh position={[side * -0.9, GOAL_HEIGHT_M / 2, 0]}>
        <planeGeometry args={[GOAL_WIDTH_M, GOAL_HEIGHT_M]} />
        <meshBasicMaterial color="#c6f9e7" transparent opacity={0.07} side={THREE.DoubleSide} />
      </mesh>
    </group>
  );
}

function Floodlight({ x, z }: { x: number; z: number }) {
  return (
    <group position={[x, 0, z]}>
      <mesh position={[0, 14, 0]}>
        <cylinderGeometry args={[0.22, 0.34, 28, 8]} />
        <meshStandardMaterial color="#24404c" roughness={0.8} />
      </mesh>
      <mesh position={[0, 28.4, 0]}>
        <boxGeometry args={[4.4, 1.7, 0.7]} />
        <meshStandardMaterial color="#101e27" emissive="#f2f8f6" emissiveIntensity={0.55} />
      </mesh>
    </group>
  );
}

/** Stands ring: stepped dark tiers, instanced boxes for cheap draw calls. */
function Stands() {
  const tiers = useMemo(() => {
    const items: { position: [number, number, number]; scale: [number, number, number] }[] = [];
    const rows = 4;
    const d = 6;
    for (let row = 0; row < rows; row++) {
      const y = 1.6 + row * 2.1;
      const out = row * d;
      const len = PITCH.lengthM + 26 + out * 2;
      const wid = PITCH.widthM + 22 + out * 2;
      items.push(
        { position: [0, y, -wid / 2], scale: [len, 2.1, d] },
        { position: [0, y, wid / 2], scale: [len, 2.1, d] },
        { position: [-len / 2, y, 0], scale: [d, 2.1, wid] },
        { position: [len / 2, y, 0], scale: [d, 2.1, wid] },
      );
    }
    return items;
  }, []);
  const material = useMemo(
    () => new THREE.MeshStandardMaterial({ color: '#16262e', roughness: 0.95 }),
    [],
  );
  const geometry = useMemo(() => new THREE.BoxGeometry(1, 1, 1), []);
  return (
    <group>
      {tiers.map((tier, index) => (
        <mesh
          key={index}
          geometry={geometry}
          material={material}
          position={tier.position}
          scale={tier.scale}
        />
      ))}
    </group>
  );
}

export function Stadium() {
  const turf = useMemo(() => drawPitchTexture(), []);
  const apronMaterial = useMemo(
    () => new THREE.MeshStandardMaterial({ color: '#173024', roughness: 1 }),
    [],
  );
  return (
    <group>
      {/* Turf plane: texture covers pitch + 4 m apron on each side. */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
        <planeGeometry args={[PITCH.lengthM + 8, PITCH.widthM + 8]} />
        <meshStandardMaterial map={turf} roughness={0.92} />
      </mesh>
      {/* Surrounding ground so the world is not a floating island. */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.02, 0]}>
        <planeGeometry args={[PITCH.lengthM + 70, PITCH.widthM + 70]} />
        <primitive object={apronMaterial} attach="material" />
      </mesh>
      <Goal side={1} />
      <Goal side={-1} />
      <Stands />
      <Floodlight x={-(HALF_LENGTH + 16)} z={-(HALF_WIDTH + 14)} />
      <Floodlight x={HALF_LENGTH + 16} z={-(HALF_WIDTH + 14)} />
      <Floodlight x={-(HALF_LENGTH + 16)} z={HALF_WIDTH + 14} />
      <Floodlight x={HALF_LENGTH + 16} z={HALF_WIDTH + 14} />
    </group>
  );
}

/** Lighting rig: stadium-at-night key light + fills, one shadow caster set. */
export function StadiumLights() {
  return (
    <>
      <hemisphereLight args={['#9db8c4', '#071319', 0.55]} />
      {/* Main floodlight wash: steep angle for believable player shadows. */}
      <directionalLight
        position={[38, 55, 26]}
        intensity={1.65}
        color="#eaf6f2"
        castShadow
        shadow-mapSize-width={2048}
        shadow-mapSize-height={2048}
        shadow-camera-left={-70}
        shadow-camera-right={70}
        shadow-camera-top={50}
        shadow-camera-bottom={-50}
        shadow-camera-near={10}
        shadow-camera-far={160}
        shadow-bias={-0.00035}
      />
      <directionalLight position={[-42, 40, -20]} intensity={0.5} color="#b8d4de" />
      <ambientLight intensity={0.16} />
      <fog attach="fog" args={['#0a161d', 130, 320]} />
    </>
  );
}
