'use client';

/**
 * KYN-09 — the landing's single WebGL canvas.
 *
 * One R3F context owns every phase layer (docs/17 §3: no second WebGL
 * context next to the replay):
 * - `OrbQuad` — the adapted React Bits Orb shader (see orb-shader.ts) as a
 *   fullscreen triangle behind everything; dissolves at FRAGMENTS.
 * - `FragmentField` — one InstancedMesh; every fragment flies a deterministic
 *   quadratic-bezier path from the orb's epicenter to a REAL pitch target
 *   (outline / markings / story trajectories / checkpoint players) and comes
 *   to REST there — the resting field IS the pitch drawing itself.
 * - `RevealScene` — the REAL stadium (the exact component /explore renders,
 *   not a copy) plus luminous line work and checkpoint markers; mounted when
 *   FRAGMENTS starts so PITCH_REVEAL begins with zero allocation.
 * - `LandingCamera` — one damped camera driver, phase-keyed; reduced motion
 *   snaps between poses.
 *
 * Resource contract: imperatively created objects (lines, the orb geometry)
 * are memoized once and disposed in their effect cleanups; declarative R3F
 * objects are disposed on unmount — the landing leaves NO rendering loop,
 * program or geometry behind when navigation unmounts the page. The
 * `window.__kyneloomLanding` probe exposes live state for QA and is deleted
 * on unmount.
 */

import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { Stadium, StadiumLights } from '../explore/scene/stadium';
import type { LandingFieldSpec, Vec3 } from '@/lib/landing-geometry';
import type { LandingPhase } from '@/lib/landing-transition';
import { ORB_FRAGMENT, ORB_VERTEX, OrbDriver, ORB_PALETTE } from './orb-shader';

export interface OrbFieldProps {
  readonly phase: LandingPhase;
  readonly phaseEnteredAtMs: number;
  readonly field: LandingFieldSpec;
  readonly introMs: number;
  readonly fragmentsMs: number;
  readonly revealMs: number;
  readonly reducedMotion: boolean;
  readonly onPhaseComplete: (phase: 'intro' | 'fragments' | 'pitch_reveal') => void;
  readonly onFail: (reason: 'context-lost') => void;
}

// ---------------------------------------------------------------------------
// Camera choreography — one driver, damped, phase-keyed.
type Pose = { position: [number, number, number]; look: [number, number, number] };
const POSES: Record<'idle' | 'intro' | 'fragments' | 'reveal', Pose> = {
  idle: { position: [0, 9.5, 60], look: [0, 9, 30] },
  intro: { position: [0, 8.6, 46], look: [0, 8.5, 30] },
  fragments: { position: [7, 22, 64], look: [4, 2, 14] },
  reveal: { position: [0, 84, 36], look: [0, 0, 0] },
};

function LandingCamera({ phase, reducedMotion }: { phase: LandingPhase; reducedMotion: boolean }) {
  const camera = useThree((state) => state.camera);
  const pointer = useRef({ x: 0, y: 0 });
  const smoothedLook = useRef(new THREE.Vector3(...POSES.idle.look));
  const desiredPosition = useRef(new THREE.Vector3(...POSES.idle.position));
  const desiredLook = useRef(new THREE.Vector3(...POSES.idle.look));

  useEffect(() => {
    const onMove = (event: PointerEvent): void => {
      pointer.current.x = (event.clientX / window.innerWidth) * 2 - 1;
      pointer.current.y = (event.clientY / window.innerHeight) * 2 - 1;
    };
    window.addEventListener('pointermove', onMove, { passive: true });
    return () => window.removeEventListener('pointermove', onMove);
  }, []);

  useFrame((_, deltaSeconds) => {
    const target =
      phase === 'idle'
        ? POSES.idle
        : phase === 'intro'
          ? POSES.intro
          : phase === 'fragments'
            ? POSES.fragments
            : POSES.reveal;
    desiredPosition.current.set(...target.position);
    desiredLook.current.set(...target.look);

    // Subtle pointer parallax only while the editorial layer shows — never
    // during choreography (exactly one driver writes the camera per frame).
    const parallax = phase === 'idle' && !reducedMotion ? 1 : 0;
    const px = pointer.current.x * 2.2 * parallax;
    const py = -pointer.current.y * 1.1 * parallax;

    if (reducedMotion) {
      camera.position.set(
        desiredPosition.current.x + px,
        desiredPosition.current.y + py,
        desiredPosition.current.z,
      );
      smoothedLook.current.copy(desiredLook.current);
    } else {
      const t = 1 - Math.exp(-deltaSeconds * 2.8);
      camera.position.lerp(desiredPosition.current, t);
      smoothedLook.current.lerp(desiredLook.current, t);
      camera.position.x += px * 0.06;
      camera.position.y += py * 0.06;
    }
    camera.lookAt(smoothedLook.current);
  });
  return null;
}

// ---------------------------------------------------------------------------
// The orb — fullscreen triangle, upstream shader, FSM-driven dissolve.
function OrbQuad({
  phase,
  phaseEnteredAtMs,
  fragmentsMs,
  reducedMotion,
}: {
  phase: LandingPhase;
  phaseEnteredAtMs: number;
  fragmentsMs: number;
  reducedMotion: boolean;
}) {
  const material = useRef<THREE.ShaderMaterial>(null);
  const mesh = useRef<THREE.Mesh>(null);
  const dpr = useThree((state) => state.viewport.dpr);
  const driver = useMemo(() => new OrbDriver(!reducedMotion), [reducedMotion]);
  const pointer = useRef({ x: -9999, y: -9999, inside: false });
  const container = useThree((state) => state.gl.domElement);

  useEffect(() => {
    const onMove = (event: PointerEvent): void => {
      const rect = container.getBoundingClientRect();
      pointer.current = {
        x: event.clientX - rect.left,
        y: event.clientY - rect.top,
        inside: true,
      };
    };
    const onLeave = (): void => {
      pointer.current.inside = false;
    };
    container.addEventListener('pointermove', onMove, { passive: true });
    container.addEventListener('pointerleave', onLeave);
    return () => {
      container.removeEventListener('pointermove', onMove);
      container.removeEventListener('pointerleave', onLeave);
    };
  }, [container]);

  // Palette hex → linear rgb triples (upstream parsed colors via 2D canvas).
  const palette = useMemo(() => {
    const parse = (hex: string): [number, number, number] => {
      const v = parseInt(hex.slice(1), 16);
      const srgb = [(v >> 16) & 255, (v >> 8) & 255, v & 255].map((c) => c / 255);
      return srgb.map((c) => Math.pow(c, 2.2)) as [number, number, number];
    };
    return {
      background: parse(ORB_PALETTE.background),
      color1: parse(ORB_PALETTE.color1),
      color2: parse(ORB_PALETTE.color2),
      color3: parse(ORB_PALETTE.color3),
    };
  }, []);

  const size = useThree((state) => state.size);
  const anchor = size.width < 768 ? { x: 0.5, y: 0.34 } : { x: 0.63, y: 0.5 };
  const uniforms = useMemo(
    () => ({
      uResolution: { value: new THREE.Vector2(1, 1) },
      uCenter: { value: new THREE.Vector2(anchor.x, anchor.y) },
      uTime: { value: 0 },
      uRotation: { value: 0 },
      uReach: { value: new THREE.Vector2(0, 0) },
      uNear: { value: 0 },
      uAwake: { value: 0 },
      uBackground: { value: new THREE.Vector3(...palette.background) },
      uColor1: { value: new THREE.Vector3(...palette.color1) },
      uColor2: { value: new THREE.Vector3(...palette.color2) },
      uColor3: { value: new THREE.Vector3(...palette.color3) },
      uScale: { value: 1 / 0.98 },
      uWobble: { value: 1.0 },
      uGlow: { value: 1.6 },
      uBleed: { value: 1.25 },
      uHighlight: { value: 1.1 },
      uSwirl: { value: 0 },
      uOrbit: { value: 0 },
      uEcho: { value: new THREE.Vector2(0, 0) },
      uReveal: { value: 0 },
      uOpacity: { value: 1 },
      uTrail: { value: 0.85 },
      uTilt: { value: new THREE.Vector2(0, 0) },
    }),
    [palette],
  );

  const geometry = useMemo(() => {
    // One fullscreen triangle in clip space (upstream's [-1,-1, 3,-1, -1,3]).
    const g = new THREE.BufferGeometry();
    g.setAttribute(
      'position',
      new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3),
    );
    return g;
  }, []);
  useEffect(() => () => geometry.dispose(), [geometry]);

  useFrame((_, deltaSeconds) => {
    const mat = material.current;
    if (mat === null) return;
    // Dissolve drives the orb away while fragments erupt (upstream intro
    // played backwards: swell + fade).
    let dissolve = 0;
    if (phase === 'fragments') {
      dissolve = Math.min(1, (performance.now() - phaseEnteredAtMs) / (fragmentsMs * 0.78));
    } else if (phase === 'pitch_reveal' || phase === 'ready' || phase === 'fallback') {
      dissolve = 1;
    }
    driver.setDissolve(dissolve);
    driver.update(
      deltaSeconds,
      {
        size: 0.98,
        speed: 0.5,
        hoverIntensity: 0.55,
        motion: reducedMotion ? 0.15 : 1,
        sizePulse: 0,
      },
      pointer.current,
      { width: size.width, height: size.height },
      anchor,
    );
    const values = driver.uniforms({
      size: 0.98,
      glow: 1.6,
      bleed: 1.25,
      wobble: 1.0,
      highlight: 1.1,
      trail: 0.9,
      hoverIntensity: 0.55,
      opacity: 1,
    });
    for (const [key, value] of Object.entries(values)) {
      const uniform = mat.uniforms[key];
      if (uniform === undefined) continue;
      if (Array.isArray(value)) {
        (uniform.value as THREE.Vector2).set(value[0]!, value[1]!);
      } else {
        uniform.value = value;
      }
    }
    mat.uniforms.uResolution!.value.set(size.width * dpr, size.height * dpr);
    mat.uniforms.uCenter!.value.set(anchor.x, anchor.y);
    if (mesh.current !== null) mesh.current.visible = dissolve < 0.999;
  });

  return (
    <mesh ref={mesh} geometry={geometry} frustumCulled={false} renderOrder={-1000}>
      <shaderMaterial
        ref={material}
        args={[
          {
            vertexShader: ORB_VERTEX,
            fragmentShader: ORB_FRAGMENT,
            uniforms,
            glslVersion: THREE.GLSL3,
            transparent: true,
            depthTest: false,
            depthWrite: false,
          },
        ]}
      />
    </mesh>
  );
}

// ---------------------------------------------------------------------------
// The fragment field — one InstancedMesh, deterministic bezier flights.
function FragmentField({
  field,
  phase,
  phaseEnteredAtMs,
  fragmentsMs,
}: {
  field: LandingFieldSpec;
  phase: LandingPhase;
  phaseEnteredAtMs: number;
  fragmentsMs: number;
}) {
  const meshRef = useRef<THREE.InstancedMesh>(null);
  const materialRef = useRef<THREE.MeshBasicMaterial>(null);
  const count = field.fragments.length;
  const dummy = useMemo(() => new THREE.Object3D(), []);
  const color = useMemo(() => new THREE.Color(), []);

  // Per-instance colors set once per field.
  useEffect(() => {
    const mesh = meshRef.current;
    if (mesh === null) return;
    for (let i = 0; i < count; i += 1) {
      const f = field.fragments[i]!;
      color.setRGB(
        Math.min(1, f.color[0] * 1.35),
        Math.min(1, f.color[1] * 1.35),
        Math.min(1, f.color[2] * 1.35),
      );
      mesh.setColorAt(i, color);
    }
    if (mesh.instanceColor !== null) mesh.instanceColor.needsUpdate = true;
  }, [field, count, color]);

  const easeOut = (t: number): number => 1 - Math.pow(1 - t, 3);

  useFrame(() => {
    const mesh = meshRef.current;
    if (mesh === null) return;
    const active = phase === 'fragments' || phase === 'pitch_reveal';
    mesh.visible = active;
    if (!active) return;
    const elapsed = performance.now() - phaseEnteredAtMs;
    for (let i = 0; i < count; i += 1) {
      const f = field.fragments[i]!;
      const p =
        phase === 'pitch_reveal'
          ? 1
          : Math.min(1, Math.max(0, (elapsed - f.delayMs) / f.durationMs));
      const e = easeOut(p);
      const u = 1 - e;
      // Quadratic bezier origin → control → target.
      dummy.position.set(
        u * u * f.origin[0] + 2 * u * e * f.control[0] + e * e * f.target[0],
        u * u * f.origin[1] + 2 * u * e * f.control[1] + e * e * f.target[1],
        u * u * f.origin[2] + 2 * u * e * f.control[2] + e * e * f.target[2],
      );
      dummy.scale.setScalar(f.sizeM * (0.8 + 1.5 * e));
      dummy.rotation.set(e * 2.2, e * 1.4, 0);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (materialRef.current !== null) {
      // During the reveal the dust gently settles into the line work.
      const settle =
        phase === 'pitch_reveal' ? Math.max(0.35, 1 - elapsed / (fragmentsMs * 0.5)) : 1;
      materialRef.current.opacity = settle;
    }
  });

  return (
    <instancedMesh
      ref={meshRef}
      args={[undefined, undefined, count]}
      frustumCulled={false}
      visible={false}
    >
      <icosahedronGeometry args={[1, 0]} />
      <meshBasicMaterial
        ref={materialRef}
        transparent
        opacity={1}
        blending={THREE.AdditiveBlending}
        depthWrite={false}
        toneMapped={false}
      />
    </instancedMesh>
  );
}

// ---------------------------------------------------------------------------
// Luminous line work — THREE primitives (JSX <line> collides with SVG types,
// the KYN-08 lesson) with progressive drawRange reveal.
interface OwnedLine {
  readonly object: THREE.Line | THREE.LineLoop;
  readonly geometry: THREE.BufferGeometry;
  readonly material: THREE.LineBasicMaterial;
  readonly closed: boolean;
}

function ownedLine(points: readonly Vec3[], closed: boolean, color: string): OwnedLine {
  const geometry = new THREE.BufferGeometry().setFromPoints(
    points.map((p) => new THREE.Vector3(...p)),
  );
  const material = new THREE.LineBasicMaterial({
    color,
    transparent: true,
    opacity: 0,
    depthWrite: false,
    toneMapped: false,
  });
  const object = closed
    ? new THREE.LineLoop(geometry, material)
    : new THREE.Line(geometry, material);
  return { object, geometry, material, closed };
}

function disposeOwnedLines(lines: readonly OwnedLine[]): void {
  for (const line of lines) {
    line.geometry.dispose();
    line.material.dispose();
  }
}

// ---------------------------------------------------------------------------
// The reveal — the REAL stadium plus line work and checkpoint markers.
function RevealScene({
  field,
  phase,
  phaseEnteredAtMs,
  revealMs,
  reducedMotion,
}: {
  field: LandingFieldSpec;
  phase: LandingPhase;
  phaseEnteredAtMs: number;
  revealMs: number;
  reducedMotion: boolean;
}) {
  const mounted = phase === 'fragments' || phase === 'pitch_reveal' || phase === 'ready';
  const group = useRef<THREE.Group>(null);
  const revealProgress = (): number => {
    if (phase !== 'pitch_reveal' && phase !== 'ready') return 0;
    if (reducedMotion) return 1;
    return Math.min(1, (performance.now() - phaseEnteredAtMs) / revealMs);
  };

  const lines = useMemo(() => {
    const built: OwnedLine[] = [
      ownedLine(field.pitchOutline, true, '#51D7BD'),
      ownedLine(field.halfwayLine, false, '#51D7BD'),
      ownedLine(field.centreCircle, true, '#51D7BD'),
      ...field.trajectories.map((t) =>
        ownedLine(t.points, false, t.role === 'runner' ? '#F6BA77' : '#8FF0DA'),
      ),
    ];
    return built;
  }, [field]);
  useEffect(() => () => disposeOwnedLines(lines), [lines]);

  const markersRef = useRef<THREE.InstancedMesh>(null);
  const markerDummy = useMemo(() => new THREE.Object3D(), []);
  const markersCount = field.checkpointMarkers.length;
  useEffect(() => {
    const mesh = markersRef.current;
    if (mesh === null) return;
    field.checkpointMarkers.forEach((marker, i) => {
      markerDummy.position.set(marker.position[0], marker.position[1], marker.position[2]);
      markerDummy.scale.setScalar(marker.entityId === 'ball' ? 0.55 : 0.8);
      markerDummy.updateMatrix();
      mesh.setMatrixAt(i, markerDummy.matrix);
    });
    mesh.instanceMatrix.needsUpdate = true;
  }, [field, markerDummy]);

  useFrame(() => {
    // The reveal BEAT: the stadium stays invisible while fragments fly —
    // it materializes only as the fragment field resolves (pitch_reveal).
    if (group.current !== null) {
      group.current.visible = phase === 'pitch_reveal' || phase === 'ready';
    }
    const p = revealProgress();
    for (const line of lines) {
      const total = line.closed
        ? line.geometry.getAttribute('position').count
        : line.geometry.getAttribute('position').count - 1;
      line.geometry.setDrawRange(0, Math.max(2, Math.ceil(total * p) + 1));
      line.material.opacity =
        (line.material.color.getHex() === 0xf6ba77 ? 0.55 : 0.8) * Math.min(1, p * 1.5);
    }
  });
  if (!mounted) return null;

  return (
    <group ref={group}>
      <Stadium />
      <StadiumLights />
      {lines.map((line, i) => (
        <primitive key={i} object={line.object} />
      ))}
      <instancedMesh
        ref={markersRef}
        args={[undefined, undefined, markersCount]}
        frustumCulled={false}
      >
        <sphereGeometry args={[1, 10, 8]} />
        <meshBasicMaterial
          color="#C6F9E7"
          transparent
          opacity={0.5}
          depthWrite={false}
          toneMapped={false}
        />
      </instancedMesh>
      <ambientLight intensity={0.55} />
    </group>
  );
}

// ---------------------------------------------------------------------------
// Phase-completion clock + QA probe.
function PhaseClock({
  phase,
  phaseEnteredAtMs,
  introMs,
  fragmentsMs,
  revealMs,
  onPhaseComplete,
}: {
  phase: LandingPhase;
  phaseEnteredAtMs: number;
  introMs: number;
  fragmentsMs: number;
  revealMs: number;
  onPhaseComplete: (phase: 'intro' | 'fragments' | 'pitch_reveal') => void;
}) {
  const lastFired = useRef(0);
  useFrame(() => {
    if (phase === 'intro' || phase === 'fragments' || phase === 'pitch_reveal') {
      const now = performance.now();
      const elapsed = now - phaseEnteredAtMs;
      const budget = phase === 'intro' ? introMs : phase === 'fragments' ? fragmentsMs : revealMs;
      // Re-fire while held (the FSM holds pitch_reveal until assets are
      // ready); redundant dispatches are no-ops in the pure reducer.
      if (elapsed >= budget && now - lastFired.current > 400) {
        lastFired.current = now;
        onPhaseComplete(phase);
      }
    }
  });
  return null;
}

function LandingProbe({
  phase,
  field,
  onContextLost,
}: {
  phase: LandingPhase;
  field: LandingFieldSpec;
  onContextLost: () => void;
}) {
  const gl = useThree((state) => state.gl);
  const frames = useRef<number[]>([]);
  const phaseRef = useRef(phase);
  phaseRef.current = phase;

  useEffect(() => {
    const canvas = gl.domElement;
    const onLost = (event: Event): void => {
      event.preventDefault();
      onContextLost();
    };
    canvas.addEventListener('webglcontextlost', onLost);
    const hook = window as unknown as Record<string, unknown>;
    hook['__kyneloomLanding'] = {
      state: (): string => phaseRef.current,
      fragmentCount: (): number => field.fragments.length,
      markerCount: (): number => field.checkpointMarkers.length,
    };
    return () => {
      canvas.removeEventListener('webglcontextlost', onLost);
      delete hook['__kyneloomLanding'];
      delete hook['__kyneloomLandingPerf'];
    };
  }, [gl, field, onContextLost]);

  useFrame((_, deltaSeconds) => {
    const framesBuffer = frames.current;
    framesBuffer.push(deltaSeconds * 1000);
    if (framesBuffer.length > 180) framesBuffer.shift();
    if (framesBuffer.length >= 8) {
      const sorted = [...framesBuffer].sort((a, b) => a - b);
      const mean = framesBuffer.reduce((total, v) => total + v, 0) / framesBuffer.length;
      const hook = window as unknown as Record<string, unknown>;
      hook['__kyneloomLandingPerf'] = {
        fps: Math.round(1000 / mean),
        p50Ms: Number(sorted[Math.floor(sorted.length * 0.5)]?.toFixed(2)),
        p95Ms: Number(sorted[Math.floor(sorted.length * 0.95)]?.toFixed(2)),
        drawCalls: gl.info.render.calls,
        triangles: gl.info.render.triangles,
        geometries: gl.info.memory.geometries,
        textures: gl.info.memory.textures,
        samples: framesBuffer.length,
      };
    }
  });
  return null;
}

// ---------------------------------------------------------------------------

export function OrbField({
  phase,
  phaseEnteredAtMs,
  field,
  introMs,
  fragmentsMs,
  revealMs,
  reducedMotion,
  onPhaseComplete,
  onFail,
}: OrbFieldProps) {
  return (
    <Canvas
      dpr={[1, 1.75]}
      camera={{ fov: 46, position: POSES.idle.position, near: 0.5, far: 520 }}
      gl={{ antialias: true, alpha: false, powerPreference: 'high-performance' }}
      onCreated={({ gl }) => {
        gl.toneMapping = THREE.ACESFilmicToneMapping;
        gl.toneMappingExposure = 1.05;
        gl.setClearColor('#071319', 1);
      }}
      className="landing__canvas"
      aria-hidden="true"
    >
      {/* Editorial-depth fog matching the cinematic ink. */}
      <fog attach="fog" args={['#071319', 90, 320]} />
      <OrbQuad
        phase={phase}
        phaseEnteredAtMs={phaseEnteredAtMs}
        fragmentsMs={fragmentsMs}
        reducedMotion={reducedMotion}
      />
      <FragmentField
        field={field}
        phase={phase}
        phaseEnteredAtMs={phaseEnteredAtMs}
        fragmentsMs={fragmentsMs}
      />
      <RevealScene
        field={field}
        phase={phase}
        phaseEnteredAtMs={phaseEnteredAtMs}
        revealMs={revealMs}
        reducedMotion={reducedMotion}
      />
      <LandingCamera phase={phase} reducedMotion={reducedMotion} />
      <PhaseClock
        phase={phase}
        phaseEnteredAtMs={phaseEnteredAtMs}
        introMs={introMs}
        fragmentsMs={fragmentsMs}
        revealMs={revealMs}
        onPhaseComplete={onPhaseComplete}
      />
      <LandingProbe phase={phase} field={field} onContextLost={() => onFail('context-lost')} />
    </Canvas>
  );
}
