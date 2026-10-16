import { createTimeline } from '@kyneloom/match-core';
import { pitchToThree } from '@kyneloom/contracts';
import { describe, expect, it } from 'vitest';
import { loadGoldenMatch } from './match-fixture';
import { sceneTimeline, tracksToSamples } from './scene-client';
import { buildSceneData, selectDirectedTrack } from './scene-data';
import invisibleAssistManifest from '../app/explore/scene/directed/invisible-assist.manifest.json';

/**
 * KYN-06 acceptance tests for the server→client scene-data boundary.
 *
 * These pin the adversarial gates from Issue #6: exact source positions at
 * the confirmed checkpoint, stable identities, verbatim reconstruction
 * status, the single pitchToThree transform, and JSON-only serialization
 * (no function-bearing ProjectedMatch crosses the wire).
 */

const CHECKPOINT_MS = 4_722_100;

describe('buildSceneData boundary', () => {
  it('produces a JSON-serializable scene (no functions cross the wire)', async () => {
    const golden = await loadGoldenMatch();
    const scene = buildSceneData(golden);
    expect(scene).not.toBeNull();
    // Round-trip through JSON: if this throws or drops data, the boundary is
    // not serializable.
    const revived = JSON.parse(JSON.stringify(scene));
    expect(revived).toEqual(scene);
  });

  it('carries 22 unique players plus the ball with stable identities', async () => {
    const golden = await loadGoldenMatch();
    const scene = buildSceneData(golden)!;
    const ids = scene.players.map((p) => p.entityId);
    expect(ids).toHaveLength(22);
    expect(new Set(ids).size).toBe(22);
    expect(scene.players.filter((p) => p.team === 'home')).toHaveLength(11);
    expect(scene.players.filter((p) => p.team === 'away')).toHaveLength(11);
    expect(scene.players.filter((p) => p.isGoalkeeper)).toHaveLength(2);
    expect(scene.tracks.map((t) => t.entityId)).toContain('ball');
    expect(new Set(scene.tracks.map((t) => t.entityId)).size).toBe(23);
  });

  it('matches the authoritative reducer frame EXACTLY at the checkpoint', async () => {
    const golden = await loadGoldenMatch();
    expect(golden.ok).toBe(true);
    if (!golden.ok) return;
    const scene = buildSceneData(golden)!;

    const authoritative = createTimeline(golden.data.projected.acceptedTracking);
    const client = sceneTimeline(JSON.parse(JSON.stringify(scene)) as typeof scene);

    const a = authoritative.sampleAt(CHECKPOINT_MS);
    const c = client.sampleAt(CHECKPOINT_MS);
    expect(c.queryTimeMs).toBe(CHECKPOINT_MS);
    expect(c.entities).toHaveLength(a.entities.length);
    expect(c.missingEntityIds).toEqual(a.missingEntityIds);
    for (const entity of a.entities) {
      const match = c.entities.find((e) => e.entityId === entity.entityId);
      expect(match, entity.entityId).toBeDefined();
      expect(match!.xM).toBe(entity.xM);
      expect(match!.yM).toBe(entity.yM);
      expect(match!.zM).toBe(entity.zM);
      expect(match!.exact).toBe(entity.exact);
      expect(match!.origin).toBe(entity.origin);
      expect(match!.sourceFrameIds).toEqual(entity.sourceFrameIds);
    }

    // Known checkpoint facts (golden frame-47221, seed 24017).
    const ball = c.entities.find((e) => e.entityId === 'ball');
    expect(ball!.xM).toBeCloseTo(21.241, 3);
    expect(ball!.yM).toBeCloseTo(-2.172, 3);
    expect(ball!.zM).toBeCloseTo(0.11, 3);
  });

  it('rehydrates samples verbatim — origins, confidences, frames survive the wire', async () => {
    const golden = await loadGoldenMatch();
    if (!golden.ok) return;
    const scene = buildSceneData(golden)!;
    const samples = tracksToSamples(JSON.parse(JSON.stringify(scene)) as typeof scene);
    const source = golden.data.projected.acceptedTracking;
    expect(samples).toHaveLength(source.length);
    const byKey = new Map(samples.map((s) => [`${s.entityId}@${s.sampleTimeMs}`, s]));
    for (const original of source) {
      const rehydrated = byKey.get(`${original.entityId}@${original.sampleTimeMs}`);
      expect(rehydrated, `${original.entityId}@${original.sampleTimeMs}`).toBeDefined();
      expect(rehydrated!.xM).toBe(original.xM);
      expect(rehydrated!.yM).toBe(original.yM);
      expect(rehydrated!.zM).toBe(original.zM);
      expect(rehydrated!.origin).toBe(original.origin);
      expect(rehydrated!.visibility).toBe(original.visibility);
      expect(rehydrated!.confidence).toBe(original.confidence);
      expect(rehydrated!.sourceFrameId).toBe(original.sourceFrameId);
    }
  });

  it('discloses interpolation instead of inventing positions between samples', async () => {
    const golden = await loadGoldenMatch();
    const scene = buildSceneData(golden)!;
    const client = sceneTimeline(scene);
    // Halfway between two 100ms frames in the golden window.
    const frame = client.sampleAt(CHECKPOINT_MS + 50);
    const entity = frame.entities.find((e) => e.entityId === 'home-11');
    expect(entity).toBeDefined();
    expect(entity!.exact).toBe(false);
    expect(entity!.origin).toBe('interpolated');
    expect(entity!.interpolation?.method).toBe('linear');
  });

  it('marks time outside the sampled span as missing — never (0,0,0)', async () => {
    const golden = await loadGoldenMatch();
    const scene = buildSceneData(golden)!;
    const client = sceneTimeline(scene);
    const [start] = scene.windowMs;
    // Before the first sample of any entity: explicitly absent.
    const frame = client.sampleAt(start - 50);
    expect(frame.entities.length + frame.missingEntityIds.length).toBeGreaterThanOrEqual(23);
  });

  it('carries the four golden-window events with actors and positions', async () => {
    const golden = await loadGoldenMatch();
    const scene = buildSceneData(golden)!;
    expect(scene.events.map((e) => e.kind)).toEqual([
      'pass_attempted',
      'pass_completed',
      'shot_attempted',
      'goal',
    ]);
    const goal = scene.events[3]!;
    expect(goal.occurredAtMs).toBe(4_728_300);
    expect(goal.actorId).toBe('home-09');
    expect(goal.label).toBe('GOAL');
  });
});

describe('directed camera track selection (KYN-07)', () => {
  it('exposes the authored Invisible Assist track through the golden scene', async () => {
    const golden = await loadGoldenMatch();
    const scene = buildSceneData(golden)!;
    expect(scene.directedTrack).not.toBeNull();
    expect(scene.directedTrack!.id).toBe('cam-invisible-assist');
    expect(scene.directedTrack!.mode).toBe('directed');
    // Offsets stay manifest-relative until the rig converts them once.
    expect(scene.directedTrack!.startMs).toBe(0);
    expect(scene.directedTrack!.endMs).toBe(14_000);
  });

  it('returns null when the manifest window does not match the scene window', async () => {
    const golden = await loadGoldenMatch();
    if (!golden.ok) return;
    expect(
      selectDirectedTrack(golden.data.goldenWindowMs[0] + 100, golden.data.goldenWindowMs[1]),
    ).toBeNull();
  });

  it('returns null for a structurally invalid manifest (fail closed)', async () => {
    const golden = await loadGoldenMatch();
    if (!golden.ok) return;
    const corrupt = JSON.parse(JSON.stringify(invisibleAssistManifest)) as {
      scene: { cameraTracks: { keyframes: { position: number[] }[] }[] };
    };
    corrupt.scene.cameraTracks[0]!.keyframes[0]!.position = [0, -34, 0.1]; // underground camera
    expect(
      selectDirectedTrack(golden.data.goldenWindowMs[0], golden.data.goldenWindowMs[1], corrupt),
    ).toBeNull();
  });
});

describe('pitchToThree is the only axis conversion', () => {
  it('maps corners, center and ball height with the hand-checked formula', () => {
    expect(pitchToThree({ xM: 52.5, yM: 34, zM: 0 })).toEqual([52.5, 0, -34]);
    expect(pitchToThree({ xM: -52.5, yM: -34, zM: 0 })).toEqual([-52.5, 0, 34]);
    expect(pitchToThree({ xM: 0, yM: 0, zM: 2 })).toEqual([0, 2, 0]);
    expect(pitchToThree([1, 2, 3])).toEqual([1, 3, -2]);
  });
});
