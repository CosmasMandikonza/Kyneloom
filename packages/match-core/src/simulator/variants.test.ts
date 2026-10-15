import { describe, expect, it } from 'vitest';
import {
  canonicalJsonStringify,
  parseMatchEvent,
  parseTrackingSample,
  type MatchEvent,
} from '@kyneloom/contracts';
import { generateMatchFixture } from './simulate';
import {
  ambiguousIdentities,
  duplicateEvents,
  dropFrames,
  lateCorrection,
  reorderEvents,
} from './variants';

/**
 * Fault-injection variants are reducer test INPUTS (KYN-04), generated
 * deterministically. Each variant must keep every envelope contract-valid
 * while exhibiting the delivery fault it names.
 */

const bundle = generateMatchFixture({ seed: 24017 });

describe('duplicate-events variant', () => {
  it('keeps every envelope valid and preserves the multiset', () => {
    const { events, report } = duplicateEvents(bundle.events, 7);
    expect(report.kind).toBe('duplicate-events');
    expect((report.detail as { duplicated: number }).duplicated).toBeGreaterThan(0);
    for (const event of events) {
      expect(parseMatchEvent(event).ok).toBe(true);
    }
    // Removing consecutive duplicates must restore the original stream.
    const deduped: string[] = [];
    for (const event of events) {
      const canonical = canonicalJsonStringify(event);
      if (deduped[deduped.length - 1] !== canonical) deduped.push(canonical);
    }
    expect(deduped.join('\n')).toBe(bundle.events.map((e) => canonicalJsonStringify(e)).join('\n'));
    expect(events.length).toBeGreaterThan(bundle.events.length);
  });
});

describe('out-of-order-delivery variant', () => {
  it('shuffles arrival order without altering envelope contents', () => {
    const { events, report } = reorderEvents(bundle.events, 11);
    expect((report.detail as { inversions: number }).inversions).toBeGreaterThan(0);
    const canonical = (list: readonly MatchEvent[]) =>
      list
        .map((e) => canonicalJsonStringify(e))
        .sort()
        .join('\n');
    expect(canonical(events)).toBe(canonical(bundle.events));
    // Event times are no longer monotone in delivery order.
    const monotone = events.every(
      (e, i) => i === 0 || e.occurredAtMs >= events[i - 1]!.occurredAtMs,
    );
    expect(monotone).toBe(false);
  });

  it('is deterministic per seed', () => {
    const a = reorderEvents(bundle.events, 11).events;
    const b = reorderEvents(bundle.events, 11).events;
    expect(a.map((e) => e.eventId)).toEqual(b.map((e) => e.eventId));
  });
});

describe('late-correction variant', () => {
  it('corrects the golden pass with a meaningful revision reference', () => {
    const { events } = lateCorrection(bundle.events);
    const correction = events[events.length - 1]!;
    const original = bundle.events.find((e) => e.eventId === 'evt-0042')!;
    expect(correction.correctionOf).toBe('evt-0042');
    expect(correction.sourceRevision).toBe(original.sourceRevision + 1);
    expect(correction.kind).toBe('pass_completed');
    expect(correction.position!.xM).toBeCloseTo(original.position!.xM + 0.5, 3);
    expect(parseMatchEvent(correction).ok).toBe(true);
    // The superseded envelope remains in the stream untouched.
    expect(events.some((e) => e.eventId === 'evt-0042' && e.sourceRevision === 1)).toBe(true);
  });

  it('can rescind the goal as a no-goal correction (score-impacting)', () => {
    const { events } = lateCorrection(bundle.events, { asNoGoal: true });
    const rescission = events[events.length - 1]!;
    const goal = bundle.events.find((e) => e.kind === 'goal' && e.teamId === 'home')!;
    expect(rescission.correctionOf).toBe(goal.eventId);
    expect(rescission.kind).toBe('offside_called');
    expect(rescission.attributes?.['corrected_outcome']).toBe('no_goal');
    expect(parseMatchEvent(rescission).ok).toBe(true);
  });
});

describe('dropped-frames variant (disconnect)', () => {
  it('removes whole frames; gaps stay explicit and nothing is fabricated', () => {
    const { tracking, report } = dropFrames(bundle.tracking, 13, 0.08);
    expect((report.detail as { droppedFrames: number }).droppedFrames).toBeGreaterThan(0);
    for (const sample of tracking) {
      expect(parseTrackingSample(sample).ok).toBe(true);
    }
    // Dropped frames disappear entirely (all entities), never partially.
    const framesBefore = new Set(bundle.tracking.map((s) => s.sampleTimeMs));
    const framesAfter = new Set(tracking.map((s) => s.sampleTimeMs));
    for (const t of framesAfter) expect(framesBefore.has(t)).toBe(true);
    const countsPerFrame = new Map<number, number>();
    for (const s of tracking)
      countsPerFrame.set(s.sampleTimeMs, (countsPerFrame.get(s.sampleTimeMs) ?? 0) + 1);
    for (const count of countsPerFrame.values()) expect(count).toBe(23);
  });
});

describe('ambiguous-identity variant', () => {
  it('swaps two players inside a window and stays contract-valid', () => {
    const { tracking } = ambiguousIdentities(bundle.tracking, {
      a: 'home-09',
      b: 'away-03',
      fromMs: 4720500,
      toMs: 4724000,
    });
    for (const sample of tracking) {
      expect(parseTrackingSample(sample).ok).toBe(true);
    }
    const swappedAt = tracking.find((s) => s.sampleTimeMs === 4722000 && s.entityId === 'home-09')!;
    const original = bundle.tracking.find(
      (s) => s.sampleTimeMs === 4722000 && s.entityId === 'away-03',
    )!;
    expect(swappedAt.xM).toBeCloseTo(original.xM, 3);
  });

  it('is physically detectable: the swapped track violates the speed envelope', () => {
    const { tracking } = ambiguousIdentities(bundle.tracking, {
      a: 'home-09',
      b: 'away-03',
      fromMs: 4720500,
      toMs: 4724000,
    });
    const homeTrack = tracking
      .filter((s) => s.entityId === 'home-09')
      .sort((a, b) => a.sampleTimeMs - b.sampleTimeMs);
    let maxV = 0;
    for (let i = 1; i < homeTrack.length; i++) {
      const dt = (homeTrack[i]!.sampleTimeMs - homeTrack[i - 1]!.sampleTimeMs) / 1000;
      const v =
        Math.hypot(
          homeTrack[i]!.xM - homeTrack[i - 1]!.xM,
          homeTrack[i]!.yM - homeTrack[i - 1]!.yM,
        ) / dt;
      maxV = Math.max(maxV, v);
    }
    // Crossing between two distant players mid-window spikes the speed.
    expect(maxV).toBeGreaterThan(9);
  });
});

describe('own-goal actor/team semantics (documented convention)', () => {
  it('an own goal keeps actor = scorer-into-own-net, teamId = benefiting team', () => {
    const ownGoal = {
      ...bundle.events.find((e) => e.kind === 'goal')!,
      eventId: 'evt-own-1',
      kind: 'own_goal' as const,
      actorId: 'home-04',
      teamId: 'away' as const,
      attributes: { benefiting_team: 'away', score_after: '0-2' },
      sequence: 999,
    };
    const parsed = parseMatchEvent(ownGoal);
    expect(parsed.ok).toBe(true);
  });
});
