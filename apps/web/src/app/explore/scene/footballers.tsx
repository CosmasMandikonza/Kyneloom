'use client';

import { useLayoutEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useFrame, type ThreeEvent } from '@react-three/fiber';
import { useGLTF } from '@react-three/drei';
import { clone as skeletonClone } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { pitchToThree } from '@kyneloom/contracts';
import { useSceneRuntime, type SelectionState } from './scene-context';

/**
 * The 22 rigged footballers (KYN-06 + KYN-30).
 *
 * One licensed skinned source model (Quaternius UAL mannequin, CC0 — see the
 * asset ledger) is cloned 22 times with THREE.SkeletonUtils.clone: geometry
 * and textures are shared, every actor owns an independent bone hierarchy
 * and its own AnimationMixer. World movement is AUTHORITY-ONLY: roots follow
 * timeline.sampleAt(playheadMs) exactly; clips animate the local rig and are
 * explicitly labeled reconstructed presentation (10 Hz tracking carries no
 * limb biomechanics). All clip state is a pure function of playheadMs, so
 * pause/seek/reset are frame-identical by construction.
 */

const MODEL_URL = '/models/footballer.glb';

/**
 * The source mannequin's rest pose faces local −z (glTF convention); a
 * player moving with heading θ (pitch-space atan2(dy, dx)) needs
 * rotation.y = atan2(dx, −dy) + this offset so the chest points downrun.
 */
const MODEL_FORWARD_OFFSET = Math.PI;

export interface KitColors {
  readonly shirt: string;
  readonly underlayer: string;
}

/** Fictional kits on the docs/03 palette. No real club marks. */
export const KITS: Record<'home' | 'away' | 'home-gk' | 'away-gk', KitColors> = {
  home: { shirt: '#d6f0e8', underlayer: '#12262e' },
  away: { shirt: '#d96a3c', underlayer: '#e8ecea' },
  'home-gk': { shirt: '#f6ba77', underlayer: '#10222b' },
  'away-gk': { shirt: '#ae98f7', underlayer: '#e8ecea' },
};

/** Locomotion clip bands by ground speed (m/s) — presentation choice. */
const SPEED_BANDS = {
  idle: 0.75,
  walk: 3.1,
  jog: 6.0,
} as const;

/** Kick windows anchored on fixture events: [startMs, endMs] per actor. */
interface KickWindow {
  readonly actorId: string;
  readonly startMs: number;
  readonly endMs: number;
  readonly peakWeight: number;
}

function kickWindowsFromEvents(
  events: readonly { eventId: string; kind: string; occurredAtMs: number; actorId: string }[],
): KickWindow[] {
  const windows: KickWindow[] = [];
  for (const event of events) {
    if (event.kind === 'pass_attempted') {
      windows.push({
        actorId: event.actorId,
        startMs: event.occurredAtMs - 420,
        endMs: event.occurredAtMs + 280,
        peakWeight: 0.9,
      });
    } else if (event.kind === 'shot_attempted') {
      windows.push({
        actorId: event.actorId,
        startMs: event.occurredAtMs - 520,
        endMs: event.occurredAtMs + 330,
        peakWeight: 1,
      });
    }
  }
  return windows;
}

/** Deterministic per-actor phase so 22 legs don't march in lockstep. */
function phaseFor(entityId: string): number {
  let hash = 0;
  for (let i = 0; i < entityId.length; i += 1) hash = (hash * 31 + entityId.charCodeAt(i)) % 997;
  return (hash / 997) * 3;
}

/**
 * Kyneloom-authored kick clip (KYN-30): no CC0 football-kick motion exists in
 * the licensed library, so this minimal action is authored in-house (see the
 * asset ledger) as *reconstructed* presentation — never claimed as captured
 * biomechanics. Poses are offsets composed onto each rig's rest pose.
 */
function buildKickClip(bones: THREE.Object3D[]): THREE.AnimationClip | null {
  const byName = new Map(bones.map((bone) => [bone.name, bone]));
  const thighR = byName.get('thigh_r');
  const calfR = byName.get('calf_r');
  const footR = byName.get('foot_r');
  const pelvis = byName.get('pelvis');
  const spine = byName.get('spine_02');
  const upperarmL = byName.get('upperarm_l');
  const upperarmR = byName.get('upperarm_r');
  if (thighR === undefined || calfR === undefined || footR === undefined || pelvis === undefined) {
    return null;
  }

  const D = THREE.MathUtils.degToRad;
  const tracks: THREE.KeyframeTrack[] = [];
  const quatTrack = (
    bone: THREE.Object3D,
    times: number[],
    eulers: [number, number, number][],
  ): void => {
    const rest = bone.quaternion.clone();
    const values: number[] = [];
    for (const [rx, ry, rz] of eulers) {
      const delta = new THREE.Quaternion().setFromEuler(new THREE.Euler(D(rx), D(ry), D(rz)));
      const composed = rest.clone().multiply(delta);
      values.push(composed.x, composed.y, composed.z, composed.w);
    }
    tracks.push(new THREE.QuaternionKeyframeTrack(`${bone.name}.quaternion`, times, values));
  };

  const times = [0, 0.18, 0.34, 0.52, 0.72];
  // Wind-up → plant → strike → follow-through (right leg).
  quatTrack(thighR, times, [
    [-38, 8, -6],
    [-52, 10, -10],
    [28, 4, 0],
    [66, -6, 6],
    [30, -4, 2],
  ]);
  quatTrack(calfR, times, [
    [8, 0, 0],
    [70, 0, 0],
    [18, 0, 0],
    [6, 0, 0],
    [40, 0, 0],
  ]);
  quatTrack(footR, times, [
    [10, 0, 0],
    [26, 0, 0],
    [-18, 0, 0],
    [-30, 0, 0],
    [10, 0, 0],
  ]);
  quatTrack(pelvis, times, [
    [4, -10, 2],
    [8, -14, 4],
    [-2, 6, -2],
    [-8, 14, -4],
    [-4, 8, -2],
  ]);
  if (spine !== undefined) {
    quatTrack(spine, times, [
      [-6, 10, 0],
      [-10, 16, 2],
      [4, -8, 0],
      [10, -14, -2],
      [6, -8, 0],
    ]);
  }
  if (upperarmL !== undefined) {
    quatTrack(upperarmL, times, [
      [0, 0, 30],
      [-10, 0, 45],
      [30, 0, -20],
      [50, 0, -35],
      [30, 0, -20],
    ]);
  }
  if (upperarmR !== undefined) {
    quatTrack(upperarmR, times, [
      [0, 0, -30],
      [10, 0, -45],
      [-30, 0, 20],
      [-50, 0, 35],
      [-30, 0, 20],
    ]);
  }
  return new THREE.AnimationClip('Kyneloom_Kick', times[times.length - 1]!, tracks);
}

interface PlayerRuntime {
  readonly entityId: string;
  readonly root: THREE.Group;
  readonly mixer: THREE.AnimationMixer;
  readonly actions: Record<string, THREE.AnimationAction>;
  readonly kickClip: THREE.AnimationClip | null;
  readonly heading: { value: number };
}

export function Footballers() {
  const { scene, engine, getFrame, selected, onSelect } = useSceneRuntime();
  const { scene: model, animations } = useGLTF(MODEL_URL);
  const runtime = useRef<PlayerRuntime[]>([]);
  const groupRefs = useRef<(THREE.Group | null)[]>([]);
  const ringRef = useRef<THREE.Mesh>(null);
  const kickWindows = useMemo(() => kickWindowsFromEvents(scene.events), [scene.events]);

  // Independent skeletons per actor: clone shares geometry/materials, bones
  // are per-instance (SkeletonUtils semantics). Kits swap the two source
  // materials for shared per-team materials.
  const teamMaterials = useMemo(() => {
    const make = (colors: KitColors) => ({
      main: new THREE.MeshStandardMaterial({
        color: colors.shirt,
        roughness: 0.68,
        metalness: 0.02,
      }),
      joints: new THREE.MeshStandardMaterial({
        color: colors.underlayer,
        roughness: 0.75,
        metalness: 0.0,
      }),
    });
    return {
      home: make(KITS.home),
      away: make(KITS.away),
      'home-gk': make(KITS['home-gk']),
      'away-gk': make(KITS['away-gk']),
    } as const;
  }, []);

  useLayoutEffect(() => {
    const players: PlayerRuntime[] = [];
    model.updateMatrixWorld(true);
    scene.players.forEach((player, index) => {
      const holder = groupRefs.current[index];
      if (holder === null || holder === undefined) return;
      const cloned = skeletonClone(model) as THREE.Group;
      cloned.traverse((child) => {
        const mesh = child as THREE.Mesh;
        if (mesh.isMesh !== true) return;
        mesh.castShadow = true;
        mesh.frustumCulled = false; // skinned bounds are unstable; 22 is fine uncull'd
        const material = mesh.material as THREE.MeshStandardMaterial;
        const kit = teamMaterials[kitKey(player)];
        mesh.material = material.name === 'M_Joints' ? kit.joints : kit.main;
      });
      holder.add(cloned);

      const bones: THREE.Object3D[] = [];
      cloned.traverse((child) => {
        if ((child as THREE.Bone).isBone) bones.push(child);
      });
      const mixer = new THREE.AnimationMixer(cloned);
      const actions: Record<string, THREE.AnimationAction> = {};
      for (const clip of animations) {
        const action = mixer.clipAction(clip);
        action.enabled = true;
        action.setEffectiveWeight(0);
        action.play();
        actions[clip.name] = action;
      }
      const kickClip = buildKickClip(bones);
      if (kickClip !== null) {
        const action = mixer.clipAction(kickClip);
        action.enabled = true;
        action.setEffectiveWeight(0);
        action.play();
        actions[kickClip.name] = action;
      }
      players.push({
        entityId: player.entityId,
        root: holder,
        mixer,
        actions,
        kickClip,
        heading: { value: 0 },
      });
    });
    runtime.current = players;
    return () => {
      for (const player of players) player.mixer.stopAllAction();
      runtime.current = [];
    };
  }, [model, animations, scene.players, teamMaterials]);

  useFrame(() => {
    const t = engine.playheadMs;
    const snapshot = getFrame(t);
    for (const player of runtime.current) {
      const sample = snapshot.positions.get(player.entityId);
      if (sample === undefined) {
        player.root.visible = false;
        continue;
      }
      player.root.visible = true;
      const [x, y, z] = pitchToThree({ xM: sample.xM, yM: sample.yM, zM: sample.zM });
      player.root.position.set(x, y, z);

      // Heading: authoritative motion direction, damped for presentation.
      const targetHeading = snapshot.headingsRad.get(player.entityId);
      if (targetHeading !== undefined) {
        let delta = targetHeading - player.heading.value;
        delta = Math.atan2(Math.sin(delta), Math.cos(delta));
        const step = engine.reducedMotion ? delta : delta * 0.22;
        player.heading.value += step;
      }
      player.root.rotation.y = player.heading.value + MODEL_FORWARD_OFFSET;

      const speed = snapshot.velocitiesMps.get(player.entityId) ?? 0;
      applyLocomotion(player, speed, t);

      const kick = kickWindows.find(
        (window) => window.actorId === player.entityId && t >= window.startMs && t <= window.endMs,
      );
      applyKick(player, kick ?? null, t);
      player.mixer.update(0);
    }

    // Selection ring under the tracked player.
    const ring = ringRef.current;
    if (ring !== null) {
      const targetId = selected.entityId;
      const sample = targetId !== null ? snapshot.positions.get(targetId) : undefined;
      ring.visible = sample !== undefined;
      if (sample !== undefined) {
        const [x, , z] = pitchToThree({ xM: sample.xM, yM: sample.yM, zM: sample.zM });
        ring.position.set(x, 0.03, z);
      }
    }
  });

  const onPick = (event: ThreeEvent<PointerEvent>, entityId: string) => {
    event.stopPropagation();
    onSelect(selected.entityId === entityId ? null : entityId);
  };

  return (
    <group>
      {scene.players.map((player, index) => (
        <group
          key={player.entityId}
          ref={(node) => {
            groupRefs.current[index] = node;
          }}
        >
          {/* Invisible pick target: cheap cylinder beats raycasting skin. */}
          <mesh position={[0, 0.92, 0]} onPointerDown={(event) => onPick(event, player.entityId)}>
            <cylinderGeometry args={[0.5, 0.5, 1.84, 8]} />
            <meshBasicMaterial transparent opacity={0} depthWrite={false} colorWrite={false} />
          </mesh>
        </group>
      ))}
      <mesh ref={ringRef} rotation={[-Math.PI / 2, 0, 0]} visible={false}>
        <ringGeometry args={[0.55, 0.72, 32]} />
        <meshBasicMaterial color="#51d7bd" transparent opacity={0.85} depthWrite={false} />
      </mesh>
    </group>
  );
}

function kitKey(player: {
  team: 'home' | 'away';
  isGoalkeeper: boolean;
}): 'home' | 'away' | 'home-gk' | 'away-gk' {
  if (player.isGoalkeeper) return player.team === 'home' ? 'home-gk' : 'away-gk';
  return player.team;
}

/**
 * Speed→clip weights as a PURE function of speed: bands overlap and
 * normalize, so scrubbing to the same playhead always yields the same pose.
 */
function locomotionWeights(speed: number): {
  idle: number;
  walk: number;
  jog: number;
  sprint: number;
} {
  const ramp = (edge0: number, edge1: number) =>
    THREE.MathUtils.clamp((speed - edge0) / (edge1 - edge0), 0, 1);
  const idle = 1 - ramp(0.15, SPEED_BANDS.idle);
  const walk =
    ramp(0.15, SPEED_BANDS.idle) * (1 - ramp(SPEED_BANDS.idle + 1.2, SPEED_BANDS.walk + 0.6));
  const jog =
    ramp(SPEED_BANDS.walk - 0.6, SPEED_BANDS.walk + 0.6) *
    (1 - ramp(SPEED_BANDS.jog, SPEED_BANDS.jog + 1.6));
  const sprint = ramp(SPEED_BANDS.jog, SPEED_BANDS.jog + 1.6);
  return { idle, walk, jog, sprint };
}

function applyLocomotion(player: PlayerRuntime, speed: number, t: number): void {
  const weights = locomotionWeights(speed);
  const phase = phaseFor(player.entityId);
  const seconds = t / 1000 + phase;
  const clips: [string, number][] = [
    ['Idle_Loop', weights.idle],
    ['Walk_Loop', weights.walk],
    ['Jog_Fwd_Loop', weights.jog],
    ['Sprint_Loop', weights.sprint],
  ];
  for (const [name, weight] of clips) {
    const action = player.actions[name];
    if (action === undefined) continue;
    if (weight > 0.001) {
      const duration = action.getClip().duration;
      action.time = ((seconds % duration) + duration) % duration;
    }
    action.setEffectiveWeight(weight);
  }
}

function applyKick(player: PlayerRuntime, kick: KickWindow | null, t: number): void {
  const action = player.actions['Kyneloom_Kick'];
  if (action === undefined || player.kickClip === null) return;
  if (kick === null) {
    action.setEffectiveWeight(0);
    return;
  }
  const duration = player.kickClip.duration * 1000;
  const local = THREE.MathUtils.clamp(t - kick.startMs, 0, duration);
  action.time = local / 1000;
  const fadeIn = THREE.MathUtils.clamp(local / 90, 0, 1);
  const fadeOut = THREE.MathUtils.clamp((duration - local) / 130, 0, 1);
  const kickWeight = Math.min(fadeIn, fadeOut) * kick.peakWeight;
  action.setEffectiveWeight(kickWeight);
  // Suppress locomotion proportionally so the strike reads clearly.
  const damp = 1 - kickWeight;
  for (const name of ['Idle_Loop', 'Walk_Loop', 'Jog_Fwd_Loop', 'Sprint_Loop']) {
    const locomotion = player.actions[name];
    if (locomotion !== undefined) {
      locomotion.setEffectiveWeight(locomotion.getEffectiveWeight() * damp);
    }
  }
}

useGLTF.preload(MODEL_URL);

export type { SelectionState };
