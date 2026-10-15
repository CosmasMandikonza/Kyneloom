import { describe, expect, it } from 'vitest';
import type { TrackingSample } from '@kyneloom/contracts';
import { canonicalJsonStringify, parseMatchEvent, parseTrackingSample } from '@kyneloom/contracts';
import { generateMatchFixture, MOVEMENT_ENVELOPE, type FixtureBundle } from './simulate';
import { ROSTERS } from './teams';

const GOLDEN_SEED = 24017;

function golden(): FixtureBundle {
  return generateMatchFixture({ seed: GOLDEN_SEED });
}

const ROLE_CAP = new Map(
  [...ROSTERS.home, ...ROSTERS.away].map((p) => [p.entityId, p.maxSpeedMps] as const),
);

describe('determinism (KYN-03 acceptance)', () => {
  it(
    'produces byte-identical canonical output for identical seed + version',
    { timeout: 20_000 },
    () => {
      const a = generateMatchFixture({ seed: GOLDEN_SEED });
      const b = generateMatchFixture({ seed: GOLDEN_SEED });
      expect(canonicalJsonStringify(a.events)).toBe(canonicalJsonStringify(b.events));
      expect(canonicalJsonStringify(a.tracking)).toBe(canonicalJsonStringify(b.tracking));
      expect(canonicalJsonStringify(a.metadata)).toBe(canonicalJsonStringify(b.metadata));
    },
  );

  it('produces different but valid scenarios for different seeds', { timeout: 20_000 }, () => {
    const a = generateMatchFixture({ seed: GOLDEN_SEED });
    const b = generateMatchFixture({ seed: 4242 });
    expect(canonicalJsonStringify(a.tracking)).not.toBe(canonicalJsonStringify(b.tracking));
    // Different background jitter, identical golden narrative beats.
    expect(b.events.filter((e) => e.kind === 'goal')).toHaveLength(2);
    expect(b.metadata.golden.decoyRun.separationDeltaM).toBeGreaterThan(2);
    // Golden beats themselves stay fixed (the scenario is scripted):
    expect(a.events.map((e) => e.eventId)).toEqual(b.events.map((e) => e.eventId));
  });

  it('rejects invalid sampling options loudly', () => {
    expect(() => generateMatchFixture({ seed: 1, goldenHz: 3 })).toThrow(RangeError);
    expect(() => generateMatchFixture({ seed: 1, backgroundHz: 10, goldenHz: 5 })).toThrow(
      RangeError,
    );
  });

  it('rejects sampling rates above the 10 Hz integration tick (review fix 1)', () => {
    // 20 Hz would emit two samples per 100 ms tick: repeated identical poses
    // and frame ids rounded to duplicates — false spatial resolution.
    for (const goldenHz of [20, 25, 40, 100]) {
      let error: RangeError | null = null;
      try {
        generateMatchFixture({ seed: 1, goldenHz });
      } catch (e) {
        error = e as RangeError;
      }
      expect(error, `goldenHz ${goldenHz}`).toBeInstanceOf(RangeError);
      expect(error!.message).toContain('integration tick');
      expect(error!.message).toContain('10');
    }
  });

  it('still accepts rates up to the tick; default output unchanged', { timeout: 20_000 }, () => {
    const atTick = generateMatchFixture({ seed: 24017, goldenHz: 10 });
    const defaults = generateMatchFixture({ seed: 24017 });
    expect(canonicalJsonStringify(atTick.tracking)).toBe(canonicalJsonStringify(defaults.tracking));
    expect(atTick.tracking).toHaveLength(5129);
  });

  it('rejects invalid seeds loudly', () => {
    expect(() => generateMatchFixture({ seed: -1 })).toThrow(RangeError);
    expect(() => generateMatchFixture({ seed: Number.NaN })).toThrow(RangeError);
  });
});

describe('contract compliance of emitted data', () => {
  const bundle = golden();

  it('every event envelope parses against the canonical MatchEvent contract', () => {
    expect(bundle.events.length).toBeGreaterThanOrEqual(10);
    for (const event of bundle.events) {
      const result = parseMatchEvent(event);
      expect(result.ok, event.eventId).toBe(true);
    }
  });

  it('every tracking sample parses against the canonical TrackingSample contract', () => {
    for (const sample of bundle.tracking) {
      const result = parseTrackingSample(sample);
      expect(result.ok, `${sample.entityId}@${sample.sampleTimeMs}`).toBe(true);
    }
  });

  it('frame ids follow frame-<sampleTimeMs/100> and metadata counts match', () => {
    const frames = new Map<number, Set<string>>();
    for (const sample of bundle.tracking) {
      expect(sample.sourceFrameId).toBe(`frame-${sample.sampleTimeMs / 100}`);
      const frame = frames.get(sample.sampleTimeMs) ?? new Set<string>();
      frame.add(sample.entityId);
      frames.set(sample.sampleTimeMs, frame);
    }
    expect(frames.size).toBe(bundle.metadata.sampling.frameCount);
    expect(bundle.tracking.length).toBe(bundle.metadata.sampling.sampleCount);
    expect(bundle.events.length).toBe(bundle.metadata.eventCount);
    for (const entities of frames.values()) {
      expect(entities.has('ball')).toBe(true);
    }
  });

  it('golden-window frames are complete (22 players + ball = 23 entities)', () => {
    const [start, end] = bundle.metadata.sampling.goldenWindowMs;
    for (let t = start; t <= end; t += 100) {
      const frame = bundle.tracking.filter((s) => s.sampleTimeMs === t);
      expect(frame.length, `frame ${t}`).toBe(23);
    }
  });

  it('has exactly 22 unique on-pitch player identities inside the golden window', () => {
    const players = new Set<string>();
    for (const s of bundle.tracking) {
      if (s.entityId === 'ball') continue;
      if (s.sampleTimeMs < 4717000 || s.sampleTimeMs > 4731000) continue;
      players.add(s.entityId);
    }
    expect(players.size).toBe(22);
    const expected = new Set([...ROSTERS.home, ...ROSTERS.away].map((p) => p.entityId));
    expect(players).toEqual(expected);
  });

  it('every event time has an exact tracking frame (time alignment)', () => {
    const frameTimes = new Set(bundle.tracking.map((s) => s.sampleTimeMs));
    for (const event of bundle.events) {
      // The full-time event deliberately has no frames (documented absence).
      if (event.attributes?.['period'] === 'full_time') continue;
      expect(frameTimes.has(event.occurredAtMs), `${event.eventId}@${event.occurredAtMs}`).toBe(
        true,
      );
    }
  });

  it('sequence numbers are dense and ordered by event time', () => {
    expect(bundle.events.map((e) => e.sequence)).toEqual(
      Array.from({ length: bundle.events.length }, (_, i) => i + 1),
    );
    for (let i = 1; i < bundle.events.length; i++) {
      expect(bundle.events[i]!.occurredAtMs).toBeGreaterThanOrEqual(
        bundle.events[i - 1]!.occurredAtMs,
      );
    }
  });
});

describe('movement envelopes and continuity', () => {
  const bundle = golden();

  it('player speeds stay within role caps; no teleportation', () => {
    const byEntity = new Map<string, TrackingSample[]>();
    for (const s of bundle.tracking) {
      if (s.entityId === 'ball') continue;
      const list = byEntity.get(s.entityId) ?? [];
      list.push(s);
      byEntity.set(s.entityId, list);
    }
    for (const [entityId, samples] of byEntity) {
      const cap = ROLE_CAP.get(entityId)!;
      for (let i = 1; i < samples.length; i++) {
        const a = samples[i - 1]!;
        const b = samples[i]!;
        const dtS = (b.sampleTimeMs - a.sampleTimeMs) / 1000;
        const v = Math.hypot(b.xM - a.xM, b.yM - a.yM) / dtS;
        // Sampled speed can slightly exceed instantaneous cap between frames.
        expect(v, `${entityId} ${v.toFixed(2)} m/s`).toBeLessThanOrEqual(cap * 1.12);
      }
    }
  });

  it('ball never teleports: speed bounded by the shot/pass envelope', () => {
    const ball = bundle.tracking.filter((s) => s.entityId === 'ball');
    for (let i = 1; i < ball.length; i++) {
      const a = ball[i - 1]!;
      const b = ball[i]!;
      const dtS = (b.sampleTimeMs - a.sampleTimeMs) / 1000;
      const v = Math.hypot(b.xM - a.xM, b.yM - a.yM) / dtS;
      expect(v, `ball at ${b.sampleTimeMs}: ${v.toFixed(1)} m/s`).toBeLessThanOrEqual(
        MOVEMENT_ENVELOPE.maxShotSpeedMps + 1,
      );
    }
  });

  it('all positions stay within pitch bounds + margin', () => {
    for (const s of bundle.tracking) {
      expect(Math.abs(s.xM), `x ${s.xM}`).toBeLessThanOrEqual(52.5 + 2.01);
      expect(Math.abs(s.yM), `y ${s.yM}`).toBeLessThanOrEqual(34 + 2.01);
      expect(s.zM).toBeGreaterThanOrEqual(0);
      expect(s.zM).toBeLessThanOrEqual(3);
    }
  });
});

describe('scoring and timeline invariants', () => {
  const bundle = golden();

  it('score changes exactly at goal events, matching attributes and timeline', () => {
    const goals = bundle.events.filter((e) => e.kind === 'goal');
    expect(goals).toHaveLength(2);
    const [awayGoal, homeGoal] = goals;
    expect(awayGoal!.teamId).toBe('away');
    expect(awayGoal!.attributes?.['score_after']).toBe('0-1');
    expect(homeGoal!.teamId).toBe('home');
    expect(homeGoal!.attributes?.['score_after']).toBe('1-1');
    expect(homeGoal!.occurredAtMs).toBe(bundle.metadata.golden.shot.goalMs);
    const timeline = bundle.metadata.scoreTimeline;
    expect(timeline.map((t) => t.score)).toEqual(['0-0', '0-1', '1-1']);
    expect(timeline[1]!.atMs).toBe(awayGoal!.occurredAtMs);
    expect(timeline[2]!.atMs).toBe(homeGoal!.occurredAtMs);
  });

  it('the golden checkpoint frame is complete and inside the window', () => {
    const checkpoint = bundle.tracking.filter(
      (s) => s.sampleTimeMs === bundle.metadata.goldenCheckpointMs,
    );
    expect(checkpoint).toHaveLength(23);
    expect(bundle.metadata.goldenCheckpointMs).toBe(4722100);
    expect(checkpoint[0]!.sourceFrameId).toBe('frame-47221');
  });
});
