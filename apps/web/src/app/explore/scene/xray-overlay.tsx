'use client';

import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { pitchToThree } from '@kyneloom/contracts';
import type { EvidenceProjection } from '@/lib/evidence-data';
import { useSceneRuntime } from './scene-context';

/**
 * Evidence X-Ray 3D overlays (KYN-08): world-anchored geometry on the SAME
 * playheadMs, entity identities and pitchToThree transform as the scene —
 * camera mode changes only change how the truth is seen, never what it is.
 *
 * Source-quality grammar (docs/17):
 * - synthetic/exact evidence → SOLID mint lines and dots;
 * - interpolated reconstruction → DOTTED (never drawn for the separation,
 *   whose endpoints must be exact — an interpolated endpoint downgrades the
 *   whole measurement before it can render);
 * - tactical hypothesis → DASHED AMBER (the decoy trail reads as movement,
 *   not as a verified cause);
 * - missing/unverified → NOTHING on the pitch plus a textual reason.
 */

const MINT = '#51d7bd';
const AMBER = '#f6ba77';
const LABEL_Y_M = 2.6;

export type XrayPhase = 'before' | 'after' | 'both';

/** QA probe over the LIVE overlay state (registered once per canvas). */
export interface XrayProbe {
  active(): boolean;
  phase(): XrayPhase | null;
  visibleLineCount(): number;
  labelVisible(): boolean;
}

export function registerXrayProbe(): XrayProbe {
  const state = { active: false, phase: null as XrayPhase | null, lines: 0, label: false };
  xrayProbeState = state;
  return {
    active: () => state.active,
    phase: () => state.phase,
    visibleLineCount: () => state.lines,
    labelVisible: () => state.label,
  };
}

/** Mutable telemetry the overlay writes each frame (module-singleton). */
export let xrayProbeState: {
  active: boolean;
  phase: XrayPhase | null;
  lines: number;
  label: boolean;
} | null = null;

export interface XrayState {
  readonly active: boolean;
  readonly phase: XrayPhase;
}

export function XrayOverlay({
  evidence,
  state,
}: {
  evidence: EvidenceProjection;
  state: XrayState;
}) {
  const { engine, getFrame } = useSceneRuntime();
  const beforeLine = useRef<THREE.Line>(null);
  const afterLine = useRef<THREE.Line>(null);
  const labelRef = useRef<THREE.Sprite>(null);
  const trailRef = useRef<THREE.Line>(null);
  const emphasisRef = useRef<THREE.Mesh[]>([]);

  // Static, evidence-derived geometry (built once per projection):
  // separation lines at both endpoints, the runner trail, and per-frame
  // emphasis rings. Coordinates flow through pitchToThree like every actor.
  const geometry = useMemo(() => {
    if (!state.active || evidence.status !== 'verified') return null;
    const byTime = (tMs: number) => {
      const poses = evidence.endpoints.filter((e) => Math.abs(tOf(e) - tMs) < 1);
      return poses;
    };
    const before = byTime(evidence.evidence.fromMs);
    const after = byTime(evidence.evidence.toMs);
    if (before.length !== 2 || after.length !== 2) return null;
    const line = (pair: typeof before): [THREE.Vector3, THREE.Vector3] => {
      const d = pair.find((e) => e.entityId === evidence.evidence.defenderId)!;
      const st = pair.find((e) => e.entityId === evidence.evidence.strikerId)!;
      return [
        new THREE.Vector3(...pitchToThree({ xM: d.xM, yM: d.yM, zM: 0 })),
        new THREE.Vector3(...pitchToThree({ xM: st.xM, yM: st.yM, zM: 0 })),
      ];
    };
    const trail = evidence.runnerTrail.map(
      (s) => new THREE.Vector3(...pitchToThree({ xM: s.xM, yM: s.yM, zM: 0.04 })),
    );
    return {
      before: line(before),
      after: line(after),
      trail,
      fromMs: evidence.evidence.fromMs,
      toMs: evidence.evidence.toMs,
    };
  }, [state.active, evidence]);

  const labelTexture = useMemo(() => {
    if (!state.active || evidence.status !== 'verified') return null;
    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 96;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = 'rgba(7,19,25,0.82)';
    roundRect(ctx, 4, 8, 504, 80, 18);
    ctx.fill();
    ctx.strokeStyle = MINT;
    ctx.lineWidth = 2;
    roundRect(ctx, 4, 8, 504, 80, 18);
    ctx.stroke();
    ctx.fillStyle = '#eafffa';
    ctx.font = '600 34px ui-monospace, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const e = evidence.evidence;
    ctx.fillText(
      `${e.separationBeforeM.toFixed(3)} m → ${e.separationAfterM.toFixed(3)} m`,
      256,
      50,
    );
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    return texture;
  }, [state.active, evidence]);

  useFrame(() => {
    const show = geometry !== null;
    if (xrayProbeState !== null) {
      xrayProbeState.active = state.active && show;
      xrayProbeState.phase = state.active && show ? state.phase : null;
      xrayProbeState.lines = 0;
      xrayProbeState.label = false;
    }
    for (const ref of [beforeLine, afterLine]) {
      if (ref.current !== null) ref.current.visible = show;
    }
    if (trailRef.current !== null) trailRef.current.visible = show;
    if (labelRef.current !== null) labelRef.current.visible = show;
    for (const ring of emphasisRef.current) ring.visible = show;
    if (!show || geometry === null) return;

    // Phase gating: 'before' shows only the fromMs state, 'after' only the
    // toMs state, 'both' shows them together for comparison.
    let visibleLines = 0;
    if (beforeLine.current !== null) {
      beforeLine.current.visible = state.phase !== 'after';
      if (beforeLine.current.visible) visibleLines += 1;
    }
    if (afterLine.current !== null) {
      afterLine.current.visible = state.phase !== 'before';
      if (afterLine.current.visible) visibleLines += 1;
    }
    if (trailRef.current !== null && trailRef.current.visible) visibleLines += 1;
    if (xrayProbeState !== null) xrayProbeState.lines = visibleLines;

    // Emphasis rings track the LIVE positions of the three actors at the
    // current playhead (selection emphasis without touching anything).
    const snapshot = getFrame(engine.playheadMs);
    const ids = [
      evidence.status === 'verified' ? evidence.evidence.defenderId : null,
      evidence.status === 'verified' ? evidence.evidence.strikerId : null,
      'home-11',
    ];
    let ringIndex = 0;
    for (const id of ids) {
      if (id === null) continue;
      const ring = emphasisRef.current[ringIndex];
      ringIndex += 1;
      if (ring === undefined) continue;
      const sample = snapshot.positions.get(id);
      ring.visible = sample !== undefined;
      if (sample !== undefined) {
        const [x, , z] = pitchToThree({ xM: sample.xM, yM: sample.yM, zM: sample.zM });
        ring.position.set(x, 0.05, z);
      }
    }

    // Label floats above the measurement midpoint of the visible phase.
    if (labelRef.current !== null && labelTexture !== null) {
      if (xrayProbeState !== null) xrayProbeState.label = labelRef.current.visible;
      const source =
        state.phase === 'before'
          ? geometry.before
          : state.phase === 'after'
            ? geometry.after
            : geometry.after;
      labelRef.current.position.set(
        (source[0].x + source[1].x) / 2,
        LABEL_Y_M,
        (source[0].z + source[1].z) / 2,
      );
    }
  });

  if (geometry === null) return null;

  const solid = new THREE.LineBasicMaterial({ color: MINT, transparent: true, opacity: 0.95 });
  const dashed = new THREE.LineDashedMaterial({
    color: AMBER,
    dashSize: 0.9,
    gapSize: 0.55,
    transparent: true,
    opacity: 0.9,
  });

  const lineObject = (
    points: readonly THREE.Vector3[],
    material: THREE.Material,
    computeLineDistances: boolean,
  ): THREE.Line => {
    const geometryOut = new THREE.BufferGeometry().setFromPoints([...points]);
    const line = new THREE.Line(geometryOut, material);
    if (computeLineDistances) line.computeLineDistances();
    return line;
  };

  return (
    <group>
      {/*
        Separation at fromMs — SOLID mint: exact synthetic evidence.
        Separation at toMs — SOLID mint.
        Decoy trail — DASHED AMBER: tactical hypothesis grounded in real
        samples (docs/17 source-quality grammar).
      */}
      <primitive object={lineObject(geometry.before, solid, false)} ref={beforeLine} />
      <primitive object={lineObject(geometry.after, solid.clone(), false)} ref={afterLine} />
      <primitive object={lineObject(geometry.trail, dashed, true)} ref={trailRef} />
      {labelTexture !== null ? (
        <sprite ref={labelRef} scale={[14, 2.6, 1]}>
          <spriteMaterial map={labelTexture} depthTest={false} transparent />
        </sprite>
      ) : null}
      {/* Live emphasis rings (defender, striker, winger). */}
      {[0, 1, 2].map((i) => (
        <mesh
          key={i}
          ref={(node) => {
            if (node !== null) emphasisRef.current[i] = node;
          }}
          rotation={[-Math.PI / 2, 0, 0]}
          visible={false}
        >
          <ringGeometry args={[0.85, 1.15, 40]} />
          <meshBasicMaterial
            color={i === 2 ? AMBER : MINT}
            transparent
            opacity={0.9}
            depthWrite={false}
          />
        </mesh>
      ))}
    </group>
  );
}

function tOf(endpoint: { sourceFrameId: string }): number {
  return Number(endpoint.sourceFrameId.replace(/^frame-/, '')) * 100;
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
