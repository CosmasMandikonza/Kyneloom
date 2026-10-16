// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SceneData } from '@/lib/scene-data';
import { sceneTimeline } from '@/lib/scene-client';
import { createFrameCache, type ReplayEngine, type SceneRuntime } from './scene-context';

/**
 * KYN-06 review fix 1: an asset-load failure (e.g. a rejected/broken GLB)
 * must degrade to the SAME-TIMELINE 2D fallback — never a blank stage.
 *
 * This is a real error-boundary integration test of LivingReplayCanvas: the
 * WebGL shell (R3F Canvas) and the asset-bearing children are stubbed, the
 * boundary, failure gate, fallback and runtime wiring are the REAL code
 * under test.
 */

vi.mock('@react-three/fiber', () => ({
  Canvas: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="canvas-stub">{children}</div>
  ),
  useFrame: () => undefined,
  useThree: (selector: (state: unknown) => unknown) => selector({ gl: { info: {} } }),
}));

vi.mock('@react-three/drei', () => ({
  useProgress: () => ({ active: false, progress: 100 }),
  OrbitControls: () => null,
  useGLTF: Object.assign(
    () => {
      throw new Error('GLB fetch rejected (test)');
    },
    { preload: () => undefined },
  ),
}));

vi.mock('@kyneloom/scene-renderer', () => ({
  detectSceneCapabilities: () => ({ webgl: webglAvailable.value }),
}));

// Per-test control of the GLB load failure and the capability gate.
const { glbLoadFails, webglAvailable } = vi.hoisted(() => ({
  glbLoadFails: { value: true },
  webglAvailable: { value: true },
}));

// The asset-bearing children: when enabled, the GLB load path THROWS,
// exactly like a rejected fetch or unparseable GLB inside Suspense.
vi.mock('./footballers', async (importOriginal) => {
  const original = await importOriginal<typeof import('./footballers')>();
  return {
    ...original,
    Footballers: () => {
      if (glbLoadFails.value) throw new Error('GLB failed to load (test)');
      return null;
    },
  };
});
vi.mock('./ball', () => ({ Ball: () => null }));
vi.mock('./camera-rig', () => ({ CameraRig: () => null }));
vi.mock('./stadium', () => ({
  Stadium: () => null,
  StadiumLights: () => null,
}));

import { LivingReplayCanvas } from './living-replay';

/** Minimal valid scene: one player + ball, a few samples around t=1000. */
function tinyScene(): SceneData {
  const track = (entityId: string, x0: number) => ({
    entityId,
    t: [1000, 1100, 1200],
    xyz: [x0, 0, 0, x0 + 0.5, 0, 0, x0 + 1, 0, 0],
    o: [0, 0, 0],
    v: [0, 0, 0],
    c: [0, 0, 0],
    f: [0, 1, 2],
  });
  return {
    matchId: 'synthetic-derby-01',
    schemaVersion: '1.0',
    seed: 24017,
    windowMs: [1000, 1200],
    checkpointMs: 1100,
    initialFocusMs: 1100,
    teams: { home: 'northbridge-athletic', away: 'vale-rovers' },
    players: [
      { entityId: 'home-11', team: 'home', shirtNumber: 11, role: 'winger', isGoalkeeper: false },
    ],
    ballEntityId: 'ball',
    tracks: [track('home-11', 10), track('ball', 20)],
    origins: ['synthetic_ground_truth'],
    visibilities: ['tracked'],
    confidences: [1],
    frameIds: ['frame-10', 'frame-11', 'frame-12'],
    events: [],
    directedTrack: null,
  };
}

function tinyRuntime(scene: SceneData): SceneRuntime {
  const timeline = sceneTimeline(scene);
  const engine: ReplayEngine = {
    window: { startMs: scene.windowMs[0], endMs: scene.windowMs[1] },
    playheadMs: scene.initialFocusMs,
    playing: false,
    speed: 1,
    reducedMotion: false,
    revision: 0,
  };
  return {
    scene,
    engine,
    getFrame: createFrameCache(timeline, scene.ballEntityId),
    selected: { entityId: null },
    onSelect: () => undefined,
  };
}

// No vitest globals in this repo: clean the DOM between cases so a
// previous render's fallback node cannot leak into the next assertion.
afterEach(() => cleanup());

describe('LivingReplayCanvas failure contract', () => {
  it('asset errors render the same-timeline 2D fallback, not a blank stage', async () => {
    const scene = tinyScene();
    const runtime = tinyRuntime(scene);
    render(<LivingReplayCanvas runtime={runtime} cameraMode="broadcast" quality="high" />);

    // The thrown GLB load must land in the boundary → failure state →
    // Fallback2D with the asset-error reason.
    const fallback = await screen.findByText(/3D scene failed to load/i, undefined, {
      timeout: 3000,
    });
    expect(fallback).toBeDefined();
    const root = document.querySelector('[data-scene-fallback]');
    expect(root?.getAttribute('data-scene-fallback')).toBe('asset-error');

    // The fallback runs on the SAME timeline: the player and ball dots mount
    // (playhead remains usable), and no WebGL shell remains.
    await waitFor(() => {
      expect(document.querySelectorAll('.fallback2d svg circle').length).toBeGreaterThanOrEqual(2);
    });
    expect(screen.queryByTestId('canvas-stub')).toBeNull();
  });

  it('webgl-unavailable renders the 2D fallback with that reason', async () => {
    glbLoadFails.value = false; // children render fine; the capability gate decides
    webglAvailable.value = false;
    const scene = tinyScene();
    const runtime = tinyRuntime(scene);
    render(<LivingReplayCanvas runtime={runtime} cameraMode="broadcast" quality="high" />);
    const root = await waitFor(() => {
      const node = document.querySelector('[data-scene-fallback]');
      expect(node).toBeDefined();
      return node!;
    });
    expect(root.getAttribute('data-scene-fallback')).toBe('webgl-unavailable');
  });
});
