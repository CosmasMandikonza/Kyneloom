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

describe('assembleFixtureBundle internal-consistency rejection (review fix 2)', () => {
  const generated = generateMatchFixture({ seed: 24017 });

  it('rejects envelopes whose matchId contradicts the metadata matchId', () => {
    const stranger = generated.events.map((e, i) =>
      i === 0 ? { ...e, matchId: 'another-match' } : e,
    );
    const result = assembleFixtureBundle({
      events: stranger,
      tracking: generated.tracking,
      metadata: generated.metadata,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const error = result.errors.find((e) => e.kind === 'event');
    expect(error?.index).toBe(0);
    expect(error?.message).toContain('another-match');
    expect(error?.message).toContain(generated.metadata.matchId);
  });

  it('rejects tracking samples with a foreign matchId', () => {
    const stranger = generated.tracking.map((s, i) =>
      i === 0 ? { ...s, matchId: 'another-match' } : s,
    );
    const result = assembleFixtureBundle({
      events: generated.events,
      tracking: stranger,
      metadata: generated.metadata,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(
      result.errors.some((e) => e.kind === 'tracking' && e.message.includes('another-match')),
    ).toBe(true);
  });

  it('rejects duplicate (sampleTimeMs, entityId) pairs — frameAt must never silently overwrite', () => {
    // The exact corruption the review demonstrated: a duplicated sample used
    // to overwrite the first in the byTime map, making frameAt() return the
    // last-written fact as apparently legitimate data.
    const first = generated.tracking[0]!;
    const forged = {
      ...first,
      xM: first.xM + 42, // corrupted position for the same entity+time
    };
    const result = assembleFixtureBundle({
      events: generated.events,
      tracking: [forged, ...generated.tracking],
      metadata: generated.metadata,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const dup = result.errors.find(
      (e) => e.kind === 'tracking' && e.message.includes('duplicate sample'),
    );
    expect(dup?.index).toBe(1);
    expect(dup?.message).toContain(first.entityId);
    expect(dup?.message).toContain(String(first.sampleTimeMs));
  });

  it('rejects metadata counts that disagree with the actual data', () => {
    const wrongCounts = {
      ...generated.metadata,
      sampling: { ...generated.metadata.sampling, frameCount: 999 },
      eventCount: 999,
    };
    const result = assembleFixtureBundle({
      events: generated.events,
      tracking: generated.tracking,
      metadata: wrongCounts,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(
      result.errors.some((e) => e.kind === 'metadata' && e.message.includes('frameCount')),
    ).toBe(true);
    expect(
      result.errors.some((e) => e.kind === 'metadata' && e.message.includes('eventCount')),
    ).toBe(true);
  });

  it('still accepts the untouched generated bundle (no false positives)', () => {
    expect(assembleFixtureBundle(generated).ok).toBe(true);
  });
});
