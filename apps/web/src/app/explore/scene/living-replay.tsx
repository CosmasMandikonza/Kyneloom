'use client';

import { Component, Suspense, useEffect, useRef, useState, type ReactNode } from 'react';
import * as THREE from 'three';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { useProgress } from '@react-three/drei';
import { detectSceneCapabilities } from '@kyneloom/scene-renderer';
import {
  SceneRuntimeContext,
  useSceneRuntime,
  type CameraMode,
  type SceneRuntime,
} from './scene-context';
import { Stadium, StadiumLights } from './stadium';
import { Ball } from './ball';
import { Footballers } from './footballers';
import { CameraRig } from './camera-rig';
import { Fallback2D } from './fallback-2d';
import { registerVisualProbe, sceneVisual } from './visual-debug';
import { registerXrayProbe } from './xray-overlay';

/**
 * LivingReplayCanvas (KYN-06): the real WebGL scene mounted into the
 * KYN-05 stage's [data-scene-mount] region.
 *
 * Failure contract: no WebGL context, context loss mid-session, or a thrown
 * asset error degrades to the 2D tactical view on the SAME timeline — the
 * fan never gets an empty black stage or a crash.
 */

export type SceneQuality = 'high' | 'low';

export function LivingReplayCanvas({
  runtime,
  cameraMode,
  quality,
  children,
}: {
  runtime: SceneRuntime;
  cameraMode: CameraMode;
  quality: SceneQuality;
  /** Optional overlay children (Evidence X-Ray) rendered inside the scene. */
  children?: React.ReactNode;
}) {
  const [failure, setFailure] = useState<
    'webgl-unavailable' | 'context-lost' | 'asset-error' | null
  >(null);
  const capabilities = useRef(detectSceneCapabilities());

  useEffect(() => {
    if (!capabilities.current.webgl) setFailure('webgl-unavailable');
  }, [setFailure]);

  // EVERY failure reason degrades to the same-timeline 2D view — including
  // asset errors. Rendering null here would leave a blank stage, exactly
  // what the failure contract forbids.
  if (failure !== null) {
    return <Fallback2D runtime={runtime} reason={failure} />;
  }

  return (
    <SceneErrorBoundary onAssetError={() => setFailure('asset-error')}>
      <Canvas
        shadows={quality === 'high'}
        dpr={[1, quality === 'high' ? 2 : 1.25]}
        camera={{ fov: 46, position: [0, 38, 52], near: 0.5, far: 520 }}
        gl={{ antialias: true, powerPreference: 'high-performance' }}
        onCreated={({ gl }) => {
          gl.toneMapping = THREE.ACESFilmicToneMapping;
          gl.toneMappingExposure = 1.08;
          gl.domElement.addEventListener('webglcontextlost', (event) => {
            event.preventDefault();
            setFailure('context-lost');
          });
        }}
        className="living-replay__canvas"
        aria-label="3D Living Replay scene"
        role="img"
      >
        <SceneRuntimeContext.Provider value={runtime}>
          <StadiumLights />
          <Stadium />
          <Suspense fallback={null}>
            <Footballers />
            <Ball />
          </Suspense>
          <CameraRig mode={cameraMode} />
          {children}
          <ProjectionProbe />
          <PerfProbe />
          <QaHook />
        </SceneRuntimeContext.Provider>
      </Canvas>
      <SceneLoadingChip />
    </SceneErrorBoundary>
  );
}

/** DOM loading chip driven by drei's global progress store. */
function SceneLoadingChip() {
  const { active, progress } = useProgress();
  if (!active) return null;
  return (
    <div className="stage__loading" role="status">
      <span className="mono">LOADING SCENE · {Math.round(progress)}%</span>
    </div>
  );
}

class SceneErrorBoundary extends Component<
  { children: ReactNode; onAssetError: () => void },
  { failed: boolean }
> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override componentDidCatch() {
    this.props.onAssetError();
  }
  override render() {
    if (this.state.failed) return null;
    return this.props.children;
  }
}

/** Registers the live camera projection into the visual probe. */
function ProjectionProbe() {
  const gl = useThree((state) => state.gl);
  const camera = useThree((state) => state.camera);
  useEffect(() => {
    return registerVisualProbe('projection', {
      projectWorld: (x, y, z) => {
        const canvas = gl.domElement;
        const vector = new THREE.Vector3(x, y, z);
        vector.project(camera);
        if (vector.z > 1) return null; // behind the camera
        return [
          ((vector.x + 1) / 2) * canvas.clientWidth,
          ((1 - vector.y) / 2) * canvas.clientHeight,
        ];
      },
    });
  }, [gl, camera]);
  return null;
}

/** Frame-time probe: measured, not guessed (docs/08, docs/19). */
function PerfProbe() {
  const gl = useThree((state) => state.gl);
  const samples = useRef<number[]>([]);

  useFrame((_, deltaSeconds) => {
    const frames = samples.current;
    frames.push(deltaSeconds * 1000); // R3F deltas are seconds; store ms.
    if (frames.length > 240) frames.shift();
    // Publish early and on every frame so QA on software renderers
    // (SwiftShader headless runs at ~1-2 fps) still gets honest partial
    // numbers; `samples` discloses how many frames back the stats cover.
    if (frames.length >= 8) {
      const sorted = [...frames].sort((a, b) => a - b);
      const mean = frames.reduce((total, value) => total + value, 0) / frames.length;
      const info = gl.info;
      const hook = window as unknown as Record<string, unknown>;
      hook['__kyneloomPerf'] = {
        fps: Math.round(1000 / mean),
        p50Ms: Number(sorted[Math.floor(sorted.length * 0.5)]?.toFixed(2)),
        p95Ms: Number(sorted[Math.floor(sorted.length * 0.95)]?.toFixed(2)),
        drawCalls: info.render.calls,
        triangles: info.render.triangles,
        geometries: info.memory.geometries,
        textures: info.memory.textures,
        samples: frames.length,
      };
    }
  });
  return null;
}

/**
 * Clearly-labeled QA/debug hook (not user-facing): exposes the AUTHORITATIVE
 * world snapshot so Playwright can assert camera-independence and exact
 * checkpoint positions without touching pixels.
 */
function QaHook() {
  const runtime = useSceneRuntime();
  useEffect(() => {
    const hook = window as unknown as Record<string, unknown>;
    const visual = sceneVisual();
    // Evidence X-Ray probe: reads the overlay's live state so Playwright
    // can assert the REAL rendered overlays, not just React props.
    const xrayProbe = registerXrayProbe();
    hook['__kyneloomXray'] = xrayProbe;
    hook['__kyneloomScene'] = {
      playheadMs: (): number => runtime.engine.playheadMs,
      // Rendered Three.js object poses (mesh roots, camera) for Playwright
      // assertions that go beyond the source-data snapshot.
      visual: {
        ballWorldPosition: (): unknown => visual.ballWorldPosition?.() ?? null,
        ballQuaternion: (): unknown => visual.ballQuaternion?.() ?? null,
        playerYaw: (entityId: string): unknown => visual.playerYaw?.(entityId) ?? null,
        cameraWorldPosition: (): unknown => visual.cameraWorldPosition?.() ?? null,
        cameraFov: (): unknown => visual.cameraFov?.() ?? null,
        cameraLookTarget: (): unknown => visual.cameraLookTarget?.() ?? null,
        projectWorld: (x: number, y: number, z: number): unknown =>
          visual.projectWorld?.(x, y, z) ?? null,
      },
      snapshot: (): unknown => {
        const frame = runtime.getFrame(runtime.engine.playheadMs);
        const players: unknown[] = [];
        for (const [entityId, sample] of frame.positions) {
          if (entityId === runtime.scene.ballEntityId) continue;
          players.push({
            entityId,
            xM: sample.xM,
            yM: sample.yM,
            zM: sample.zM,
            exact: sample.exact,
            origin: sample.origin,
          });
        }
        const ballSample = frame.positions.get(runtime.scene.ballEntityId);
        return {
          playheadMs: runtime.engine.playheadMs,
          players,
          ball: ballSample
            ? {
                xM: ballSample.xM,
                yM: ballSample.yM,
                zM: ballSample.zM,
                exact: ballSample.exact,
                origin: ballSample.origin,
              }
            : null,
          missing: [...frame.missingEntityIds],
        };
      },
    };
    return () => {
      delete hook['__kyneloomScene'];
      delete hook['__kyneloomXray'];
    };
  }, [runtime]);
  return null;
}
