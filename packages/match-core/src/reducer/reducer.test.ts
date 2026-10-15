import { describe, expect, it } from 'vitest';
import { canonicalJsonStringify, type MatchEvent } from '@kyneloom/contracts';
import { generateMatchFixture } from '../simulator/simulate';
import { duplicateEvents, lateCorrection, reorderEvents } from '../simulator/variants';
import { ingestMatchStream } from './ingest';
import { projectMatch, type ProjectedMatch } from './projection';
import { fnv1aHex } from './metric-separation';

/**
 * KYN-04 reducer semantics against the real generated golden stream plus
 * the committed fault-injection variants.
 */

const GOLDEN = generateMatchFixture({ seed: 24017 });
const MATCH = GOLDEN.metadata.matchId;

function projected(
  events: readonly unknown[] = GOLDEN.events,
  tracking: readonly unknown[] = GOLDEN.tracking,
) {
  return projectMatch({ matchId: MATCH, events, tracking });
}

function stateFingerprint(match: ProjectedMatch, t: number, revision?: number): string {
  return fnv1aHex(canonicalJsonStringify(match.matchStateAt(t, revision)));
}

describe('determinism and delivery-order independence', () => {
  it('same accepted input ⇒ identical serialized projection and checksum', () => {
    const a = projected();
    const b = projected();
    expect(canonicalJsonStringify(a.matchStateAt(4722100))).toBe(
      canonicalJsonStringify(b.matchStateAt(4722100)),
    );
    expect(stateFingerprint(a, 4722100)).toBe(stateFingerprint(b, 4722100));
  });

  it('a fixed time/revision query returns a fixed result', () => {
    const m = projected();
    for (let i = 0; i < 3; i++) {
      expect(stateFingerprint(m, 4722100, 7)).toBe(stateFingerprint(m, 4722100, 7));
    }
  });

  it('duplicate delivery does not double-count goals or passes', () => {
    const withDupes = duplicateEvents(GOLDEN.events, 7, 0.4);
    const plain = projected();
    const duped = projected(withDupes.events);
    expect(duped.acceptedEvents).toHaveLength(plain.acceptedEvents.length);
    expect(duped.duplicateCount).toBeGreaterThan(0);
    expect(canonicalJsonStringify(duped.matchStateAt(4728300))).toBe(
      canonicalJsonStringify(plain.matchStateAt(4728300)),
    );
  });

  it('shuffled delivery produces the same final projection as canonical order', () => {
    const plain = projected();
    const shuffled = projected(reorderEvents(GOLDEN.events, 11).events);
    expect(shuffled.acceptedEvents.map((e) => e.eventId)).toEqual(
      plain.acceptedEvents.map((e) => e.eventId),
    );
    expect(canonicalJsonStringify(shuffled.matchStateAt(4731000))).toBe(
      canonicalJsonStringify(plain.matchStateAt(4731000)),
    );
  });
});

describe('score derivation and corrections', () => {
  it('score is derived from accepted goal events, not metadata', () => {
    const m = projected();
    expect(m.matchStateAt(2095399).score).toEqual({ home: 0, away: 0 });
    expect(m.matchStateAt(2095400).score).toEqual({ home: 0, away: 1 });
    expect(m.matchStateAt(4728299).score).toEqual({ home: 0, away: 1 });
    expect(m.matchStateAt(4728300).score).toEqual({ home: 1, away: 1 });
  });

  it('goal rescission recomputes the score and keeps history inspectable', () => {
    const corrected = lateCorrection(GOLDEN.events, { asNoGoal: true });
    const m = projected(corrected.events);
    expect(m.matchStateAt(4728300).score).toEqual({ home: 0, away: 1 });
    // The original goal envelope stays in the ALL-REVISION history, superseded:
    const supersededGoal = m
      .eventHistory()
      .find((e) => e.kind === 'goal' && e.eventId === 'evt-0010');
    expect(supersededGoal).toBeDefined();
    expect(supersededGoal!.sourceRevision).toBe(1);
    expect(
      m.acceptedEvents.some((e) => e.kind === 'offside_called' && e.correctionOf === 'evt-0010'),
    ).toBe(true);
    expect(m.acceptedEvents.some((e) => e.kind === 'goal' && e.eventId === 'evt-0010')).toBe(false);
  });

  it('a pass correction supersedes rather than duplicates', () => {
    const corrected = lateCorrection(GOLDEN.events);
    const m = projected(corrected.events);
    const passEvents = m.acceptedEvents.filter((e) => e.eventId === 'evt-0042');
    expect(passEvents).toHaveLength(1);
    expect(passEvents[0]!.sourceRevision).toBe(2);
    expect(passEvents[0]!.correctionOf).toBe('evt-0042'); // self-reference = revision bump, not a cycle
  });

  it('revision checkpoints are immutable: state at revision N never changes with later input', () => {
    const m = projected();
    const beforeCorrection = m.matchStateAt(4728300, 9); // before the goal event is consumed
    expect(beforeCorrection.score).toEqual({ home: 0, away: 1 });
    expect(beforeCorrection.reducerRevision).toBe(9);
  });
});

describe('quarantine behaviors', () => {
  it('rejects malformed envelopes without corrupting state', () => {
    const m = projected([
      ...GOLDEN.events,
      { garbage: true },
      { ...GOLDEN.events[0]!, occurredAtMs: Number.NaN },
    ]);
    const malformed = m.quarantine.filter((q) => q.reason === 'malformed');
    expect(malformed).toHaveLength(2);
    expect(m.acceptedEvents).toHaveLength(GOLDEN.events.length);
  });

  it('quarantines cross-match contamination in events and tracking', () => {
    const strangerEvent = { ...GOLDEN.events[0]!, matchId: 'another-match' };
    const strangerSample = { ...GOLDEN.tracking[0]!, matchId: 'another-match' };
    const m = projected([strangerEvent], [strangerSample]);
    expect(m.acceptedEvents).toHaveLength(0);
    expect(m.acceptedTracking).toHaveLength(0);
    expect(m.quarantine.filter((q) => q.reason === 'match-mismatch')).toHaveLength(2);
  });

  it('quarantines conflicting duplicate payloads with identical identity/revision', () => {
    const original = GOLDEN.events.find((e) => e.kind === 'goal' && e.teamId === 'home')!;
    const conflicting: MatchEvent = { ...original, position: { xM: 1, yM: 2 } };
    const m = projected([...GOLDEN.events, conflicting]);
    expect(m.quarantine.some((q) => q.reason === 'duplicate-conflict')).toBe(true);
    // Deterministic canonical tie-break, independent of arrival order.
    const reversed = projected([conflicting, ...GOLDEN.events]);
    expect(canonicalJsonStringify(reversed.matchStateAt(4731000))).toBe(
      canonicalJsonStringify(m.matchStateAt(4731000)),
    );
  });

  it('quarantines unknown correction targets and invalid revision ordering', () => {
    const unknownTarget = {
      ...GOLDEN.events[0]!,
      correctionOf: 'evt-does-not-exist',
      sourceRevision: 2,
    };
    const forwardChain = {
      ...GOLDEN.events[0]!,
      eventId: 'evt-chain-1',
      correctionOf: 'evt-0042',
      sourceRevision: 1,
    };
    // unknownTarget supersedes events[0] (same identity, higher revision) and
    // is itself quarantined — so the kickoff is superseded by a rejected
    // envelope. Verified behavior: the kickoff is GONE from accepted state
    // (a superseded revision is not resurrected), quarantine records why.
    const m = projected([...GOLDEN.events, unknownTarget, forwardChain], GOLDEN.tracking);
    expect(m.quarantine.some((q) => q.reason === 'unknown-correction-target')).toBe(true);
    expect(m.quarantine.some((q) => q.reason === 'invalid-revision')).toBe(true);
    expect(m.acceptedEvents).toHaveLength(GOLDEN.events.length - 1);
    expect(m.acceptedEvents.some((e) => e.eventId === unknownTarget.eventId)).toBe(false);
  });

  it('rejects tracking duplicates with conflicting payloads — never a verified spatial fact', () => {
    const forged = { ...GOLDEN.tracking[0]!, xM: 88 };
    const m = projected(GOLDEN.events, [...GOLDEN.tracking, forged]);
    expect(m.quarantine.some((q) => q.reason === 'tracking-duplicate-conflict')).toBe(true);
    const time = GOLDEN.tracking[0]!.sampleTimeMs;
    const entityId = GOLDEN.tracking[0]!.entityId;
    const frame = m.timeline.sampleAt(time);
    expect(frame.entities.some((e) => e.entityId === entityId)).toBe(false);
    expect(frame.missingEntityIds).toContain(entityId);
  });

  it('lateness window: within-window delay accepted, beyond-window quarantined', () => {
    const watermark = Math.max(...GOLDEN.events.map((e) => e.occurredAtMs)); // 5,400,000
    const withinWindow: MatchEvent = {
      ...GOLDEN.events[0]!,
      eventId: 'evt-delayed-ok',
      kind: 'foul_committed',
      actorId: 'away-07',
      teamId: 'away',
      occurredAtMs: watermark - 5_000, // 5 s behind the sequence watermark
      sequence: 900,
    };
    const beyond: MatchEvent = {
      ...withinWindow,
      eventId: 'evt-delayed-bad',
      occurredAtMs: 4722100, // 678 s behind the sequence watermark
    };
    // The golden stream itself is sequence-ordered: nothing is late.
    expect(projected().quarantine.filter((q) => q.reason === 'late')).toHaveLength(0);

    const m = projectMatch(
      {
        matchId: MATCH,
        events: [...GOLDEN.events, withinWindow, beyond],
        tracking: GOLDEN.tracking,
      },
      { latenessWindowMs: 30_000 },
    );
    expect(m.acceptedEvents.some((e) => e.eventId === 'evt-delayed-ok')).toBe(true);
    expect(m.quarantine.filter((q) => q.reason === 'late').map((q) => q.index)).toEqual([
      GOLDEN.events.length + 1,
    ]);
  });
});

describe('ingest edge cases', () => {
  it('exact duplicate envelopes are counted, not re-applied', () => {
    const ingested = ingestMatchStream({
      matchId: MATCH,
      events: [...GOLDEN.events, GOLDEN.events[3]!],
      tracking: [...GOLDEN.tracking, GOLDEN.tracking[5]!],
    });
    expect(ingested.acceptedEvents).toHaveLength(GOLDEN.events.length);
    expect(ingested.duplicateCount).toBe(2);
  });
});
