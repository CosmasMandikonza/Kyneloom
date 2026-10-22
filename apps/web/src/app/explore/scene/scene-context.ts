'use client';

import { createContext, useContext } from 'react';
import type { PlaybackSpeed, PlaybackWindow } from '@/lib/playback';
import type { SceneData } from '@/lib/scene-data';
import type { Timeline, TimelineFrame } from '@kyneloom/match-core';

/**
 * Shared replay engine state (KYN-06).
 *
 * `playheadMs` is a plain mutable field owned by the transport loop in the
 * Explore shell — NOT React state. The 3D scene and the 2D fallback read it
 * inside their frame loops; nothing re-renders React per frame. Discrete UI
 * (play/pause, speed, camera, selection) lives in React state and mirrors
 * into this object.
 */
export interface ReplayEngine {
  /** Live mode grows this as streamed match time advances (KYN-13). */
  window: PlaybackWindow;
  /** Authoritative replay time in absolute match ms. */
  playheadMs: number;
  playing: boolean;
  speed: PlaybackSpeed;
  reducedMotion: boolean;
  /** Bumped on every transport action so throttled observers resync. */
  revision: number;
}

/**
 * The six camera modes (KYN-07, docs/08). Exactly one drives the camera at
 * a time; `orbit` hands ownership to OrbitControls.
 */
export type CameraMode = 'broadcast' | 'overhead' | 'follow' | 'goalkeeper' | 'orbit' | 'directed';

export interface SelectionState {
  readonly entityId: string | null;
}

/**
 * A memoized per-time snapshot of the authoritative timeline. The first
 * consumer each frame computes it; everything else (22 players, ball,
 * cameras) reuses it — one `sampleAt` per rendered frame, not 24.
 */
export interface FrameSnapshot {
  readonly queryTimeMs: number;
  readonly positions: ReadonlyMap<string, TimelineFrame['entities'][number]>;
  readonly velocitiesMps: ReadonlyMap<string, number>;
  readonly headingsRad: ReadonlyMap<string, number>;
  readonly missingEntityIds: readonly string[];
}

export function createFrameCache(
  timeline: Timeline,
  ballEntityId: string,
): (t: number) => FrameSnapshot {
  let cachedT = Number.NaN;
  let cached: FrameSnapshot | null = null;

  return (t: number): FrameSnapshot => {
    if (cached !== null && t === cachedT) return cached;
    const frame = timeline.sampleAt(t);
    const back = t >= 100 ? timeline.sampleAt(t - 100) : null;

    const positions = new Map<string, TimelineFrame['entities'][number]>();
    const velocitiesMps = new Map<string, number>();
    const headingsRad = new Map<string, number>();
    for (const entity of frame.entities) {
      positions.set(entity.entityId, entity);
      const before = back?.entities.find((candidate) => candidate.entityId === entity.entityId);
      if (before !== undefined) {
        const dx = entity.xM - before.xM;
        const dy = entity.yM - before.yM;
        velocitiesMps.set(entity.entityId, Math.hypot(dx, dy) * 10);
        if (dx * dx + dy * dy > 1e-6) {
          // Heading in canonical pitch space: +x attack, atan2(y, x).
          headingsRad.set(entity.entityId, Math.atan2(dy, dx));
        }
      }
    }
    void ballEntityId;
    cached = {
      queryTimeMs: t,
      positions,
      velocitiesMps,
      headingsRad,
      missingEntityIds: frame.missingEntityIds,
    };
    cachedT = t;
    return cached;
  };
}

export interface SceneRuntime {
  readonly scene: SceneData;
  readonly engine: ReplayEngine;
  readonly getFrame: (t: number) => FrameSnapshot;
  readonly selected: SelectionState;
  onSelect(entityId: string | null): void;
}

export const SceneRuntimeContext = createContext<SceneRuntime | null>(null);

export function useSceneRuntime(): SceneRuntime {
  const runtime = useContext(SceneRuntimeContext);
  if (runtime === null) throw new Error('useSceneRuntime outside SceneRuntimeProvider');
  return runtime;
}
