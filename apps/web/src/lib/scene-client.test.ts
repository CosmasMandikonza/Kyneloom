import { describe, expect, it } from 'vitest';
import type { GoldenMatchStatus } from './match-fixture';
import { loadGoldenMatch } from './match-fixture';
import { ScenePayloadInvalidError, tracksToSamples } from './scene-client';
import { buildSceneData, type SceneData } from './scene-data';

/**
 * KYN-06 review fix 4: the client must REJECT truncated/corrupted scene
 * payloads. Before this guard, missing values were silently replaced with
 * `?? 0` coordinates, `synthetic_ground_truth` provenance, confidence 1 and
 * `frame-unknown` ids — turning a corrupt payload into plausible-but-false
 * tracking data. Every corruption below must throw, never fabricate.
 */

async function validScene(): Promise<SceneData> {
  const golden = await loadGoldenMatch();
  const scene = buildSceneData(golden);
  if (scene === null) throw new Error('golden fixture unavailable in test');
  return JSON.parse(JSON.stringify(scene)) as SceneData;
}

/**
 * JSON clones are structurally SceneData but not readonly at runtime —
 * mutations deliberately corrupt them, so each one works through a local
 * writable view of just the field it breaks.
 */
type Mutation = (scene: SceneData) => void;

function mutated(base: SceneData, mutate: Mutation): SceneData {
  const copy = JSON.parse(JSON.stringify(base)) as SceneData;
  mutate(copy);
  return copy;
}

/** Writable alias for corrupting one interned table value. */
function tableOf(scene: SceneData, key: 'origins' | 'visibilities' | 'confidences' | 'frameIds') {
  return scene[key] as unknown as unknown[];
}

describe('scene-client rehydration validation', () => {
  it('accepts the valid golden payload verbatim (smoke)', async () => {
    const scene = await validScene();
    const samples = tracksToSamples(scene);
    expect(samples.length).toBeGreaterThan(0);
  });

  const corruptions: readonly [name: string, Mutation][] = [
    [
      'missing sample time (t shorter than xyz)',
      (s) => {
        (s.tracks[0]!.t as unknown as unknown[]).pop();
      },
    ],
    [
      'xyz shorter than 3 × t',
      (s) => {
        (s.tracks[0]!.xyz as unknown as unknown[]).pop();
      },
    ],
    [
      'non-finite coordinate (NaN x)',
      (s) => {
        (s.tracks[0]!.xyz as unknown as unknown[])[0] = Number.NaN;
      },
    ],
    [
      'non-finite sample time (Infinity)',
      (s) => {
        (s.tracks[0]!.t as unknown as unknown[])[0] = Number.POSITIVE_INFINITY;
      },
    ],
    [
      'origin index outside the table',
      (s) => {
        (s.tracks[0]!.o as unknown as unknown[])[0] = s.origins.length + 7;
      },
    ],
    [
      'origin string outside the contract set',
      (s) => {
        tableOf(s, 'origins')[0] = 'totally_observed';
      },
    ],
    [
      'visibility outside the contract bijection',
      (s) => {
        tableOf(s, 'visibilities')[0] = 'maybe';
      },
    ],
    [
      'confidence outside [0, 1]',
      (s) => {
        tableOf(s, 'confidences')[0] = 1.5;
      },
    ],
    [
      'empty source frame id',
      (s) => {
        tableOf(s, 'frameIds')[0] = '';
      },
    ],
    [
      'roster entry without a team',
      (s) => {
        (s.players[0] as { team?: unknown }).team = null;
      },
    ],
    [
      'no ball track',
      (s) => {
        (s as unknown as { tracks: SceneData['tracks'] }).tracks = s.tracks.filter(
          (track) => track.entityId !== 'ball',
        );
      },
    ],
    [
      'empty tracks',
      (s) => {
        (s as unknown as { tracks: SceneData['tracks'] }).tracks = [];
      },
    ],
  ];

  for (const [name, mutate] of corruptions) {
    it(`rejects: ${name}`, async () => {
      const scene = mutated(await validScene(), mutate);
      expect(() => tracksToSamples(scene)).toThrow(ScenePayloadInvalidError);
    });
  }

  it('never fabricates defaults for dropped optional fields (regression spec)', async () => {
    // The old implementation produced `?? 0` coordinates and invented
    // `frame-unknown` ids for exactly these shapes; assert none survive.
    const scene = await validScene();
    const samples = tracksToSamples(scene);
    for (const sample of samples) {
      expect(Number.isFinite(sample.xM)).toBe(true);
      expect(Number.isFinite(sample.yM)).toBe(true);
      expect(Number.isFinite(sample.zM)).toBe(true);
      expect(sample.sourceFrameId).toMatch(/^frame-\d+$/);
      expect(sample.confidence).toBeGreaterThanOrEqual(0);
      expect(sample.confidence).toBeLessThanOrEqual(1);
    }
    // Dropped optional fields are a length mismatch, not a default: the
    // error names the offending arrays.
    const broken = mutated(scene, (s) => {
      (s.tracks[0]!.t as unknown as unknown[]).pop();
    });
    expect(() => tracksToSamples(broken)).toThrow(/xyz length/);
  });
});

type MutableEvent = {
  occurredAtMs: number;
  teamId: string | null;
  position?: { xM: number; yM: number };
};

async function clonedGolden(): Promise<GoldenMatchStatus | null> {
  const golden = await loadGoldenMatch();
  if (!golden.ok) return null;
  return JSON.parse(JSON.stringify(golden)) as GoldenMatchStatus;
}

describe('scene-data event truthfulness (review fix 4b)', () => {
  it('excludes in-window events whose source teamId is null — no fabricated home', async () => {
    const clone = await clonedGolden();
    if (clone === null || !clone.ok) return;
    const [start, end] = clone.data.goldenWindowMs;
    const events = clone.data.projected.acceptedEvents as unknown as MutableEvent[];
    const target = events.find((event) => event.occurredAtMs >= start && event.occurredAtMs <= end);
    if (target === undefined) return;
    target.teamId = null; // as if a source event carried no affiliation
    const scene = buildSceneData(clone)!;
    expect(scene.events.some((event) => event.occurredAtMs === target.occurredAtMs)).toBe(false);
  });

  it('keeps a missing event location null instead of encoding (0, 0)', async () => {
    const clone = await clonedGolden();
    if (clone === null || !clone.ok) return;
    const events = clone.data.projected.acceptedEvents as unknown as MutableEvent[];
    const [start, end] = clone.data.goldenWindowMs;
    const withPosition = events.find(
      (event) =>
        event.position !== undefined && event.occurredAtMs >= start && event.occurredAtMs <= end,
    );
    if (withPosition === undefined) return;
    delete withPosition.position;
    const scene = buildSceneData(clone)!;
    const event = scene.events.find(
      (candidate) => candidate.occurredAtMs === withPosition.occurredAtMs,
    )!;
    expect(event.position).toBeNull();
  });
});
