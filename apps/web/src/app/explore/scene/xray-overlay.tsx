'use client';

import { useEffect, useMemo, useRef } from 'react';
import { useFrame, type ThreeEvent } from '@react-three/fiber';
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
 *
 * Interaction (review gate 3): the separation geometry is itself the
 * affordance — adequately sized invisible hit boxes along both measured
 * lines (and the label) open the evidence inspector on pointer/touch down
 * without disturbing selection. The X-Ray / Show evidence buttons and the
 * X/I keys remain the accessible alternatives.
 *
 * Resource lifetimes (review gate 4): every THREE object this component
 * OWNS (line geometries, materials, the label texture) is created ONCE per
 * evidence/active change in a memo and disposed in the matching effect
 * cleanup — repeated toggling and phase switching stay allocation-free and
 * the WebGL geometry/texture counts remain bounded.
 */

/** DOM bridge event: the measured geometry was clicked/tapped. */
export const SCENE_OPEN_INSPECTOR_EVENT = 'kyneloom:xray-open-inspector';

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
  /**
   * Canvas-space CSS px candidate click targets along the primary visible
   * measured line (several points, because floating UI can legitimately
   * occlude part of the geometry on narrow viewports) — canvas-internal
   * coordinates, callers add the canvas offset.
   */
  hitTargetsScreen(): { x: number; y: number }[];
  /** Canvas-space CSS px endpoint pairs of every visible measured line. */
  hitSegmentsScreen(): { x1: number; y1: number; x2: number; y2: number }[];
}

export function registerXrayProbe(): XrayProbe {
  const state: XrayProbeState = {
    active: false,
    phase: null,
    lines: 0,
    label: false,
    hits: [],
    segments: [],
  };
  xrayProbeState = state;
  return {
    active: () => state.active,
    phase: () => state.phase,
    visibleLineCount: () => state.lines,
    labelVisible: () => state.label,
    hitTargetsScreen: () => state.hits.map((h) => ({ x: h.x, y: h.y })),
    hitSegmentsScreen: () =>
      state.segments.map((seg) => ({ x1: seg.x1, y1: seg.y1, x2: seg.x2, y2: seg.y2 })),
  };
}

interface XrayProbeState {
  active: boolean;
  phase: XrayPhase | null;
  lines: number;
  label: boolean;
  hits: { x: number; y: number }[];
  segments: { x1: number; y1: number; x2: number; y2: number }[];
}

/** Mutable telemetry the overlay writes each frame (module-singleton). */
export let xrayProbeState: XrayProbeState | null = null;

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

  // Owned GPU resources, created once per (active × evidence) change. The
  // two separation lines SHARE one solid material; the trail owns the
  // dashed one; the label owns its CanvasTexture. Everything is disposed in
  // the effect cleanup below — nothing is recreated per render.
  const assets = useMemo(() => {
    if (!state.active || evidence.status !== 'verified') return null;
    const byTime = (tMs: number) => evidence.endpoints.filter((e) => Math.abs(tOf(e) - tMs) < 1);
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
    const trailPts = evidence.runnerTrail.map(
      (s) => new THREE.Vector3(...pitchToThree({ xM: s.xM, yM: s.yM, zM: 0.04 })),
    );
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
      const geometry = new THREE.BufferGeometry().setFromPoints([...points]);
      const object = new THREE.Line(geometry, material);
      if (computeLineDistances) object.computeLineDistances();
      return object;
    };
    return {
      before: line(before),
      after: line(after),
      trailPts,
      beforeLine: lineObject(line(before), solid, false),
      afterLine: lineObject(line(after), solid, false),
      trail: lineObject(trailPts, dashed, true),
      materials: [solid, dashed] as const,
      labelTexture: drawLabelTexture(evidence),
    };
  }, [state.active, evidence]);

  // Dispose every OWNED resource when the assets change or the overlay
  // unmounts (toggle off/on, evidence swap, scene teardown).
  useEffect(() => {
    return () => {
      if (assets === null) return;
      assets.beforeLine.geometry.dispose();
      assets.afterLine.geometry.dispose();
      assets.trail.geometry.dispose();
      for (const material of assets.materials) material.dispose();
      assets.labelTexture.dispose();
    };
  }, [assets]);

  const openFromScene = (event: ThreeEvent<PointerEvent>): void => {
    event.stopPropagation(); // never let the click also re-select a player
    // Scene→inspector goes through a DOM CustomEvent: the R3F canvas runs in
    // its own reconciler root, and state updates called straight from its
    // raw pointer listeners do not reliably commit for touch input. The
    // window event lands in a normal DOM listener in the stage, which is
    // provably committed for every input path (mouse, touch, keyboard).
    // Deferred out of the R3F dispatch context: state updates raised
    // synchronously inside the canvas's raw touch pipeline do not commit.
    window.setTimeout(() => {
      window.dispatchEvent(new CustomEvent(SCENE_OPEN_INSPECTOR_EVENT));
    }, 0);
  };
  const hoverOn = (event: ThreeEvent<PointerEvent>): void => {
    event.stopPropagation();
    document.body.style.cursor = 'pointer';
  };
  const hoverOff = (): void => {
    document.body.style.cursor = '';
  };

  useFrame((frame) => {
    const show = assets !== null;
    if (xrayProbeState !== null) {
      xrayProbeState.active = state.active && show;
      xrayProbeState.phase = state.active && show ? state.phase : null;
      xrayProbeState.lines = 0;
      xrayProbeState.label = false;
      xrayProbeState.hits = [];
      xrayProbeState.segments = [];
    }
    for (const ref of [beforeLine, afterLine]) {
      if (ref.current !== null) ref.current.visible = show;
    }
    if (trailRef.current !== null) trailRef.current.visible = show;
    if (labelRef.current !== null) labelRef.current.visible = show;
    for (const ring of emphasisRef.current) ring.visible = show;
    if (!show || assets === null) return;

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
    if (labelRef.current !== null) {
      if (xrayProbeState !== null) xrayProbeState.label = labelRef.current.visible;
      const source = state.phase === 'before' ? assets.before : assets.after;
      labelRef.current.position.set(
        (source[0].x + source[1].x) / 2,
        LABEL_Y_M,
        (source[0].z + source[1].z) / 2,
      );
    }

    // Probe hit targets: canvas-space points along EVERY visible measured
    // line plus the floating label, so QA can click the REAL geometry with
    // actual pointer events and pick a point not occluded by floating UI
    // (which legitimately covers part of the pitch on some viewports).
    if (xrayProbeState !== null && visibleLines > 0) {
      const hits: { x: number; y: number }[] = [];
      const emit = (source: readonly [THREE.Vector3, THREE.Vector3], yM: number): void => {
        for (const t of [0.15, 0.35, 0.5, 0.65, 0.85]) {
          HIT_SCRATCH.set(
            source[0].x + (source[1].x - source[0].x) * t,
            yM,
            source[0].z + (source[1].z - source[0].z) * t,
          ).project(frame.camera);
          if (HIT_SCRATCH.z < 1) {
            hits.push({
              x: ((HIT_SCRATCH.x + 1) / 2) * frame.size.width,
              y: ((1 - HIT_SCRATCH.y) / 2) * frame.size.height,
            });
          }
        }
      };
      if (state.phase !== 'after') emit(assets.before, 0.7);
      if (state.phase !== 'before') emit(assets.after, 0.7);
      // Projected endpoint pairs of every visible measured line — the DOM
      // hit-test path (see replay-stage) matches pointer/touch input
      // against these segments.
      const segments: { x1: number; y1: number; x2: number; y2: number }[] = [];
      const emitSegment = (source: readonly [THREE.Vector3, THREE.Vector3]): void => {
        const pts: { x: number; y: number }[] = [];
        for (const point of source) {
          HIT_SCRATCH.set(point.x, 0.7, point.z).project(frame.camera);
          if (HIT_SCRATCH.z >= 1) return;
          pts.push({
            x: ((HIT_SCRATCH.x + 1) / 2) * frame.size.width,
            y: ((1 - HIT_SCRATCH.y) / 2) * frame.size.height,
          });
        }
        segments.push({ x1: pts[0]!.x, y1: pts[0]!.y, x2: pts[1]!.x, y2: pts[1]!.y });
      };
      if (state.phase !== 'after') emitSegment(assets.before);
      if (state.phase !== 'before') emitSegment(assets.after);
      xrayProbeState.segments = segments;
      // The label (a large clickable sprite) as the final candidate.
      HIT_SCRATCH.set(
        (assets.after[0].x + assets.after[1].x) / 2,
        LABEL_Y_M,
        (assets.after[0].z + assets.after[1].z) / 2,
      ).project(frame.camera);
      if (HIT_SCRATCH.z < 1) {
        hits.push({
          x: ((HIT_SCRATCH.x + 1) / 2) * frame.size.width,
          y: ((1 - HIT_SCRATCH.y) / 2) * frame.size.height,
        });
      }
      xrayProbeState.hits = hits;
    }
  });

  if (assets === null) return null;

  return (
    <group>
      {/*
        Separation at fromMs — SOLID mint: exact synthetic evidence.
        Separation at toMs — SOLID mint.
        Decoy trail — DASHED AMBER: tactical hypothesis grounded in real
        samples (docs/17 source-quality grammar).
      */}
      <primitive object={assets.beforeLine} ref={beforeLine} />
      <primitive object={assets.afterLine} ref={afterLine} />
      <primitive object={assets.trail} ref={trailRef} />
      <sprite
        ref={labelRef}
        scale={[14, 2.6, 1]}
        onPointerDown={openFromScene}
        onPointerOver={hoverOn}
        onPointerOut={hoverOff}
      >
        <spriteMaterial map={assets.labelTexture} depthTest={false} transparent />
      </sprite>
      {/* Click/tap affordances: adequately sized invisible boxes along both
          measured lines — the geometry itself opens the evidence inspector. */}
      <HitBox
        segment={assets.before}
        visible={state.phase !== 'after'}
        onPointerDown={openFromScene}
        onPointerOver={hoverOn}
        onPointerOut={hoverOff}
      />
      <HitBox
        segment={assets.after}
        visible={state.phase !== 'before'}
        onPointerDown={openFromScene}
        onPointerOver={hoverOn}
        onPointerOut={hoverOff}
      />
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

/** Invisible but raycastable box hugging a measured line segment. */
function HitBox({
  segment,
  visible,
  onPointerDown,
  onPointerOver,
  onPointerOut,
}: {
  segment: readonly [THREE.Vector3, THREE.Vector3];
  visible: boolean;
  onPointerDown: (event: ThreeEvent<PointerEvent>) => void;
  onPointerOver: (event: ThreeEvent<PointerEvent>) => void;
  onPointerOut: () => void;
}) {
  const [a, b] = segment;
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const lengthM = Math.max(Math.hypot(dx, dz), 3);
  return (
    <mesh
      position={[(a.x + b.x) / 2, 0.7, (a.z + b.z) / 2]}
      rotation={[0, -Math.atan2(dz, dx), 0]}
      scale={[lengthM, 1.6, 2.2]}
      visible={visible}
      onPointerDown={onPointerDown}
      onPointerOver={onPointerOver}
      onPointerOut={onPointerOut}
    >
      <boxGeometry args={[1, 1, 1]} />
      <meshBasicMaterial transparent opacity={0} depthWrite={false} />
    </mesh>
  );
}

function drawLabelTexture(
  evidence: Extract<EvidenceProjection, { status: 'verified' }>,
): THREE.CanvasTexture {
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
  ctx.fillText(`${e.separationBeforeM.toFixed(3)} m → ${e.separationAfterM.toFixed(3)} m`, 256, 50);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

const HIT_SCRATCH = new THREE.Vector3();

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
