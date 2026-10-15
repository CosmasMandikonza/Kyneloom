import { describe, expect, it } from 'vitest';
import { generateMatchFixture } from './simulate';
import { assembleFixtureBundle } from './fixture';

describe('assembleFixtureBundle (renderer-side loading interface)', () => {
  const generated = generateMatchFixture({ seed: 24017 });
  const result = assembleFixtureBundle({
    events: generated.events,
    tracking: generated.tracking,
    metadata: generated.metadata,
  });

  it('validates and assembles a generated bundle', () => {
    expect(result.ok).toBe(true);
  });

  it('exposes per-entity tracks in time order without inventing data', () => {
    if (!result.ok) throw new Error('bundle must assemble');
    const striker = result.bundle.entityTrack('home-09');
    expect(striker.length).toBeGreaterThan(100);
    for (let i = 1; i < striker.length; i++) {
      expect(striker[i]!.sampleTimeMs).toBeGreaterThanOrEqual(striker[i - 1]!.sampleTimeMs);
    }
    // An entity with no samples yields an explicit empty track, not (0,0,0).
    expect(result.bundle.entityTrack('away-99')).toEqual([]);
  });

  it('exposes complete frames and event windows', () => {
    if (!result.ok) throw new Error('bundle must assemble');
    const checkpoint = result.bundle.frameAt(generated.metadata.goldenCheckpointMs);
    expect(checkpoint.size).toBe(23);
    const goldenEvents = result.bundle.eventsBetween(4717000, 4731000);
    expect(goldenEvents.map((e) => e.kind)).toEqual([
      'pass_attempted',
      'pass_completed',
      'shot_attempted',
      'goal',
    ]);
    // A time with no emitted frame is an empty map, never fabricated.
    expect(result.bundle.frameAt(1234567).size).toBe(0);
  });

  it('rejects malformed input with indexed, categorized errors', () => {
    const bad = assembleFixtureBundle({
      events: [...generated.events, { garbage: true }],
      tracking: [...generated.tracking, { entityId: 'ball', xM: Number.NaN }],
      metadata: { nope: 1 },
    });
    expect(bad.ok).toBe(false);
    if (bad.ok) return;
    const kinds = bad.errors.map((e) => e.kind).sort();
    expect(kinds).toEqual(['event', 'metadata', 'tracking']);
    const eventError = bad.errors.find((e) => e.kind === 'event')!;
    expect(eventError.index).toBe(generated.events.length);
    expect(eventError.message).toContain('eventId');
  });
});
